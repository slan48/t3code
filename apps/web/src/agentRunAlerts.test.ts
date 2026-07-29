import type { AgentRunSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentRunBadgeCount,
  alertKey,
  decideAgentRunAlerts,
  MAX_ACKNOWLEDGEMENTS,
  MAX_CONCURRENT_ALERTS,
  withKeys,
} from "./agentRunAlerts";

/**
 * The bug these guard against is not subtle, and it made the cockpit unusable
 * on a phone: every reload replayed the terminal toasts, including for runs
 * that had finished days earlier. Checking whether anything had changed
 * produced a wall of notifications about things already known.
 */

const run = (overrides: Partial<AgentRunSummary>): AgentRunSummary =>
  ({
    id: "run-20260728-120000-aaaaaaaa",
    project: "Project",
    title: "Phase 1D Sprint 1",
    workOrderId: "wo",
    state: "WORKER_RUNNING",
    terminal: false,
    attentionRequired: false,
    currentCycle: 1,
    maxCycles: 2,
    activeRole: "worker",
    startedAt: "2026-07-28T12:00:00.000Z",
    updatedAt: "2026-07-28T12:00:00.000Z",
    finishedAt: null,
    workerExecutionCount: 1,
    reviewerExecutionCount: 0,
    executions: {
      worker: { providerExecutions: 1, attempts: 1, effectiveLimit: 2 },
      reviewer: { providerExecutions: 0, attempts: 0, effectiveLimit: 2 },
    },
    attention: { kind: "none", actionable: false, summary: "" },
    lastEventSeq: 4,
    terminalReason: null,
    humanRequired: {
      present: false,
      source: "none",
      reasonCode: null,
      summary: null,
      decisionNeeded: null,
      options: [],
      evidence: [],
      createdAt: null,
    },
    process: {
      lockHeld: true,
      pid: 1,
      hostname: "h",
      lockState: "WORKER_RUNNING",
      acquiredAt: null,
      sameHost: true,
      alive: true,
      detached: true,
      inconsistent: false,
    },
    activity: {
      lastActivityAt: null,
      lastActivitySource: null,
      lastStreamWriteAt: null,
      streamBytes: null,
      filesChanged: null,
      filesChangedAt: null,
      filesChangedSource: null,
    },
    ...overrides,
  }) as AgentRunSummary;

const completed = (id: string, seq = 9): AgentRunSummary =>
  run({
    id,
    state: "COMPLETED",
    terminal: true,
    lastEventSeq: seq,
    terminalReason: "OBJECTIVE_DONE",
    attention: { kind: "none", actionable: false, summary: "" },
  });

const failed = (id: string, seq = 9): AgentRunSummary =>
  run({
    id,
    state: "FAILED",
    terminal: true,
    lastEventSeq: seq,
    terminalReason: "REVIEW_UNUSABLE",
    attention: { kind: "run-failed", actionable: false, summary: "stopped" },
  });

const humanRequired = (id: string, seq = 4): AgentRunSummary =>
  run({
    id,
    state: "HUMAN_REQUIRED",
    terminal: true,
    attentionRequired: true,
    lastEventSeq: seq,
    terminalReason: "ESCALATED",
    attention: { kind: "product-decision", actionable: true, summary: "decide" },
  });

const recoveryRequired = (id: string, seq = 3): AgentRunSummary =>
  run({
    id,
    state: "RECOVERY_REQUIRED",
    terminal: false,
    attentionRequired: true,
    lastEventSeq: seq,
    attention: { kind: "orchestrator-recovery", actionable: true, summary: "recover" },
  });

describe("first load absorbs history instead of announcing it", () => {
  it("raises no toast for historical completed runs", () => {
    const runs = [completed("a"), completed("b"), completed("c")];
    const decision = decideAgentRunAlerts({ runs, announced: [], firstLoad: true });

    expect(decision.alerts).toHaveLength(0);
    // Silently recorded, so a later reload does not treat them as new either.
    expect(decision.silence).toHaveLength(3);
  });

  it("raises no toast for historical failed runs", () => {
    const runs = [failed("a"), failed("b")];
    const decision = decideAgentRunAlerts({ runs, announced: [], firstLoad: true });
    expect(decision.alerts).toHaveLength(0);
    expect(decision.silence).toHaveLength(2);
  });

  it("still announces work that is genuinely still waiting on a person", () => {
    // Discovered on a cold start, but the ask is open: the operator has not
    // seen it and the run cannot continue without them.
    const runs = [completed("done"), humanRequired("blocked"), recoveryRequired("stuck")];
    const decision = decideAgentRunAlerts({ runs, announced: [], firstLoad: true });

    expect(decision.alerts.map((alert) => alert.runId)).toEqual(["blocked", "stuck"]);
    expect(decision.silence).toEqual([alertKey(completed("done"))]);
  });
});

