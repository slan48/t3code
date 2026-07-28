import type { AgentRunSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  acknowledgementKey,
  agentRunBadgeCount,
  MAX_ACKNOWLEDGEMENTS,
  MAX_CONCURRENT_ALERTS,
  pendingAgentRunAlerts,
  withAcknowledgement,
} from "./agentRunAlerts";

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

const humanRequired = run({
  state: "HUMAN_REQUIRED",
  terminal: true,
  attentionRequired: true,
});

describe("pendingAgentRunAlerts", () => {
  it("stays silent while a run is still working", () => {
    expect(pendingAgentRunAlerts([run({})], [])).toEqual([]);
  });

  it("raises an alert for a terminal run the operator has not seen", () => {
    const [alert] = pendingAgentRunAlerts([humanRequired], []);
    expect(alert?.message).toBe("needs your input");
    expect(alert?.tone).toBe("attention");
    expect(alert?.runId).toBe(humanRequired.id);
  });

  it("does not depend on having witnessed the transition", () => {
    // The run was already terminal on the very first poll after a reload;
    // an alert must still fire, or a run that finished while T3Code was
    // closed would never be surfaced.
    expect(pendingAgentRunAlerts([humanRequired], [])).toHaveLength(1);
  });

  it("goes quiet once acknowledged", () => {
    const key = acknowledgementKey(humanRequired);
    expect(pendingAgentRunAlerts([humanRequired], [key])).toEqual([]);
  });

  it("alerts again when the same run reaches a different outcome", () => {
    const key = acknowledgementKey(humanRequired);
    const later = run({ state: "FAILED", terminal: true, attentionRequired: true });
    const [alert] = pendingAgentRunAlerts([later], [key]);
    expect(alert?.message).toBe("failed");
    expect(alert?.tone).toBe("failure");
  });

  it("treats a completed run as good news", () => {
    const done = run({ state: "COMPLETED", terminal: true, attentionRequired: false });
    const [alert] = pendingAgentRunAlerts([done], []);
    expect(alert?.tone).toBe("success");
    expect(alert?.message).toBe("completed");
  });

  it("caps how many toasts it raises at once", () => {
    const many = Array.from({ length: 8 }, (_, index) =>
      run({
        id: `run-2026072${index}-120000-aaaaaaaa`,
        state: "FAILED",
        terminal: true,
        attentionRequired: true,
      }),
    );
    // The badge still counts all of them; only the toasts are bounded.
    expect(pendingAgentRunAlerts(many, [])).toHaveLength(MAX_CONCURRENT_ALERTS);
    expect(agentRunBadgeCount(many, [])).toBe(8);
  });

  it("alerts on recovery-required, which is not terminal but does block", () => {
    const stuck = run({ state: "RECOVERY_REQUIRED", terminal: false, attentionRequired: true });
    expect(pendingAgentRunAlerts([stuck], [])).toHaveLength(1);
  });
});

describe("agentRunBadgeCount", () => {
  it("counts only unacknowledged runs that are asking for something", () => {
    const done = run({
      id: "run-20260728-130000-bbbbbbbb",
      state: "COMPLETED",
      terminal: true,
      attentionRequired: false,
    });
    expect(agentRunBadgeCount([humanRequired, done, run({})], [])).toBe(1);
    expect(agentRunBadgeCount([humanRequired, done], [acknowledgementKey(humanRequired)])).toBe(0);
  });
});

describe("withAcknowledgement", () => {
  it("is idempotent", () => {
    const once = withAcknowledgement([], "a");
    expect(withAcknowledgement(once, "a")).toEqual(["a"]);
  });

  it("keeps the list bounded", () => {
    let keys: readonly string[] = [];
    for (let index = 0; index < MAX_ACKNOWLEDGEMENTS + 25; index += 1) {
      keys = withAcknowledgement(keys, `key-${index}`);
    }
    expect(keys).toHaveLength(MAX_ACKNOWLEDGEMENTS);
    expect(keys.at(-1)).toBe(`key-${MAX_ACKNOWLEDGEMENTS + 24}`);
  });
});
