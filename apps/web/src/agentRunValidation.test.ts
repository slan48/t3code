import type { AgentRunCycle, AgentRunDetail, AgentRunValidationReport } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  groupValidationByPhase,
  notableValidationFailures,
  totalValidationRuns,
} from "./agentRunValidation";

/**
 * Modelled on the accepted real run, which validated `post_worker` seven times
 * in one cycle after an evidence recovery. Only the last one answers "did it
 * pass?"; the cycle-1 format failure still has to be findable.
 */

const check = (id: string, passed: boolean) => ({
  id,
  name: id,
  outcome: passed ? "PASSED" : "CHECK_FAILED",
  passed,
  durationMs: 1_000,
  exitCode: passed ? 0 : 1,
  failureDetail: passed ? null : `${id} failed`,
});

const report = (
  artifact: string,
  stage: AgentRunValidationReport["stage"],
  cycle: number,
  ranAt: string | null,
  passed: boolean,
): AgentRunValidationReport =>
  ({
    stage,
    cycle,
    artifact,
    ranAt,
    passed,
    checks: [check("typecheck", true), check("format-check", passed)],
  }) as AgentRunValidationReport;

const cycle = (number: number, validation: readonly AgentRunValidationReport[]): AgentRunCycle =>
  ({
    number,
    startedAt: "2026-07-28T18:00:00.000Z",
    finishedAt: null,
    workerStatus: "passed",
    validationStatus: "passed",
    reviewerStatus: "passed",
    finalValidationStatus: "pending",
    workerSummary: null,
    changedFiles: [],
    executions: [],
    review: null,
    validation,
    finalGate: null,
  }) as AgentRunCycle;

describe("groupValidationByPhase", () => {
  it("promotes the newest run of a phase and keeps the rest as history", () => {
    const phases = groupValidationByPhase(
      cycle(2, [
        report("validation.post-worker.json", "post_worker", 2, "2026-07-28T22:50:24.104Z", true),
        report(
          "validation.post-worker.rerun-1.json",
          "post_worker",
          2,
          "2026-07-29T00:14:10.484Z",
          true,
        ),
        report(
          "validation.post-worker.attempt-3.json",
          "post_worker",
          2,
          "2026-07-29T01:32:10.887Z",
          true,
        ),
        report(
          "validation.post-worker.rerun-2.json",
          "post_worker",
          2,
          "2026-07-29T00:29:11.012Z",
          true,
        ),
      ]),
    );

    expect(phases).toHaveLength(1);
    expect(phases[0]?.latest.artifact).toBe("validation.post-worker.attempt-3.json");
    expect(phases[0]?.previous).toHaveLength(3);
    // Newest first, so "the one before this" is the first thing an operator sees.
    expect(phases[0]?.previous.map((r) => r.artifact)).toEqual([
      "validation.post-worker.rerun-2.json",
      "validation.post-worker.rerun-1.json",
      "validation.post-worker.json",
    ]);
    expect(phases[0]?.hasEarlierFailure).toBe(false);
  });

  it("orders phases the way the engine runs them, not alphabetically", () => {
    const phases = groupValidationByPhase(
      cycle(2, [
        report("validation.final.json", "final", 2, "2026-07-29T01:33:43.284Z", true),
        report("validation.pre-review.json", "pre_review", 2, "2026-07-29T00:14:28.000Z", true),
        report("validation.post-worker.json", "post_worker", 2, "2026-07-28T22:50:24.104Z", true),
        report("validation.pre-worker.json", "pre_worker", 2, "2026-07-28T18:28:30.169Z", true),
      ]),
    );
    expect(phases.map((p) => p.stage)).toEqual([
      "pre_worker",
      "post_worker",
      "pre_review",
      "final",
    ]);
  });

  it("flags a collapsed group that hides a failure", () => {
    const phases = groupValidationByPhase(
      cycle(2, [
        report("validation.post-worker.json", "post_worker", 2, "2026-07-28T22:50:24.104Z", false),
        report(
          "validation.post-worker.rerun-1.json",
          "post_worker",
          2,
          "2026-07-29T00:14:10.484Z",
          true,
        ),
      ]),
    );
    expect(phases[0]?.latest.passed).toBe(true);
    // Green heading, red history: the label has to say so or the failure hides.
    expect(phases[0]?.hasEarlierFailure).toBe(true);
  });

  it("never lets an undated report outrank a dated one", () => {
    const phases = groupValidationByPhase(
      cycle(1, [
        report("validation.post-worker.json", "post_worker", 1, "2026-07-28T18:53:52.055Z", true),
        report("validation.post-worker.orphan.json", "post_worker", 1, null, false),
      ]),
    );
    expect(phases[0]?.latest.artifact).toBe("validation.post-worker.json");
  });

  it("handles a single run with no history", () => {
    const phases = groupValidationByPhase(
      cycle(1, [
        report("validation.post-worker.json", "post_worker", 1, "2026-07-28T18:53:52.055Z", true),
      ]),
    );
    expect(phases[0]?.previous).toEqual([]);
    expect(phases[0]?.hasEarlierFailure).toBe(false);
  });
});

describe("notableValidationFailures", () => {
  const detail = {
    cycles: [
      cycle(1, [
        report("validation.post-worker.json", "post_worker", 1, "2026-07-28T18:53:52.055Z", false),
      ]),
      cycle(2, [
        report("validation.post-worker.json", "post_worker", 2, "2026-07-28T22:50:24.104Z", false),
        report(
          "validation.post-worker.attempt-3.json",
          "post_worker",
          2,
          "2026-07-29T01:32:10.887Z",
          true,
        ),
      ]),
    ],
  } as unknown as AgentRunDetail;

  it("keeps the original cycle-1 failure discoverable after the run went green", () => {
    const failures = notableValidationFailures(detail);
    const cycleOne = failures.find((f) => f.cycle === 1);

    expect(cycleOne).toBeDefined();
    expect(cycleOne?.failedCheckIds).toEqual(["format-check"]);
    // Cycle 1's phase never passed, so it is not superseded — it is why there
    // was a cycle 2 at all.
    expect(cycleOne?.supersededByPass).toBe(false);
  });

  it("marks a failure that a later rerun of the same phase fixed", () => {
    const cycleTwo = notableValidationFailures(detail).find((f) => f.cycle === 2);
    expect(cycleTwo).toBeDefined();
    expect(cycleTwo?.supersededByPass).toBe(true);
  });

  it("counts every validation run, not just the authoritative ones", () => {
    expect(totalValidationRuns(detail)).toBe(3);
  });
});