describe("a reload never repeats an announcement", () => {
  it("does not re-announce a completion it already announced", () => {
    const runs = [completed("a")];
    const first = decideAgentRunAlerts({ runs, announced: [], firstLoad: false });
    expect(first.alerts).toHaveLength(1);

    const announced = withKeys([], [...first.silence, ...first.alerts.map((a) => a.key)]);
    const second = decideAgentRunAlerts({ runs, announced, firstLoad: false });
    expect(second.alerts).toHaveLength(0);
  });

  it("does not re-announce an open decision, but keeps it in the badge", () => {
    const runs = [humanRequired("blocked")];
    const first = decideAgentRunAlerts({ runs, announced: [], firstLoad: true });
    expect(first.alerts).toHaveLength(1);

    const announced = withKeys(
      [],
      first.alerts.map((a) => a.key),
    );
    expect(decideAgentRunAlerts({ runs, announced, firstLoad: false }).alerts).toHaveLength(0);

    // Announced is not acknowledged: it is still asking for something.
    expect(agentRunBadgeCount(runs, [])).toBe(1);
  });

  it("announces again when the same run genuinely moves on", () => {
    const blocked = humanRequired("r", 4);
    const announced = withKeys([], [alertKey(blocked)]);

    // Resolved, ran on, and completed: a new durable event, and new news.
    const later = completed("r", 13);
    const decision = decideAgentRunAlerts({ runs: [later], announced, firstLoad: false });
    expect(decision.alerts).toHaveLength(1);
    expect(decision.alerts[0]?.message).toBe("completed");
  });

  it("keeps outcomes of one run distinct", () => {
    // Same run, same state twice, different durable events — failed, recovered,
    // failed again. Identity must not collide.
    expect(alertKey(failed("r", 9))).not.toBe(alertKey(failed("r", 21)));
  });
});

describe("classification reaches the operator", () => {
  it("distinguishes a product decision from an orchestrator recovery", () => {
    const decision = decideAgentRunAlerts({
      runs: [humanRequired("p"), recoveryRequired("o")],
      announced: [],
      firstLoad: false,
    });

    expect(decision.alerts[0]?.message).toBe("needs a product decision");
    expect(decision.alerts[0]?.tone).toBe("attention");
    expect(decision.alerts[1]?.message).toBe("needs orchestrator recovery");
    expect(decision.alerts.every((alert) => alert.actionable)).toBe(true);
  });

  it("treats a failure as information rather than a blocking ask", () => {
    const decision = decideAgentRunAlerts({
      runs: [failed("f")],
      announced: [],
      firstLoad: false,
    });
    expect(decision.alerts[0]?.tone).toBe("failure");
    expect(decision.alerts[0]?.actionable).toBe(false);
  });
});

describe("the badge counts what is actionable now", () => {
  it("ignores historical outcomes entirely", () => {
    const runs = [completed("a"), failed("b"), completed("c")];
    expect(agentRunBadgeCount(runs, [])).toBe(0);
  });

  it("counts open decisions and recoveries", () => {
    expect(
      agentRunBadgeCount([humanRequired("a"), recoveryRequired("b"), completed("c")], []),
    ).toBe(2);
  });

  it("clears once the operator has dealt with it", () => {
    const blocked = humanRequired("a");
    expect(agentRunBadgeCount([blocked], [alertKey(blocked)])).toBe(0);
  });
});

describe("bounds and storage hygiene", () => {
  it("caps concurrent toasts and records the overflow as announced", () => {
    const runs = Array.from({ length: MAX_CONCURRENT_ALERTS + 2 }, (_, i) => completed(`r${i}`));
    const decision = decideAgentRunAlerts({ runs, announced: [], firstLoad: false });

    expect(decision.alerts).toHaveLength(MAX_CONCURRENT_ALERTS);
    // The rest are not lost and not re-toasted later; the list carries them.
    expect(decision.silence).toHaveLength(2);
  });

  it("keeps the stored key list bounded", () => {
    const many = Array.from({ length: MAX_ACKNOWLEDGEMENTS + 25 }, (_, i) => `k${i}`);
    const stored = withKeys([], many);
    expect(stored).toHaveLength(MAX_ACKNOWLEDGEMENTS);
    expect(stored.at(-1)).toBe(`k${MAX_ACKNOWLEDGEMENTS + 24}`);
  });

  it("is idempotent", () => {
    const once = withKeys([], ["a", "b"]);
    expect(withKeys(once, ["a", "b"])).toEqual(once);
    expect(withKeys(once, [])).toBe(once);
  });
});
