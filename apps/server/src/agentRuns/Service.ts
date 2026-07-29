/**
 * AgentRunsService - T3Code's read-only window onto an external orchestrator.
 *
 * The dependency runs one way. T3Code observes; the orchestrator executes. It
 * runs detached, so closing this app, restarting the server, or losing the
 * network changes nothing about a run in flight — reopening simply rebuilds
 * the picture from the same durable evidence that was there all along.
 *
 * Consequently this service:
 *
 *   - **never writes** into the orchestrator home, a worktree, or a run;
 *   - **never spawns an agent**, and the only process it starts at all is a
 *     throttled read-only `git status` inside a run's own worktree;
 *   - **never reads a path a caller supplied**. Run ids are matched against a
 *     strict pattern before they become path segments, and every constructed
 *     path is re-checked against the home's real path, so `..`, an absolute
 *     path, and a symlink pointing out of the home all fail the same way.
 *
 * @module AgentRunsService
 */
import {
  type AgentRunDetail,
  type AgentRunSummary,
  type AgentRunValidationStage,
  AGENT_RUN_VALIDATION_STAGES,
  AgentRunsNotConfiguredError,
  AgentRunsNotFoundError,
  AgentRunsReadError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as NodeOS from "node:os";

import * as ServerConfig from "../config.ts";
import { loadLocalConfig, readConfiguredPath } from "../localConfig.ts";
import * as ProcessRunner from "../processRunner.ts";

import {
  ATTEMPTS_DIR,
  ATTEMPT_JOURNAL_FILE,
  EVENTS_FILE,
  ORCHESTRATOR_LOCKS_DIR,
  ORCHESTRATOR_RUNS_DIR,
  OrchestratorEvent,
  OrchestratorJournalEntry,
  OrchestratorLockRecord,
  OrchestratorRunRecord,
  OrchestratorValidationReport,
  OrchestratorWorkOrder,
  RUN_FILE,
  SUPPORTED_RUN_SCHEMA_VERSION,
  WORK_ORDER_FILE,
  cycleDirName,
  isAttemptId,
  isRunId,
  isValidationArtifactFor,
} from "./Artifacts.ts";
import {
  type AttemptEvidence,
  type LivenessEvidence,
  type RunEvidence,
  type ValidationEvidence,
  parseRunState,
  projectDetail,
  projectSummary,
} from "./Projection.ts";

/* ------------------------------------------------------------------ config */

/**
 * Where the orchestrator keeps its home.
 *
 * Never a setting: this names another tool's private state directory on this
 * machine, and `settings.json` is writable by any authorized client, including
 * a browser on a phone across Tailscale. Both sources below are local to the
 * machine running the server, and neither is reachable through an RPC.
 */
export const ORCHESTRATOR_HOME_ENV = "T3_ORCHESTRATOR_HOME";

export function resolveOrchestratorHomeFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  return readConfiguredPath(env[ORCHESTRATOR_HOME_ENV]);
}

/**
 * The configured home, in precedence order.
 *
 * The environment variable wins when explicitly present, so a developer can
 * aim one shell at a different home without editing the installed app's
 * config. It is not available to an app launched from Finder, which inherits
 * the launch services environment rather than a login shell — hence the file,
 * which is what makes the packaged app work at all. Neither present means the
 * integration is simply off.
 */
export const resolveOrchestratorHome = Effect.fn("agentRuns.resolveHome")(function* (
  localConfigPath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const fromEnv = resolveOrchestratorHomeFromEnv(env);
  if (fromEnv !== null) return { home: fromEnv, source: "env" as const };

  const local = yield* loadLocalConfig(localConfigPath);
  const fromFile = readConfiguredPath(local.orchestratorHome);
  return fromFile === null
    ? { home: null, source: "none" as const }
    : { home: fromFile, source: "local-config" as const };
});

/** How long a workspace `git status` probe is reused before being re-run. */
export const WORKSPACE_PROBE_TTL_MS = 15_000;

/* ------------------------------------------------------------------ types */

