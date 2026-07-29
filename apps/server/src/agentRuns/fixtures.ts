/**
 * Orchestrator-home fixtures.
 *
 * Writes the same directory layout a real `agent-orchestrator` writes, so the
 * adapter is exercised against the shape it will actually meet rather than
 * against a mock of our own beliefs about that shape. Test-only; nothing here
 * is imported by the running server.
 *
 * @module AgentRunsFixtures
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** Serialize an arbitrary fixture document the way the orchestrator would. */
const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export interface FixtureExecution {
  readonly role: "worker" | "reviewer";
  readonly agentId?: string;
  readonly attempt?: number;
  readonly attemptId?: string;
  readonly status?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs?: number;
  readonly pid?: number;
  readonly exitCode?: number;
}

export interface FixtureCycle {
  readonly number: number;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly executions?: readonly FixtureExecution[];
  readonly workerSummary?: string;
  readonly changedFiles?: readonly string[];
  readonly review?: {
    readonly verdict: string;
    readonly summary?: string;
    readonly requiredChanges?: readonly string[];
    readonly blockingReason?: string;
    readonly evidence?: readonly string[];
  };
  readonly finalGate?: {
    readonly ranAt: string;
    readonly passed: boolean;
    readonly checksRun?: readonly string[];
    readonly failures?: readonly { id: string; name?: string; tail?: string }[];
  };
}

export interface FixtureRun {
  readonly id: string;
  readonly state: string;
  readonly project?: string;
  readonly workOrderId?: string;
  readonly workOrderTitle?: string;
  readonly maxCycles?: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly finishedAt?: string;
  readonly schemaVersion?: number;
  readonly cycles?: readonly FixtureCycle[];
  readonly outcome?: {
    readonly state: string;
    readonly reason: string;
    readonly message?: string;
    readonly verdict?: string;
    readonly at?: string;
  };
  readonly recovery?: {
    readonly attemptId: string;
    readonly role: string;
    readonly cycle: number;
    readonly detectedAt: string;
    readonly reason: string;
  };
  readonly humanRequired?: {
    readonly reasonCode: string;
    readonly summary: string;
    readonly decisionNeeded: string;
    readonly options?: readonly string[];
    readonly evidenceRefs?: readonly string[];
    readonly createdAt: string;
    readonly source?: string;
  };
  readonly worktreePath?: string;
  readonly events?: readonly {
    readonly seq: number;
    readonly at: string;
    readonly type: string;
    readonly from?: string;
    readonly to?: string;
    readonly cycle?: number;
    readonly detail?: string;
  }[];
  /** Attempt journals, keyed by `cycle` then attempt id. */
  readonly attempts?: readonly {
    readonly cycle: number;
    readonly attemptId: string;
    readonly entries: readonly Record<string, unknown>[];
    readonly stdout?: string;
  }[];
  readonly validation?: readonly {
    readonly cycle: number;
    readonly stage: string;
    /**
     * Artifact suffix, e.g. `rerun-1` or `attempt-2`. Omitted writes the plain
     * `validation.<stage>.json`. The orchestrator uses more than one naming
     * convention for reruns, which is exactly what the reader must tolerate.
     */
    readonly suffix?: string;
    readonly checks: readonly {
      readonly id: string;
      readonly name?: string;
      readonly passed: boolean;
      readonly outcome?: string;
      readonly durationMs?: number;
      readonly startedAt?: string;
      readonly stdout?: string;
      readonly stderr?: string;
    }[];
  }[];
  /** Raw override, for corrupt-file cases. */
  readonly rawRunJson?: string;
}

export interface FixtureLock {
  readonly runId: string;
  readonly pid: number;
  readonly hostname: string;
  readonly bootId: string;
  readonly state: string;
  readonly acquiredAt?: string;
  readonly processGroupId?: number;
}

const T0 = "2026-07-28T18:28:30.000Z";

/**
 * Fill an execution the way the orchestrator persists one.
 *
 * Fixtures state only what a test cares about; everything else is completed
 * here so the artifact on disk is a *valid* record. A fixture that quietly
 * omits required fields would test the adapter's error path while claiming to
 * test its happy one.
 */
function completeExecution(execution: FixtureExecution): Record<string, unknown> {
  const role = execution.role;
  const attempt = execution.attempt ?? 1;
  return {
    role,
    agentId: execution.agentId ?? (role === "worker" ? "claude-code" : "codex"),
    attempt,
    attemptId: execution.attemptId ?? `${role}-${String(attempt).padStart(2, "0")}`,
    pid: execution.pid ?? null,
    signal: null,
    providerSessionId: null,
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt,
    durationMs:
      execution.durationMs ??
      Math.max(0, Date.parse(execution.finishedAt) - Date.parse(execution.startedAt)),
    timeoutMs: 900_000,
    status: execution.status ?? "OK",
    exitCode: execution.exitCode ?? 0,
    artifacts: [],
    issues: [],
  };
}

