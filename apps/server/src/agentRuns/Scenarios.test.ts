import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import { writeOrchestratorHome, type FixtureLock, type FixtureRun } from "./fixtures.ts";
import { AgentRunsService, layerWith, type LivenessProbe } from "./Service.ts";

/**
 * Whole-run scenarios, advanced one durable write at a time.
 *
 * The adapter holds no state between reads, so "does the UI follow the run?"
 * reduces to "does re-reading the same home produce the new picture?" — which
 * is what these tests advance the fixture and re-read to establish. No timers
 * and no sleeps: the scenario moves when the evidence on disk moves, exactly
 * as it does in production, so there is nothing here to be flaky about.
 *
 * No agent of any kind is started. The fixtures are files.
 */

const HOST = "scenario-host";
const BOOT = "boot-2000";
const RUN = "run-20260728-190000-abcdef01";

const aliveProbe: LivenessProbe = { hostname: HOST, bootId: BOOT, isAlive: () => true };

const lock = (state: string): FixtureLock => ({
  runId: RUN,
  pid: 5150,
  hostname: HOST,
  bootId: BOOT,
  state,
  processGroupId: 5150,
});

const at = (minute: number, second = 0) =>
  `2026-07-28T19:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;

/** Drives a home through a sequence of states, reading after each write. */
const runScenario = <A>(
  steps: readonly {
    readonly run: FixtureRun;
    readonly locks: readonly FixtureLock[];
  }[],
  observe: (service: AgentRunsService["Service"]) => Effect.Effect<A>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3code-agent-scenario-" });

    const layer = layerWith({
      home,
      probe: aliveProbe,
      gitStatus: () => Effect.succeed(null),
    }).pipe(Layer.provide(ProcessRunner.layer), Layer.provide(NodeServices.layer));
    const service = yield* Effect.provide(AgentRunsService, layer);

    const observations: A[] = [];
    for (const step of steps) {
      // Each step rewrites the snapshot exactly as the orchestrator would;
      // append-only artifacts accumulate because the fixture rewrites them
      // whole with the longer history.
      yield* writeOrchestratorHome(home, [step.run], step.locks);
      observations.push(yield* observe(service));
    }
    return observations;
  }).pipe(Effect.scoped);

/* ------------------------------------------------------------ full cycle */

const worker = (cycle: number, start: number, end: number, status = "OK") => ({
  role: "worker" as const,
  attempt: 1,
  attemptId: `worker-0${cycle}`,
  startedAt: at(start),
  finishedAt: at(end),
  status,
});

const reviewer = (cycle: number, start: number, end: number) => ({
  role: "reviewer" as const,
  attempt: 1,
  attemptId: `reviewer-0${cycle}`,
  startedAt: at(start),
  finishedAt: at(end),
  status: "OK",
});

const base: FixtureRun = {
  id: RUN,
  state: "WORKER_RUNNING",
  workOrderTitle: "Scenario sprint",
  maxCycles: 2,
  createdAt: at(0),
  updatedAt: at(0),
};

it.layer(NodeServices.layer)("agent run scenarios", (it) => {
  describe("a run that works, is reworked, and completes", () => {
    it.effect("is reported correctly at every stage without any agent running", () =>
      Effect.gen(function* () {
        const observations = yield* runScenario(
          [
            // 1. Claude is working on cycle 1.
            {
              run: {
                ...base,
                state: "WORKER_RUNNING",
                updatedAt: at(1),
                cycles: [{ number: 1, startedAt: at(0) }],
                events: [{ seq: 1, at: at(0), type: "WORKER_STARTED", cycle: 1 }],
                attempts: [
                  {
                    cycle: 1,
                    attemptId: "worker-01",
                    entries: [
                      { seq: 1, at: at(0), phase: "SPAWN_CLAIMED" },
                      { seq: 2, at: at(0, 1), phase: "SPAWNED", pid: 5150 },
                    ],
                  },
                ],
              },
              locks: [lock("WORKER_RUNNING")],
            },
            // 2. Worker done, deterministic checks running.
            {
              run: {
                ...base,
                state: "AWAITING_REVIEW",
                updatedAt: at(10),
                cycles: [
                  {
                    number: 1,
                    startedAt: at(0),
                    executions: [worker(1, 0, 10)],
                    changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
                  },
                ],
                validation: [
                  {
                    cycle: 1,
                    stage: "post_worker",
                    checks: [
                      { id: "lint", passed: true, outcome: "PASSED", startedAt: at(10, 5) },
                      { id: "unit", passed: true, outcome: "PASSED", startedAt: at(10, 20) },
                    ],
                  },
                ],
              },
              locks: [lock("AWAITING_REVIEW")],
            },
            // 3. Codex reviewing.
            {
              run: {
                ...base,
                state: "REVIEWER_RUNNING",
                updatedAt: at(11),
                cycles: [
                  {
                    number: 1,
                    startedAt: at(0),
                    executions: [worker(1, 0, 10)],
                    changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
                  },
                ],
              },
              locks: [lock("REVIEWER_RUNNING")],
            },
            // 4. REWORK, and cycle 2 has begun.
            {
              run: {
                ...base,
                state: "WORKER_RUNNING",
                updatedAt: at(13),
                cycles: [
                  {
                    number: 1,
                    startedAt: at(0),
                    finishedAt: at(12),
                    executions: [worker(1, 0, 10), reviewer(1, 11, 12)],
                    review: {
                      verdict: "REWORK",
                      summary: "Two things to fix.",
                      requiredChanges: ["Handle the empty case", "Name the constant"],
                    },
                  },
                  { number: 2, startedAt: at(13) },
                ],
              },
              locks: [lock("WORKER_RUNNING")],
            },
            // 5. Final acceptance gate.
            {
              run: {
                ...base,
                state: "FINAL_VALIDATION",
                updatedAt: at(24),
                cycles: [
                  {
                    number: 1,
                    startedAt: at(0),
                    finishedAt: at(12),
                    executions: [worker(1, 0, 10), reviewer(1, 11, 12)],
                    review: { verdict: "REWORK", summary: "Two things to fix." },
                  },
                  {
                    number: 2,
                    startedAt: at(13),
                    executions: [worker(2, 13, 22), reviewer(2, 23, 24)],
                    review: { verdict: "OBJECTIVE_DONE", summary: "Both addressed." },
                  },
                ],
              },
              locks: [lock("FINAL_VALIDATION")],
            },
            // 6. Completed. The lease is released.
            {
              run: {
                ...base,
                state: "COMPLETED",
                updatedAt: at(25),
                finishedAt: at(25),
                outcome: {
                  state: "COMPLETED",
                  reason: "OBJECTIVE_DONE",
                  message: "Gate passed.",
                  at: at(25),
                },
                cycles: [
                  {
                    number: 1,
                    startedAt: at(0),
                    finishedAt: at(12),
                    executions: [worker(1, 0, 10), reviewer(1, 11, 12)],
                    review: { verdict: "REWORK", summary: "Two things to fix." },
                  },
                  {
                    number: 2,
                    startedAt: at(13),
                    finishedAt: at(25),
                    executions: [worker(2, 13, 22), reviewer(2, 23, 24)],
                    review: { verdict: "OBJECTIVE_DONE", summary: "Both addressed." },
                    finalGate: { ranAt: at(25), passed: true, checksRun: ["lint", "unit"] },
                  },
                ],
              },
              locks: [],
            },
          ],
          (service) => service.get(RUN).pipe(Effect.orDie),
        );

        const states = observations.map((detail) => detail.summary.state);
        expect(states).toEqual([
          "WORKER_RUNNING",
          "AWAITING_REVIEW",
          "REVIEWER_RUNNING",
          "WORKER_RUNNING",
          "FINAL_VALIDATION",
          "COMPLETED",
        ]);

        expect(observations.map((detail) => detail.summary.activeRole)).toEqual([
          "worker",
          "validation",
          "reviewer",
          "worker",
          "final_validation",
          "none",
        ]);

        expect(observations.map((detail) => detail.summary.currentCycle)).toEqual([
          1, 1, 1, 2, 2, 2,
        ]);

        // Files changed appear as soon as the orchestrator records them.
        expect(observations[0]?.summary.activity.filesChanged).toBeNull();
        expect(observations[1]?.summary.activity.filesChanged).toBe(3);

        // Validation evidence appears with the artifact, not before.
        expect(observations[0]?.cycles[0]?.validationStatus).toBe("pending");
        expect(observations[1]?.cycles[0]?.validationStatus).toBe("passed");

        // The rework verdict is recorded and never silently replaced.
        expect(observations[3]?.cycles[0]?.reviewerStatus).toBe("rework");
        expect(observations[3]?.cycles[0]?.review?.requiredChanges).toHaveLength(2);

        // Terminal: nothing holds a lock, nothing is inconsistent.
        const final = observations[5];
        expect(final?.summary.terminal).toBe(true);
        expect(final?.summary.attentionRequired).toBe(false);
        expect(final?.summary.humanRequired.present).toBe(false);
        expect(final?.summary.process.lockHeld).toBe(false);
        expect(final?.summary.process.inconsistent).toBe(false);
        expect(final?.cycles[1]?.finalValidationStatus).toBe("passed");
      }),
    );
  });

  describe("a run that escalates to a human", () => {
    it.effect("becomes attention-worthy and states that no agent is running", () =>
      Effect.gen(function* () {
        const cycleWithWorker = {
          number: 1,
          startedAt: at(0),
          executions: [worker(1, 0, 10)],
          changedFiles: ["src/a.ts"],
        };

        const observations = yield* runScenario(
          [
            {
              run: {
                ...base,
                state: "REVIEWER_RUNNING",
                updatedAt: at(11),
                cycles: [cycleWithWorker],
              },
              locks: [lock("REVIEWER_RUNNING")],
            },
            {
              run: {
                ...base,
                state: "HUMAN_REQUIRED",
                updatedAt: at(12),
                finishedAt: at(12),
                outcome: {
                  state: "HUMAN_REQUIRED",
                  reason: "ESCALATED",
                  message: "The work order contradicts itself about test files.",
                  verdict: "ESCALATE",
                  at: at(12),
                },
                cycles: [
                  {
                    ...cycleWithWorker,
                    finishedAt: at(12),
                    executions: [worker(1, 0, 10), reviewer(1, 11, 12)],
                    review: {
                      verdict: "ESCALATE",
                      summary: "Contract ambiguity.",
                      blockingReason: "Deciding this requires a human, not a reviewer.",
                      evidence: ["A19 requires tests", "Forbidden list names tests"],
                    },
                  },
                ],
              },
              locks: [],
            },
          ],
          (service) => service.get(RUN).pipe(Effect.orDie),
        );

        expect(observations[0]?.summary.attentionRequired).toBe(false);
        expect(observations[0]?.summary.humanRequired.present).toBe(false);

        const escalated = observations[1];
        expect(escalated?.summary.state).toBe("HUMAN_REQUIRED");
        expect(escalated?.summary.attentionRequired).toBe(true);
        expect(escalated?.summary.activeRole).toBe("none");
        expect(escalated?.summary.humanRequired.present).toBe(true);
        expect(escalated?.summary.humanRequired.reasonCode).toBe("ESCALATED");
        expect(escalated?.summary.humanRequired.decisionNeeded).toBe(
          "Deciding this requires a human, not a reviewer.",
        );
        expect(escalated?.summary.humanRequired.evidence).toHaveLength(2);
        // The surface's "no agents are currently running" line rests on this.
        expect(escalated?.summary.process.lockHeld).toBe(false);
        expect(escalated?.summary.process.inconsistent).toBe(false);
      }),
    );
  });
});
