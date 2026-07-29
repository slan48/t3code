import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import { failureTail, isValidationArtifactFor, redactSecrets } from "./Artifacts.ts";
import { writeOrchestratorHome, type FixtureRun } from "./fixtures.ts";
import {
  AgentRunsService,
  assertInsideHome,
  currentBootId,
  evaluateLiveness,
  layerWith,
  resolveOrchestratorHome,
  resolveOrchestratorHomeFromEnv,
  type LivenessProbe,
} from "./Service.ts";

/**
 * The adapter, against the real on-disk layout.
 *
 * These tests exist because the surface is only as honest as its reading of
 * the evidence: an operator who trusts this screen instead of a terminal is
 * trusting exactly this code to distinguish "running" from "we lost it", and
 * to refuse to render a corrupt artifact as fact.
 */

const toJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const BaseLayer = NodeServices.layer;

const HOST = "test-host";
const BOOT = "boot-1000";

const probeWith = (alive: boolean): LivenessProbe => ({
  hostname: HOST,
  bootId: BOOT,
  isAlive: () => alive,
});

const withHome = <A, E, R>(
  runs: readonly FixtureRun[],
  locks: Parameters<typeof writeOrchestratorHome>[2],
  use: (service: AgentRunsService["Service"], home: string) => Effect.Effect<A, E, R>,
  options: { readonly probe?: LivenessProbe; readonly gitStatus?: number | null } = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-agent-runs-" });
    yield* writeOrchestratorHome(home, runs, locks);

    const layer = layerWith({
      home,
      probe: options.probe ?? probeWith(true),
      gitStatus: () => Effect.succeed(options.gitStatus ?? null),
    }).pipe(Layer.provide(ProcessRunner.layer), Layer.provide(NodeServices.layer));

    const service = yield* Effect.provide(AgentRunsService, layer);
    return yield* use(service, home);
  }).pipe(Effect.scoped);

/* ------------------------------------------------------------- fixtures */

const RUN_ACTIVE = "run-20260728-120000-aaaaaaaa";
const RUN_DONE = "run-20260728-130000-bbbbbbbb";
const RUN_HUMAN = "run-20260728-140000-cccccccc";
const RUN_FAILED = "run-20260728-150000-dddddddd";
const RUN_STALE = "run-20260728-160000-eeeeeeee";
const RUN_BROKEN = "run-20260728-170000-ffffffff";

const activeRun: FixtureRun = {
  id: RUN_ACTIVE,
  state: "WORKER_RUNNING",
  workOrderTitle: "Phase 1D Sprint 1",
  createdAt: "2026-07-28T12:00:00.000Z",
  updatedAt: "2026-07-28T12:00:05.000Z",
  cycles: [{ number: 1, startedAt: "2026-07-28T12:00:00.000Z" }],
  events: [
    {
      seq: 1,
      at: "2026-07-28T12:00:05.000Z",
      type: "WORKER_STARTED",
      from: "CREATED",
      to: "WORKER_RUNNING",
      cycle: 1,
    },
  ],
  attempts: [
    {
      cycle: 1,
      attemptId: "worker-01",
      entries: [
        { seq: 1, at: "2026-07-28T12:00:04.000Z", phase: "INTENT_RECORDED" },
        { seq: 2, at: "2026-07-28T12:00:05.000Z", phase: "SPAWN_CLAIMED" },
        { seq: 3, at: "2026-07-28T12:00:05.500Z", phase: "SPAWNED", pid: 4242 },
      ],
      stdout: "working…\n",
    },
  ],
};