export class AgentRunsService extends Context.Service<
  AgentRunsService,
  {
    readonly isConfigured: Effect.Effect<boolean>;
    readonly home: Effect.Effect<string | null>;
    readonly list: Effect.Effect<
      {
        readonly runs: readonly AgentRunSummary[];
        readonly unreadable: readonly { readonly id: string; readonly reason: string }[];
      },
      AgentRunsNotConfiguredError | AgentRunsReadError
    >;
    readonly get: (
      runId: string,
    ) => Effect.Effect<
      AgentRunDetail,
      AgentRunsNotConfiguredError | AgentRunsNotFoundError | AgentRunsReadError
    >;
  }
>()("t3/agentRuns/Service/AgentRunsService") {}

/* -------------------------------------------------------------- liveness */

/**
 * A per-boot identifier, matching the orchestrator's own derivation.
 *
 * Needed so a pid recycled after a reboot is not mistaken for the original
 * holder. Both sides round to the minute independently, so a one-unit
 * disagreement is arithmetic, not a different boot — a real reboot moves this
 * value by however long the machine had been up.
 */
export function currentBootId(nowMs: number, uptimeSeconds = NodeOS.uptime()): string {
  return `boot-${Math.round((nowMs - Math.round(uptimeSeconds) * 1000) / 60_000)}`;
}

function bootIdsAgree(left: string, right: string): boolean {
  if (left === right) return true;
  const leftValue = Number.parseInt(left.replace("boot-", ""), 10);
  const rightValue = Number.parseInt(right.replace("boot-", ""), 10);
  if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) return false;
  return Math.abs(leftValue - rightValue) <= 1;
}

export interface LivenessProbe {
  readonly hostname: string;
  readonly bootId: string;
  readonly isAlive: (pid: number) => boolean;
}

export const systemLivenessProbe = (nowMs: number): LivenessProbe => ({
  hostname: NodeOS.hostname(),
  bootId: currentBootId(nowMs),
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // ESRCH is the only proof of absence. EPERM means the process exists and
      // belongs to somebody else, which is still alive.
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  },
});

/**
 * What the probe can honestly conclude about a lock's owner.
 *
 * Off-host and cross-boot both resolve to `alive: null`. A pid on another
 * machine is a number, not a process, and reporting it as dead would turn an
 * unknown into a false alarm.
 */
export function evaluateLiveness(
  lock: OrchestratorLockRecord | null,
  probe: LivenessProbe,
): LivenessEvidence {
  if (lock === null) return { sameHost: false, alive: null, detached: null };
  const sameHost = lock.hostname === probe.hostname;
  const detached = lock.processGroupId === undefined ? null : lock.processGroupId === lock.pid;
  if (!sameHost || !bootIdsAgree(lock.bootId, probe.bootId)) {
    return { sameHost, alive: null, detached };
  }
  return { sameHost, alive: probe.isAlive(lock.pid), detached };
}

/* ------------------------------------------------------------ containment */

/**
 * Assert a constructed path stays inside the orchestrator home.
 *
 * Belt and braces on top of the id patterns: the ids can no longer express an
 * escape, and this catches the case they cannot — a symlink inside the home
 * pointing somewhere else entirely.
 */
export function assertInsideHome(realHome: string, candidate: string, separator = "/"): boolean {
  return candidate === realHome || candidate.startsWith(realHome + separator);
}

/* ----------------------------------------------------------------- decode */

/**
 * JSON decoders built straight from the artifact schemas.
 *
 * `fromJsonString` keeps parsing and validation in one step, so a truncated
 * file and a file with the wrong shape fail identically — as they should, since
 * both mean "this evidence cannot be trusted".
 */
const decodeRun = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestratorRunRecord));
const decodeWorkOrder = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestratorWorkOrder));
const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestratorEvent));
const decodeJournalEntry = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestratorJournalEntry),
);
const decodeValidation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestratorValidationReport),
);
const decodeLock = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestratorLockRecord));

/** A decoder over one JSON document, failing only with a schema error. */
type ArtifactDecoder<A> = (input: string) => Effect.Effect<A, Schema.SchemaError>;

/** Why a run could not be read. Distinguished from a run that is simply absent. */
interface UnreadableRun {
  readonly unreadable: true;
  readonly reason: string;
  readonly missing: boolean;
}