function completeCycle(cycle: FixtureCycle): Record<string, unknown> {
  return {
    number: cycle.number,
    startedAt: cycle.startedAt,
    ...(cycle.finishedAt === undefined ? {} : { finishedAt: cycle.finishedAt }),
    executions: (cycle.executions ?? []).map(completeExecution),
    ...(cycle.workerSummary === undefined ? {} : { workerSummary: cycle.workerSummary }),
    ...(cycle.changedFiles === undefined ? {} : { changedFiles: cycle.changedFiles }),
    ...(cycle.review === undefined ? {} : { review: cycle.review }),
    ...(cycle.finalGate === undefined ? {} : { finalGate: cycle.finalGate }),
  };
}

export const writeOrchestratorHome = Effect.fn("agentRuns.fixtures.writeHome")(function* (
  home: string,
  runs: readonly FixtureRun[],
  locks: readonly FixtureLock[] = [],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const write = (filePath: string, contents: string) =>
    Effect.gen(function* () {
      yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fileSystem.writeFileString(filePath, contents);
    }).pipe(Effect.orDie);

  for (const run of runs) {
    const runDir = path.join(home, "runs", run.id);

    if (run.rawRunJson !== undefined) {
      yield* write(path.join(runDir, "run.json"), run.rawRunJson);
    } else {
      yield* write(
        path.join(runDir, "run.json"),
        toJson({
          schemaVersion: run.schemaVersion ?? 1,
          id: run.id,
          state: run.state,
          workOrderId: run.workOrderId ?? "work-order",
          project: run.project ?? "Fixture Project",
          repositoryPath: "/tmp/fixture-repo",
          maxCycles: run.maxCycles ?? 2,
          agents: { worker: "claude-code", reviewer: "codex" },
          createdAt: run.createdAt ?? T0,
          updatedAt: run.updatedAt ?? T0,
          ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
          cycles: (run.cycles ?? []).map(completeCycle),
          ...(run.outcome === undefined ? {} : { outcome: run.outcome }),
          ...(run.recovery === undefined ? {} : { recovery: run.recovery }),
          ...(run.humanRequired === undefined ? {} : { humanRequired: run.humanRequired }),
          ...(run.worktreePath === undefined
            ? {}
            : {
                workspace: {
                  strategy: "git-worktree",
                  worktreePath: run.worktreePath,
                  branchName: `orchestrator/${run.id}`,
                  baseCommitSha: "abc123",
                },
              }),
          limits: { maxWorkerExecutions: 2, maxReviewerExecutions: 2 },
          interruptions: 0,
          resumes: 0,
        }),
      );
    }

    yield* write(
      path.join(runDir, "work-order.json"),
      toJson({
        id: run.workOrderId ?? "work-order",
        title: run.workOrderTitle ?? "Fixture Work Order",
      }),
    );

    if (run.events !== undefined) {
      yield* write(
        path.join(runDir, "events.jsonl"),
        `${run.events.map((event) => toJson(event)).join("\n")}\n`,
      );
    }

    for (const attempt of run.attempts ?? []) {
      const attemptDir = path.join(
        runDir,
        `cycle-${String(attempt.cycle).padStart(3, "0")}`,
        "attempts",
        attempt.attemptId,
      );
      yield* write(
        path.join(attemptDir, "journal.jsonl"),
        `${attempt.entries.map((entry) => toJson(entry)).join("\n")}\n`,
      );
      if (attempt.stdout !== undefined) {
        yield* write(path.join(attemptDir, "stdout.log"), attempt.stdout);
      }
    }

    for (const report of run.validation ?? []) {
      yield* write(
        path.join(
          runDir,
          `cycle-${String(report.cycle).padStart(3, "0")}`,
          `validation.${report.stage.replace(/_/g, "-")}${
            report.suffix === undefined ? "" : `.${report.suffix}`
          }.json`,
        ),
        toJson({ stage: report.stage, checks: report.checks }),
      );
    }
  }

  // `locks` is the complete set of locks held *now*, so writing it clears any
  // lock a previous step left behind. Releasing a lease is a real transition —
  // it is how a finished run stops claiming a checkout — and a fixture that
  // could only ever add locks could not express it.
  yield* fileSystem
    .remove(path.join(home, "locks"), { recursive: true })
    .pipe(Effect.catchCause(() => Effect.void));

  for (const lock of locks) {
    yield* write(
      path.join(home, "locks", `run-${lock.runId}.json`),
      toJson({
        schemaVersion: 1,
        kind: "run",
        resource: lock.runId,
        runId: lock.runId,
        pid: lock.pid,
        ...(lock.processGroupId === undefined ? {} : { processGroupId: lock.processGroupId }),
        hostname: lock.hostname,
        bootId: lock.bootId,
        acquiredAt: lock.acquiredAt ?? T0,
        state: lock.state,
      }),
    );
  }
});