const completedRun: FixtureRun = {
  id: RUN_DONE,
  state: "COMPLETED",
  workOrderTitle: "Completed sprint",
  createdAt: "2026-07-28T13:00:00.000Z",
  updatedAt: "2026-07-28T13:30:00.000Z",
  finishedAt: "2026-07-28T13:30:00.000Z",
  outcome: {
    state: "COMPLETED",
    reason: "OBJECTIVE_DONE",
    message: "done",
    at: "2026-07-28T13:30:00.000Z",
  },
  cycles: [
    {
      number: 1,
      startedAt: "2026-07-28T13:00:00.000Z",
      finishedAt: "2026-07-28T13:30:00.000Z",
      changedFiles: ["src/a.ts", "src/b.ts"],
      executions: [
        {
          role: "worker",
          startedAt: "2026-07-28T13:00:00.000Z",
          finishedAt: "2026-07-28T13:20:00.000Z",
          status: "OK",
        },
        {
          role: "reviewer",
          startedAt: "2026-07-28T13:25:00.000Z",
          finishedAt: "2026-07-28T13:29:00.000Z",
          status: "OK",
        },
      ],
      review: { verdict: "OBJECTIVE_DONE", summary: "Looks right." },
      finalGate: { ranAt: "2026-07-28T13:30:00.000Z", passed: true, checksRun: ["unit", "lint"] },
    },
  ],
  validation: [
    {
      cycle: 1,
      stage: "post_worker",
      checks: [
        {
          id: "typecheck",
          name: "typecheck",
          passed: true,
          outcome: "PASSED",
          durationMs: 19_000,
          startedAt: "2026-07-28T13:21:00.000Z",
        },
      ],
    },
  ],
};

/** Mirrors the shape of the real Content Ops escalation: no packet, rich review. */
const humanRequiredRun: FixtureRun = {
  id: RUN_HUMAN,
  state: "HUMAN_REQUIRED",
  workOrderTitle: "Escalated sprint",
  createdAt: "2026-07-28T14:00:00.000Z",
  updatedAt: "2026-07-28T14:26:00.000Z",
  finishedAt: "2026-07-28T14:26:00.000Z",
  outcome: {
    state: "HUMAN_REQUIRED",
    reason: "ESCALATED",
    message: "Contract ambiguity is an explicit stop condition.",
    verdict: "ESCALATE",
    at: "2026-07-28T14:26:00.000Z",
  },
  cycles: [
    {
      number: 1,
      startedAt: "2026-07-28T14:00:00.000Z",
      finishedAt: "2026-07-28T14:26:00.000Z",
      executions: [
        {
          role: "worker",
          startedAt: "2026-07-28T14:00:00.000Z",
          finishedAt: "2026-07-28T14:20:00.000Z",
          status: "OK",
        },
        {
          role: "reviewer",
          startedAt: "2026-07-28T14:25:00.000Z",
          finishedAt: "2026-07-28T14:26:00.000Z",
          status: "OK",
        },
      ],
      review: {
        verdict: "ESCALATE",
        summary: "Work order is internally contradictory about test-file changes.",
        blockingReason: "Contract ambiguity is an explicit stop condition.",
        evidence: ["format:check failed on two files", "A12 remains incomplete"],
      },
    },
  ],
};

const failedRun: FixtureRun = {
  id: RUN_FAILED,
  state: "FAILED",
  workOrderTitle: "Failed sprint",
  createdAt: "2026-07-28T15:00:00.000Z",
  updatedAt: "2026-07-28T15:10:00.000Z",
  finishedAt: "2026-07-28T15:10:00.000Z",
  outcome: {
    state: "FAILED",
    reason: "WORKER_ERROR",
    message: "worker exited non-zero",
    at: "2026-07-28T15:10:00.000Z",
  },
  cycles: [
    {
      number: 1,
      startedAt: "2026-07-28T15:00:00.000Z",
      executions: [
        {
          role: "worker",
          startedAt: "2026-07-28T15:00:00.000Z",
          finishedAt: "2026-07-28T15:10:00.000Z",
          status: "AGENT_ERROR",
        },
      ],
    },
  ],
};

/** Claims an agent is in flight; nothing holds a lock. */
const staleRun: FixtureRun = {
  ...activeRun,
  id: RUN_STALE,
  workOrderTitle: "Stale sprint",
};

/* ------------------------------------------------------------------ tests */