const unreadable = (reason: string, missing = false): UnreadableRun => ({
  unreadable: true,
  reason,
  missing,
});

/* ------------------------------------------------------------------ make */

export interface MakeOptions {
  readonly home?: string | null;
  readonly probe?: LivenessProbe;
  /** Injected so tests can assert probing behaviour without spawning git. */
  readonly gitStatus?: (worktreePath: string) => Effect.Effect<number | null>;
}

export const make = (options: MakeOptions = {}) =>
  Effect.gen(function* AgentRunsServiceMake() {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const processRunner = yield* ProcessRunner.ProcessRunner;

    const configuredHome = options.home ?? null;
    const probe = options.probe ?? systemLivenessProbe(yield* Clock.currentTimeMillis);
    const gitStatus = options.gitStatus ?? makeGitStatus(processRunner);

    /**
     * The home's real path, resolved once.
     *
     * Everything else is compared against this, so a symlinked home is
     * supported while a symlink *out of* it is not.
     */
    const realHome = yield* Effect.gen(function* () {
      if (configuredHome === null) return null;
      const absolute = path.resolve(configuredHome);
      const resolved = yield* fileSystem
        .realPath(absolute)
        .pipe(Effect.orElseSucceed(() => absolute));
      return resolved;
    });

    const probeCache = yield* Ref.make(
      new Map<string, { readonly at: number; readonly filesChanged: number | null }>(),
    );

    /** Join under the home and refuse anything that leaves it. */
    const homePath = (...segments: readonly string[]): string | null => {
      if (realHome === null) return null;
      const joined = path.resolve(realHome, ...segments);
      return assertInsideHome(realHome, joined, path.sep) ? joined : null;
    };

    /**
     * Read one JSON artifact, or `null`.
     *
     * Missing, unreadable, malformed, and wrong-shaped all collapse to `null`
     * on purpose. The caller decides what each absence means for the operator;
     * down here they are the same fact — there is no trustworthy evidence.
     */
    const readJsonFile = <A>(
      filePath: string,
      decode: ArtifactDecoder<A>,
    ): Effect.Effect<A | null> =>
      fileSystem.readFileString(filePath).pipe(
        Effect.flatMap(decode),
        Effect.catchCause(() => Effect.succeed(null)),
      );

    const readJsonLines = <A>(
      filePath: string,
      decode: ArtifactDecoder<A>,
    ): Effect.Effect<readonly A[]> =>
      fileSystem.readFileString(filePath).pipe(
        Effect.flatMap((raw) =>
          Effect.forEach(
            raw.split("\n").filter((line) => line.trim().length > 0),
            (line) =>
              decode(line).pipe(
                Effect.map(Option.some),
                // One malformed line must not cost the whole file: the rest of
                // the history is still true.
                Effect.catchCause(() => Effect.succeed(Option.none<A>())),
              ),
          ),
        ),
        Effect.map((entries) => entries.filter(Option.isSome).map((entry) => entry.value)),
        Effect.catchCause(() => Effect.succeed([] as readonly A[])),
      );

    const statInfo = (filePath: string) =>
      fileSystem.stat(filePath).pipe(
        Effect.map((info) => ({
          mtime: Option.getOrNull(info.mtime)?.toISOString() ?? null,
          size: Number(info.size),
        })),
        Effect.catchCause(() => Effect.succeed(null)),
      );

    const listDirectory = (dirPath: string) =>
      fileSystem
        .readDirectory(dirPath)
        .pipe(Effect.catchCause(() => Effect.succeed([] as readonly string[])));

    /* ------------------------------------------------------ attempt reads */

    const readAttempts = (
      runId: string,
      cycleNumbers: readonly number[],
    ): Effect.Effect<readonly AttemptEvidence[]> =>
      Effect.forEach(cycleNumbers, (cycleNumber) =>
        Effect.gen(function* () {
          const attemptsDir = homePath(
            ORCHESTRATOR_RUNS_DIR,
            runId,
            cycleDirName(cycleNumber),
            ATTEMPTS_DIR,
          );
          if (attemptsDir === null) return [] as readonly AttemptEvidence[];

          const names = (yield* listDirectory(attemptsDir)).filter(isAttemptId).sort();
          return yield* Effect.forEach(names, (attemptId) =>
            Effect.gen(function* () {
              const attemptDir = path.join(attemptsDir, attemptId);
              const entries = yield* readJsonLines(
                path.join(attemptDir, ATTEMPT_JOURNAL_FILE),
                decodeJournalEntry,
              );

              // Stream files prove an agent is still emitting bytes, which is
              // the only progress evidence available mid-execution. Stat only:
              // the contents are the agent's raw output and never travel.
              const streamNames = (yield* listDirectory(attemptDir)).filter(
                (name) => name.endsWith(".log") || name.endsWith(".jsonl"),
              );
              const stats = yield* Effect.forEach(streamNames, (name) =>
                statInfo(path.join(attemptDir, name)),
              );
              const present = stats.filter((entry) => entry !== null);
              const streamWriteAt = present.reduce<string | null>(
                (best, entry) =>
                  entry.mtime !== null && (best === null || entry.mtime > best)
                    ? entry.mtime
                    : best,
                null,
              );
              const streamBytes =
                present.length === 0
                  ? null
                  : present.reduce((total, entry) => total + entry.size, 0);

              return {
                cycle: cycleNumber,
                attemptId,
                entries,
                streamWriteAt,
                streamBytes,
              } satisfies AttemptEvidence;
            }),
          );
        }),
      ).pipe(Effect.map((groups) => groups.flat()));

    /* --------------------------------------------------- validation reads */

    const readValidation = (
      runId: string,
      cycleNumbers: readonly number[],
    ): Effect.Effect<readonly ValidationEvidence[]> =>
      Effect.forEach(cycleNumbers, (cycleNumber) =>
        Effect.gen(function* () {
          const cycleDir = homePath(ORCHESTRATOR_RUNS_DIR, runId, cycleDirName(cycleNumber));
          if (cycleDir === null) return [] as readonly ValidationEvidence[];

          // Listed, not guessed. The orchestrator names reruns in more than one
          // way, and a fixed candidate list drops the ones it did not predict
          // without ever saying so.
          const names = [...(yield* listDirectory(cycleDir))].sort();
          const found: ValidationEvidence[] = [];

          for (const stage of AGENT_RUN_VALIDATION_STAGES) {
            for (const fileName of names) {
              if (!isValidationArtifactFor(stage, fileName)) continue;
              const filePath = homePath(
                ORCHESTRATOR_RUNS_DIR,
                runId,
                cycleDirName(cycleNumber),
                fileName,
              );
              if (filePath === null) continue;
              const report = yield* readJsonFile(filePath, decodeValidation);
              if (report === null) continue;
              const info = yield* statInfo(filePath);
              found.push({
                cycle: cycleNumber,
                stage: stage as AgentRunValidationStage,
                report,
                writtenAt: info?.mtime ?? null,
                artifact: fileName,
              });
            }
          }
          return found as readonly ValidationEvidence[];
        }),
      ).pipe(Effect.map((groups) => groups.flat()));

    /* --------------------------------------------------------- lock reads */

    const readLock = (runId: string): Effect.Effect<OrchestratorLockRecord | null> =>
      Effect.gen(function* () {
        const locksDir = homePath(ORCHESTRATOR_LOCKS_DIR);
        if (locksDir === null) return null;
        const names = yield* listDirectory(locksDir);
        for (const name of names) {
          const candidate = homePath(ORCHESTRATOR_LOCKS_DIR, name);
          if (candidate === null) continue;
          const lock = yield* readJsonFile(candidate, decodeLock);
          if (lock !== null && lock.runId === runId && lock.kind === "run") return lock;
        }
        return null;
      });

    /* ---------------------------------------------------- workspace probe */

    /**
     * How many files the worker has touched so far.
     *
     * Only asked while a worker is actually running — once a cycle completes
     * the orchestrator has recorded the answer itself, and re-deriving it
     * would be both slower and less authoritative. Throttled, read-only, and
     * confined to worktrees the orchestrator created inside its own home.
     */
    const probeWorkspace = (
      worktreePath: string | null,
    ): Effect.Effect<{ filesChanged: number; at: string } | null> =>
      Effect.gen(function* () {
        if (worktreePath === null || realHome === null) return null;
        // Resolve before containment, not after. A worktree path recorded
        // through a symlinked parent must still be recognised as inside the
        // home, and a symlink pointing *out* of it must still be refused —
        // both need the real path, not the literal one.
        const absolute = path.resolve(worktreePath);
        const resolved = yield* fileSystem
          .realPath(absolute)
          .pipe(Effect.orElseSucceed(() => absolute));
        if (!assertInsideHome(realHome, resolved, path.sep)) return null;

        const timestamp = yield* Clock.currentTimeMillis;
        const cached = (yield* Ref.get(probeCache)).get(resolved);
        if (cached !== undefined && timestamp - cached.at < WORKSPACE_PROBE_TTL_MS) {
          return cached.filesChanged === null
            ? null
            : { filesChanged: cached.filesChanged, at: isoAt(cached.at) };
        }

        const filesChanged = yield* gitStatus(resolved);
        yield* Ref.update(probeCache, (cache) => {
          const next = new Map(cache);
          next.set(resolved, { at: timestamp, filesChanged });
          return next;
        });
        return filesChanged === null ? null : { filesChanged, at: isoAt(timestamp) };
      });

    /* -------------------------------------------------------- run reading */

    const readEvidence = (runId: string): Effect.Effect<RunEvidence | UnreadableRun> =>
      Effect.gen(function* () {
        const runFile = homePath(ORCHESTRATOR_RUNS_DIR, runId, RUN_FILE);
        if (runFile === null) return unreadable("path escapes the orchestrator home");

        const exists = yield* fileSystem
          .exists(runFile)
          .pipe(Effect.catchCause(() => Effect.succeed(false)));
        if (!exists) return unreadable("run.json is missing", true);

        const run = yield* readJsonFile(runFile, decodeRun);
        if (run === null) return unreadable("run.json is unreadable or malformed");
        if (run.schemaVersion > SUPPORTED_RUN_SCHEMA_VERSION) {
          return unreadable(
            `run.json schema version ${run.schemaVersion} is newer than this build understands`,
          );
        }
        if (parseRunState(run.state) === null) {
          return unreadable(`unrecognised run state ${run.state}`);
        }

        const degraded: string[] = [];
        const cycleNumbers = (run.cycles ?? [])
          .map((cycle) => Math.trunc(cycle.number))
          .filter((value) => Number.isInteger(value) && value >= 1);

        const workOrderFile = homePath(ORCHESTRATOR_RUNS_DIR, runId, WORK_ORDER_FILE);
        const workOrder =
          workOrderFile === null ? null : yield* readJsonFile(workOrderFile, decodeWorkOrder);
        if (workOrder === null) degraded.push("work order is unreadable");

        const eventsFile = homePath(ORCHESTRATOR_RUNS_DIR, runId, EVENTS_FILE);
        const events = eventsFile === null ? [] : yield* readJsonLines(eventsFile, decodeEvent);

        const attempts = yield* readAttempts(runId, cycleNumbers);
        const validation = yield* readValidation(runId, cycleNumbers);
        const lock = yield* readLock(runId);
        const liveness = evaluateLiveness(lock, probe);

        const workspaceProbe =
          run.state === "WORKER_RUNNING"
            ? yield* probeWorkspace(run.workspace?.worktreePath ?? null)
            : null;

        return {
          run,
          workOrder,
          events,
          attempts,
          validation,
          lock,
          liveness,
          workspaceProbe,
          degraded,
        } satisfies RunEvidence;
      });

    /* ------------------------------------------------------------ surface */

    const requireHome = Effect.suspend(() =>
      realHome === null ? Effect.fail(new AgentRunsNotConfiguredError()) : Effect.succeed(realHome),
    );

    const list: AgentRunsService["Service"]["list"] = Effect.gen(function* () {
      yield* requireHome;
      const runsDir = homePath(ORCHESTRATOR_RUNS_DIR);
      if (runsDir === null) {
        return yield* new AgentRunsReadError({
          runId: null,
          reason: "runs directory escapes the orchestrator home",
        });
      }

      const ids = (yield* listDirectory(runsDir)).filter(isRunId).sort();
      const results = yield* Effect.forEach(ids, (id) =>
        readEvidence(id).pipe(
          Effect.map((evidence) => ({ id, evidence })),
          // A single broken run is reported, never allowed to blank the list.
          Effect.catchCause(() =>
            Effect.succeed({ id, evidence: unreadable("run artifacts could not be read") }),
          ),
        ),
      );

      const runs: AgentRunSummary[] = [];
      const failures: { id: string; reason: string }[] = [];
      for (const { id, evidence } of results) {
        if ("unreadable" in evidence) {
          failures.push({ id, reason: evidence.reason });
          continue;
        }
        const state = parseRunState(evidence.run.state);
        if (state === null) {
          failures.push({ id, reason: `unrecognised run state ${evidence.run.state}` });
          continue;
        }
        runs.push(projectSummary(evidence, state));
      }

      // Newest first: an operator opening this wants what just happened.
      runs.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return { runs, unreadable: failures };
    });

    const get: AgentRunsService["Service"]["get"] = (runId) =>
      Effect.gen(function* () {
        yield* requireHome;
        if (!isRunId(runId)) return yield* new AgentRunsNotFoundError({ runId });

        const evidence = yield* readEvidence(runId).pipe(
          Effect.catchCause(() => Effect.succeed(unreadable("run artifacts could not be read"))),
        );
        if ("unreadable" in evidence) {
          return yield* evidence.missing
            ? new AgentRunsNotFoundError({ runId })
            : new AgentRunsReadError({ runId, reason: evidence.reason });
        }

        const state = parseRunState(evidence.run.state);
        if (state === null) {
          return yield* new AgentRunsReadError({
            runId,
            reason: `unrecognised run state ${evidence.run.state}`,
          });
        }
        return projectDetail(evidence, state);
      });

    return {
      isConfigured: Effect.sync(() => realHome !== null),
      home: Effect.sync(() => realHome),
      list,
      get,
    } satisfies AgentRunsService["Service"];
  });