it.layer(BaseLayer)("AgentRunsService", (it) => {
  describe("configuration", () => {
    it("reads the home from the environment", () => {
      expect(resolveOrchestratorHomeFromEnv({})).toBeNull();
      expect(resolveOrchestratorHomeFromEnv({ T3_ORCHESTRATOR_HOME: "  " })).toBeNull();
      expect(resolveOrchestratorHomeFromEnv({ T3_ORCHESTRATOR_HOME: " /tmp/home " })).toBe(
        "/tmp/home",
      );
    });

    /**
     * The precedence that makes the packaged app work.
     *
     * An app opened from Finder inherits the launch services environment, not
     * a login shell, so the variable is simply absent there and the file is
     * what answers. A dev shell that sets it explicitly still wins.
     */
    describe("precedence", () => {
      const writeLocalConfig = Effect.fn("writeLocalConfig")(function* (contents: string) {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-local-config-" });
        const filePath = path.join(dir, "local.json");
        yield* fileSystem.writeFileString(filePath, contents).pipe(Effect.orDie);
        return filePath;
      });

      it.effect("uses the machine-local file when no variable is set", () =>
        Effect.gen(function* () {
          const filePath = yield* writeLocalConfig(
            toJson({ orchestratorHome: "/opt/orchestrator/.orchestrator" }),
          );
          const resolved = yield* resolveOrchestratorHome(filePath, {});
          expect(resolved).toEqual({
            home: "/opt/orchestrator/.orchestrator",
            source: "local-config",
          });
        }).pipe(Effect.scoped),
      );

      it.effect("lets an explicit variable override the file", () =>
        Effect.gen(function* () {
          const filePath = yield* writeLocalConfig(toJson({ orchestratorHome: "/from/file" }));
          const resolved = yield* resolveOrchestratorHome(filePath, {
            T3_ORCHESTRATOR_HOME: "/from/env",
          });
          expect(resolved).toEqual({ home: "/from/env", source: "env" });
        }).pipe(Effect.scoped),
      );

      it.effect("stays off when neither source answers", () =>
        Effect.gen(function* () {
          const filePath = yield* writeLocalConfig(toJson({}));
          expect(yield* resolveOrchestratorHome(filePath, {})).toEqual({
            home: null,
            source: "none",
          });
          // A missing file is the normal case, not an error.
          expect(yield* resolveOrchestratorHome("/nonexistent/local.json", {})).toEqual({
            home: null,
            source: "none",
          });
        }).pipe(Effect.scoped),
      );

      it.effect("treats a malformed file as absent rather than failing to boot", () =>
        Effect.gen(function* () {
          const filePath = yield* writeLocalConfig("{ not json");
          expect(yield* resolveOrchestratorHome(filePath, {})).toEqual({
            home: null,
            source: "none",
          });
        }).pipe(Effect.scoped),
      );

      it.effect("treats a blank configured path as unset", () =>
        Effect.gen(function* () {
          const filePath = yield* writeLocalConfig(toJson({ orchestratorHome: "   " }));
          expect(yield* resolveOrchestratorHome(filePath, {})).toEqual({
            home: null,
            source: "none",
          });
          expect(yield* resolveOrchestratorHome(filePath, { T3_ORCHESTRATOR_HOME: "  " })).toEqual({
            home: null,
            source: "none",
          });
        }).pipe(Effect.scoped),
      );
    });

    it.effect("reports itself unconfigured and refuses to read", () =>
      Effect.gen(function* () {
        const layer = layerWith({ home: null }).pipe(
          Layer.provide(ProcessRunner.layer),
          Layer.provide(NodeServices.layer),
        );
        const service = yield* Effect.provide(AgentRunsService, layer);
        expect(yield* service.isConfigured).toBe(false);
        const failure = yield* Effect.flip(service.list);
        expect(failure._tag).toBe("AgentRunsNotConfiguredError");
      }),
    );
  });

  describe("list", () => {
    it.effect("lists every readable run, newest first", () =>
      withHome([activeRun, completedRun, humanRequiredRun], [], (service) =>
        Effect.gen(function* () {
          const { runs, unreadable } = yield* service.list;
          expect(unreadable).toEqual([]);
          expect(runs.map((run) => run.id)).toEqual([RUN_HUMAN, RUN_DONE, RUN_ACTIVE]);
          expect(runs.map((run) => run.title)).toEqual([
            "Escalated sprint",
            "Completed sprint",
            "Phase 1D Sprint 1",
          ]);
        }),
      ),
    );

    it.effect("summarises an active run as running, with its cycle and role", () =>
      withHome(
        [activeRun],
        [{ runId: RUN_ACTIVE, pid: 4242, hostname: HOST, bootId: BOOT, state: "WORKER_RUNNING" }],
        (service) =>
          Effect.gen(function* () {
            const [run] = (yield* service.list).runs;
            expect(run?.state).toBe("WORKER_RUNNING");
            expect(run?.terminal).toBe(false);
            expect(run?.attentionRequired).toBe(false);
            expect(run?.activeRole).toBe("worker");
            expect(run?.currentCycle).toBe(1);
            expect(run?.maxCycles).toBe(2);
            expect(run?.process.alive).toBe(true);
            expect(run?.process.inconsistent).toBe(false);
            // Stream writes outrank the snapshot as evidence of movement.
            expect(run?.activity.lastActivitySource).toBe("attempt-stream");
            expect(run?.activity.streamBytes).toBeGreaterThan(0);
          }),
      ),
    );

    it.effect("summarises a completed run with its recorded file count", () =>
      withHome([completedRun], [], (service) =>
        Effect.gen(function* () {
          const [run] = (yield* service.list).runs;
          expect(run?.state).toBe("COMPLETED");
          expect(run?.terminal).toBe(true);
          expect(run?.attentionRequired).toBe(false);
          expect(run?.terminalReason).toBe("OBJECTIVE_DONE");
          expect(run?.activity.filesChanged).toBe(2);
          expect(run?.activity.filesChangedSource).toBe("run-record");
          expect(run?.humanRequired.present).toBe(false);
        }),
      ),
    );

    it.effect("marks a failed run as needing attention", () =>
      withHome([failedRun], [], (service) =>
        Effect.gen(function* () {
          const [run] = (yield* service.list).runs;
          expect(run?.state).toBe("FAILED");
          expect(run?.attentionRequired).toBe(true);
          expect(run?.terminalReason).toBe("WORKER_ERROR");
          expect(run?.humanRequired.present).toBe(true);
          expect(run?.humanRequired.summary).toBe("worker exited non-zero");
        }),
      ),
    );
  });

  describe("process liveness", () => {
    it.effect("flags a run whose owner is gone but whose state claims otherwise", () =>
      withHome(
        [activeRun],
        [{ runId: RUN_ACTIVE, pid: 4242, hostname: HOST, bootId: BOOT, state: "WORKER_RUNNING" }],
        (service) =>
          Effect.gen(function* () {
            const [run] = (yield* service.list).runs;
            expect(run?.process.alive).toBe(false);
            expect(run?.process.inconsistent).toBe(true);
          }),
        { probe: probeWith(false) },
      ),
    );

    it.effect("flags an in-flight run with no lock at all", () =>
      withHome([staleRun], [], (service) =>
        Effect.gen(function* () {
          const [run] = (yield* service.list).runs;
          expect(run?.process.lockHeld).toBe(false);
          expect(run?.process.inconsistent).toBe(true);
        }),
      ),
    );

    it.effect("never claims a terminal run is inconsistent", () =>
      withHome([humanRequiredRun], [], (service) =>
        Effect.gen(function* () {
          const [run] = (yield* service.list).runs;
          expect(run?.process.lockHeld).toBe(false);
          expect(run?.process.inconsistent).toBe(false);
        }),
      ),
    );

    it("refuses to guess liveness off-host or across a reboot", () => {
      const lock = {
        schemaVersion: 1,
        kind: "run",
        resource: "r",
        runId: "r",
        pid: 1,
        hostname: "other-host",
        bootId: BOOT,
        acquiredAt: "2026-07-28T00:00:00.000Z",
        state: "WORKER_RUNNING",
      } as const;
      expect(evaluateLiveness(lock, probeWith(true)).alive).toBeNull();
      expect(
        evaluateLiveness({ ...lock, hostname: HOST, bootId: "boot-9999" }, probeWith(true)).alive,
      ).toBeNull();
      // A one-unit rounding difference is arithmetic, not a reboot.
      expect(
        evaluateLiveness({ ...lock, hostname: HOST, bootId: "boot-1001" }, probeWith(true)).alive,
      ).toBe(true);
      expect(evaluateLiveness(null, probeWith(true)).alive).toBeNull();
    });

    it("derives a boot id that is stable for one boot", () => {
      expect(currentBootId(1_000_000_000_000, 3_600)).toBe(currentBootId(1_000_000_010_000, 3_610));
    });
  });

  describe("evidence", () => {
    it.effect("projects validation checks and the final gate", () =>
      withHome([completedRun], [], (service) =>
        Effect.gen(function* () {
          const detail = yield* service.get(RUN_DONE);
          const cycle = detail.cycles[0];
          expect(cycle?.validationStatus).toBe("passed");
          expect(cycle?.validation[0]?.stage).toBe("post_worker");
          expect(cycle?.validation[0]?.checks[0]?.name).toBe("typecheck");
          expect(cycle?.validation[0]?.checks[0]?.durationMs).toBe(19_000);
          expect(cycle?.finalGate?.passed).toBe(true);
          expect(cycle?.finalValidationStatus).toBe("passed");
        }),
      ),
    );

    it.effect("projects the reviewer verdict and its structured reasons", () =>
      withHome([humanRequiredRun], [], (service) =>
        Effect.gen(function* () {
          const detail = yield* service.get(RUN_HUMAN);
          const review = detail.cycles[0]?.review;
          expect(review?.verdict).toBe("ESCALATE");
          expect(review?.blockingReason).toContain("explicit stop condition");
          expect(review?.evidence).toHaveLength(2);
          expect(detail.cycles[0]?.reviewerStatus).toBe("escalated");
          // The gate never runs behind a non-approving reviewer.
          expect(detail.cycles[0]?.finalValidationStatus).toBe("skipped");
        }),
      ),
    );

    it.effect("builds a timeline only from recorded facts, in order", () =>
      withHome([completedRun, activeRun], [], (service) =>
        Effect.gen(function* () {
          const detail = yield* service.get(RUN_ACTIVE);
          expect(detail.timeline.length).toBeGreaterThan(0);
          const timestamps = detail.timeline.map((entry) => entry.at);
          expect([...timestamps].sort()).toEqual(timestamps);
          expect(detail.timeline.some((entry) => entry.source === "events")).toBe(true);
          expect(detail.timeline.some((entry) => entry.source === "attempt-journal")).toBe(true);
        }),
      ),
    );
  });

  describe("validation artifact discovery", () => {
    /**
     * The real run wrote seven post-worker reports for one cycle using two
     * different suffix conventions. A reader that probes a fixed list of names
     * silently returned three of them — the worst kind of wrong, because the
     * answer still looks complete.
     */
    it.effect("finds every rerun of a phase, whatever the suffix convention", () =>
      withHome(
        [
          {
            ...completedRun,
            validation: [
              { cycle: 1, stage: "post_worker", checks: [{ id: "unit", passed: true }] },
              {
                cycle: 1,
                stage: "post_worker",
                suffix: "rerun-1",
                checks: [{ id: "unit", passed: true }],
              },
              {
                cycle: 1,
                stage: "post_worker",
                suffix: "attempt-2",
                checks: [{ id: "unit", passed: true }],
              },
              {
                cycle: 1,
                stage: "post_worker",
                suffix: "rerun-2",
                checks: [{ id: "unit", passed: true }],
              },
              {
                cycle: 1,
                stage: "pre_review",
                suffix: "rerun-1",
                checks: [{ id: "integration", passed: true }],
              },
            ],
          },
        ],
        [],
        (service) =>
          Effect.gen(function* () {
            const detail = yield* service.get(RUN_DONE);
            const reports = detail.cycles[0]?.validation ?? [];
            const postWorker = reports.filter((report) => report.stage === "post_worker");

            expect(postWorker).toHaveLength(4);
            expect(postWorker.map((report) => report.artifact).sort()).toEqual([
              "validation.post-worker.attempt-2.json",
              "validation.post-worker.json",
              "validation.post-worker.rerun-1.json",
              "validation.post-worker.rerun-2.json",
            ]);
            expect(reports.filter((report) => report.stage === "pre_review")).toHaveLength(1);
          }),
      ),
    );

    it("never reads one stage's artifact as another's", () => {
      expect(isValidationArtifactFor("pre_review", "validation.pre-worker.json")).toBe(false);
      expect(isValidationArtifactFor("pre_worker", "validation.pre-worker.json")).toBe(true);
      expect(isValidationArtifactFor("post_worker", "validation.post-worker.rerun-3.json")).toBe(
        true,
      );
      // Not a validation artifact at all.
      expect(isValidationArtifactFor("post_worker", "worker-result.json")).toBe(false);
      expect(isValidationArtifactFor("final", "validation.final.json")).toBe(true);
    });
  });

  describe("human-required packet", () => {
    it.effect("falls back to derived evidence for a run with no packet", () =>
      withHome([humanRequiredRun], [], (service) =>
        Effect.gen(function* () {
          const { humanRequired } = (yield* service.get(RUN_HUMAN)).summary;
          expect(humanRequired.present).toBe(true);
          expect(humanRequired.source).toBe("derived");
          expect(humanRequired.reasonCode).toBe("ESCALATED");
          expect(humanRequired.decisionNeeded).toContain("explicit stop condition");
          expect(humanRequired.evidence).toHaveLength(2);
          // Never invented: the reviewer offered no options, so there are none.
          expect(humanRequired.options).toEqual([]);
        }),
      ),
    );

    it.effect("uses a durable packet verbatim when the orchestrator wrote one", () =>
      withHome(
        [
          {
            ...humanRequiredRun,
            humanRequired: {
              reasonCode: "ESCALATED",
              summary: "Reviewer escalated a contract ambiguity.",
              decisionNeeded: "Authorize the test files, or revert them?",
              options: ["authorize", "revert"],
              evidenceRefs: ["cycle-001/reviewer-result.json"],
              createdAt: "2026-07-28T14:26:00.000Z",
              source: "reviewer",
            },
          },
        ],
        [],
        (service) =>
          Effect.gen(function* () {
            const { humanRequired } = (yield* service.get(RUN_HUMAN)).summary;
            expect(humanRequired.source).toBe("packet");
            expect(humanRequired.decisionNeeded).toBe("Authorize the test files, or revert them?");
            expect(humanRequired.options).toEqual(["authorize", "revert"]);
            expect(humanRequired.evidence).toEqual(["cycle-001/reviewer-result.json"]);
          }),
      ),
    );

    it.effect("describes a recovery-required run as a decision about one attempt", () =>
      withHome(
        [
          {
            id: RUN_BROKEN,
            state: "RECOVERY_REQUIRED",
            recovery: {
              attemptId: "worker-01",
              role: "worker",
              cycle: 1,
              detectedAt: "2026-07-28T17:00:00.000Z",
              reason: "spawn was claimed but no outcome was recorded",
            },
          },
        ],
        [],
        (service) =>
          Effect.gen(function* () {
            const { humanRequired } = (yield* service.get(RUN_BROKEN)).summary;
            expect(humanRequired.present).toBe(true);
            expect(humanRequired.reasonCode).toBe("RECOVERY_REQUIRED");
            expect(humanRequired.decisionNeeded).toContain("worker-01");
          }),
      ),
    );
  });

  describe("path containment", () => {
    it("refuses anything that leaves the home", () => {
      expect(assertInsideHome("/home/x", "/home/x")).toBe(true);
      expect(assertInsideHome("/home/x", "/home/x/runs/a")).toBe(true);
      expect(assertInsideHome("/home/x", "/home/xy")).toBe(false);
      expect(assertInsideHome("/home/x", "/etc/passwd")).toBe(false);
      expect(assertInsideHome("/home/x", "/home")).toBe(false);
    });

    it.effect("rejects traversal and absolute paths as run ids", () =>
      withHome([completedRun], [], (service) =>
        Effect.gen(function* () {
          for (const candidate of [
            "../../etc/passwd",
            "/etc/passwd",
            "run-20260728-130000-bbbbbbbb/../../..",
            "..",
            "run-x",
          ]) {
            const failure = yield* Effect.flip(service.get(candidate));
            expect(failure._tag).toBe("AgentRunsNotFoundError");
          }
        }),
      ),
    );

    it.effect("ignores directories in the home that are not run ids", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-agent-runs-" });
        yield* writeOrchestratorHome(home, [completedRun]);
        yield* fileSystem
          .makeDirectory(path.join(home, "runs", "not-a-run"), { recursive: true })
          .pipe(Effect.orDie);

        const layer = layerWith({ home, probe: probeWith(true) }).pipe(
          Layer.provide(ProcessRunner.layer),
          Layer.provide(NodeServices.layer),
        );
        const service = yield* Effect.provide(AgentRunsService, layer);
        const { runs, unreadable } = yield* service.list;
        expect(runs).toHaveLength(1);
        expect(unreadable).toEqual([]);
      }).pipe(Effect.scoped),
    );
  });

  describe("degradation", () => {
    it.effect("reports a malformed run instead of dropping or crashing on it", () =>
      withHome(
        [completedRun, { id: RUN_BROKEN, state: "COMPLETED", rawRunJson: "{ this is not json" }],
        [],
        (service) =>
          Effect.gen(function* () {
            const { runs, unreadable } = yield* service.list;
            expect(runs.map((run) => run.id)).toEqual([RUN_DONE]);
            expect(unreadable).toHaveLength(1);
            expect(unreadable[0]?.id).toBe(RUN_BROKEN);
            expect(unreadable[0]?.reason).toContain("unreadable or malformed");
          }),
      ),
    );

    it.effect("refuses a run.json from a newer schema rather than half-reading it", () =>
      withHome([{ ...completedRun, id: RUN_BROKEN, schemaVersion: 99 }], [], (service) =>
        Effect.gen(function* () {
          const { unreadable } = yield* service.list;
          expect(unreadable[0]?.reason).toContain("schema version 99");
        }),
      ),
    );

    it.effect("reports an unrecognised state instead of inventing a phase", () =>
      withHome([{ ...completedRun, id: RUN_BROKEN, state: "TELEPORTING" }], [], (service) =>
        Effect.gen(function* () {
          const { runs, unreadable } = yield* service.list;
          expect(runs).toEqual([]);
          expect(unreadable[0]?.reason).toContain("TELEPORTING");
        }),
      ),
    );

    it.effect("keeps the readable part of a partly corrupt events log", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-agent-runs-" });
        yield* writeOrchestratorHome(home, [activeRun]);
        yield* fileSystem
          .writeFileString(
            path.join(home, "runs", RUN_ACTIVE, "events.jsonl"),
            `{"seq":1,"at":"2026-07-28T12:00:05.000Z","type":"WORKER_STARTED"}\nNOT JSON\n`,
          )
          .pipe(Effect.orDie);

        const layer = layerWith({ home, probe: probeWith(true) }).pipe(
          Layer.provide(ProcessRunner.layer),
          Layer.provide(NodeServices.layer),
        );
        const service = yield* Effect.provide(AgentRunsService, layer);
        const detail = yield* service.get(RUN_ACTIVE);
        expect(detail.timeline.some((entry) => entry.title === "Claude started")).toBe(true);
      }).pipe(Effect.scoped),
    );

    it.effect("reports a missing run as not found", () =>
      withHome([completedRun], [], (service) =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(service.get("run-20260101-000000-00000000"));
          expect(failure._tag).toBe("AgentRunsNotFoundError");
        }),
      ),
    );
  });

  describe("secrets", () => {
    it("redacts credentials that appear in command output", () => {
      const raw = [
        "TEST_DATABASE_URL=postgres://user:hunter2@localhost:5432/db",
        "API_KEY=sk-abcdefghijklmnopqrstuvwx",
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
        'GITHUB_TOKEN="ghp_abcdefghijklmnopqrstuvwxyz0123"',
        "connecting to mongodb://admin:s3cret@db.internal/app",
      ].join("\n");

      const redacted = redactSecrets(raw);
      expect(redacted).not.toContain("hunter2");
      expect(redacted).not.toContain("sk-abcdefghijklmnopqrstuvwx");
      expect(redacted).not.toContain("abcdefghijklmnopqrstuvwxyz");
      expect(redacted).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123");
      expect(redacted).not.toContain("s3cret");
      expect(redacted).toContain("[redacted]");
    });

    it("never surfaces the output of a passing check", () => {
      expect(
        failureTail({ id: "git-diff", passed: true, stdout: "AWS_SECRET_ACCESS_KEY=abc123" }),
      ).toBeNull();
    });

    it("bounds and redacts the tail of a failing check", () => {
      const tail = failureTail({
        id: "integration",
        passed: false,
        stdout: `${"x".repeat(5_000)}\nDATABASE_URL=postgres://u:p@h/db`,
      });
      expect(tail).not.toBeNull();
      expect(tail?.length).toBeLessThanOrEqual(2_100);
      expect(tail).not.toContain("postgres://u:p@h/db");
    });

    it.effect("does not put check output or environment values on the wire", () =>
      withHome(
        [
          {
            ...completedRun,
            validation: [
              {
                cycle: 1,
                stage: "post_worker",
                checks: [
                  {
                    id: "git-diff",
                    passed: true,
                    outcome: "PASSED",
                    stdout: "TEST_DATABASE_URL=postgres://u:hunter2@h/db",
                  },
                ],
              },
            ],
          },
        ],
        [],
        (service) =>
          Effect.gen(function* () {
            const detail = yield* service.get(RUN_DONE);
            const serialized = toJson(detail);
            expect(serialized).not.toContain("hunter2");
            expect(serialized).not.toContain("postgres://");
          }),
      ),
    );
  });

  describe("workspace probe", () => {
    it.effect("counts live changes only while a worker is running", () =>
      withHome(
        [{ ...activeRun, worktreePath: "IGNORED" }],
        [],
        (service) =>
          Effect.gen(function* () {
            // The fixture's worktree path is outside the home, so containment
            // refuses the probe and the count stays honestly unknown.
            const detail = yield* service.get(RUN_ACTIVE);
            expect(detail.summary.activity.filesChanged).toBeNull();
          }),
        { gitStatus: 7 },
      ),
    );

    it.effect("probes a worktree that lives inside the orchestrator home", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-agent-runs-" });
        const worktree = path.join(home, "worktrees", "fixture", RUN_ACTIVE);
        yield* fileSystem.makeDirectory(worktree, { recursive: true }).pipe(Effect.orDie);
        yield* writeOrchestratorHome(home, [{ ...activeRun, worktreePath: worktree }]);

        const layer = layerWith({
          home,
          probe: probeWith(true),
          gitStatus: () => Effect.succeed(7),
        }).pipe(Layer.provide(ProcessRunner.layer), Layer.provide(NodeServices.layer));
        const service = yield* Effect.provide(AgentRunsService, layer);

        const detail = yield* service.get(RUN_ACTIVE);
        expect(detail.summary.activity.filesChanged).toBe(7);
        expect(detail.summary.activity.filesChangedSource).toBe("workspace-probe");
      }).pipe(Effect.scoped),
    );
  });
});