/* ------------------------------------------------------------ git status */

/**
 * Count the worker's uncommitted changes.
 *
 * `git status` rather than a filesystem walk precisely because it already
 * honours the repository's ignore rules — `node_modules` and build output
 * never enter the count, and no tree has to be traversed by hand. It writes
 * nothing, and a failure is an absent answer rather than an error: "how many
 * files has it touched" is a nice-to-know, and no part of the operator's
 * picture should collapse because git was busy.
 */
const makeGitStatus =
  (processRunner: ProcessRunner.ProcessRunner["Service"]) =>
  (worktreePath: string): Effect.Effect<number | null> =>
    processRunner
      .run({
        command: "git",
        args: ["status", "--porcelain=v1", "--untracked-files=all"],
        cwd: worktreePath,
        timeout: "5 seconds",
        timeoutBehavior: "timedOutResult",
        outputMode: "truncate",
        maxOutputBytes: 4 * 1024 * 1024,
      })
      .pipe(
        Effect.map((output) =>
          output.timedOut || output.code !== 0
            ? null
            : output.stdout.split("\n").filter((line) => line.trim().length > 0).length,
        ),
        Effect.catchCause(() => Effect.succeed(null)),
      );

function isoAt(millis: number): string {
  return DateTime.formatIso(DateTime.makeUnsafe(millis));
}

/**
 * The live service, configured from this machine only.
 *
 * Resolution happens once, here, rather than inside `make`: it is a startup
 * decision about the install, not a per-request one, and keeping it out of the
 * service body leaves `make` trivially testable with an explicit home.
 */
export const layer = Layer.effect(
  AgentRunsService,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const { home, source } = yield* resolveOrchestratorHome(config.localConfigPath);
    if (home !== null) {
      yield* Effect.logInfo("Observing an agent-orchestrator home.").pipe(
        Effect.annotateLogs({ source, localConfigPath: config.localConfigPath }),
      );
    }
    return yield* make({ home });
  }),
);

export const layerWith = (options: MakeOptions) => Layer.effect(AgentRunsService, make(options));
