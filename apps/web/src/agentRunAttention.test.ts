import type { AgentRunDetail, AgentRunSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeAgentsRunning,
  describeAttemptGap,
  describeGuidance,
  formatExecutionBudget,
} from "./agentRunAttention";

/**
 * Three different jobs used to render as one label. These tests hold the
 * separation: an operator glancing at a phone must be able to tell a product
 * decision from an orchestration fault without reading a paragraph.
 */

const summary = (overrides: Partial<AgentRunSummary> = {}): AgentRunSummary =>
  ({
    id: "run-20260728-182828-e6e45ff9",
    state: "COMPLETED",
    terminal: true,
    activeRole: "none",
    attention: { kind: "none", actionable: false, summary: "" },
    process: {
      lockHeld: false,
      pid: null,
      hostname: null,
      lockState: null,
      acquiredAt: null,
      sameHost: false,
      alive: null,
      detached: null,
      inconsistent: false,
    },
    executions: {
      worker: { providerExecutions: 2, attempts: 2, effectiveLimit: 2 },
      reviewer: { providerExecutions: 3, attempts: 4, effectiveLimit: 3 },
    },
    ...overrides,
  }) as AgentRunSummary;

const detail = (s: AgentRunSummary): AgentRunDetail =>
  ({ summary: s, agents: { worker: "claude-code", reviewer: "codex" } }) as AgentRunDetail;

describe("describeGuidance", () => {
  it("tells a product decision apart from an orchestrator recovery", () => {
    const product = describeGuidance(
      summary({
        state: "HUMAN_REQUIRED",
        attention: { kind: "product-decision", actionable: true, summary: "Contract ambiguity." },
      }),
    );
    const recovery = describeGuidance(
      summary({
        state: "RECOVERY_REQUIRED",
        terminal: false,
        attention: {
          kind: "orchestrator-recovery",
          actionable: true,
          summary: "The orchestrator stopped on a lifecycle question.",
        },
      }),
    );

    expect(product.headline).toBe("Action required — product decision");
    expect(recovery.headline).toBe("Action required — orchestrator recovery");
    expect(product.headline).not.toBe(recovery.headline);
    expect(product.actionRequired).toBe(true);
    expect(recovery.actionRequired).toBe(true);
  });

  it("treats a failed run as worth inspecting but not as a blocking decision", () => {
    const failed = describeGuidance(
      summary({
        state: "FAILED",
        attention: {
          kind: "run-failed",
          actionable: false,
          summary: "The run stopped without completing (WORKER_ERROR).",
        },
      }),
    );
    expect(failed.headline).toBe("Run stopped — inspect failure evidence");
    // Nobody is blocking on it, so it must not sit in the actionable badge.
    expect(failed.actionRequired).toBe(false);
    expect(failed.tone).toBe("failure");
  });

  it("reassures on a completed run", () => {
    const done = describeGuidance(summary());
    expect(done.headline).toBe("No action required");
    expect(done.detail).toContain("acceptance gate passed");
    expect(done.actionRequired).toBe(false);
  });

  it("says a running run needs nothing from the operator", () => {
    const running = describeGuidance(
      summary({ state: "WORKER_RUNNING", terminal: false, activeRole: "worker" }),
    );
    expect(running.headline).toBe("No action required — run continues automatically");
    expect(running.tone).toBe("running");
  });
});

describe("describeAgentsRunning", () => {
  it("states plainly that nothing is running on a terminal run", () => {
    expect(describeAgentsRunning(detail(summary()))).toBe("No agents are currently running");
  });

  it("names the running agent when one is alive", () => {
    const s = summary({
      state: "WORKER_RUNNING",
      terminal: false,
      activeRole: "worker",
      process: { ...summary().process, lockHeld: true, alive: true, sameHost: true },
    });
    expect(describeAgentsRunning(detail(s))).toBe("claude-code is running");
  });

  it("surfaces the contradiction when the process is gone but state says otherwise", () => {
    const s = summary({
      state: "WORKER_RUNNING",
      terminal: false,
      activeRole: "worker",
      process: { ...summary().process, inconsistent: true, alive: false },
    });
    expect(describeAgentsRunning(detail(s))).toContain("cannot be found");
  });
});

describe("formatExecutionBudget", () => {
  it("reports provider executions against the effective limit", () => {
    // The real run: 3 provider executions, 4 attempts, base 2 widened to 3.
    // "4 / 2" was the bug — it claimed an overrun that never happened.
    expect(formatExecutionBudget({ providerExecutions: 3, effectiveLimit: 3 })).toBe("3 / 3");
    expect(formatExecutionBudget({ providerExecutions: 2, effectiveLimit: 2 })).toBe("2 / 2");
  });

  it("omits a denominator when the run was authorized without a ceiling", () => {
    expect(formatExecutionBudget({ providerExecutions: 5, effectiveLimit: null })).toBe("5");
  });
});

describe("describeAttemptGap", () => {
  it("explains the refused attempt only when there is one", () => {
    expect(describeAttemptGap({ providerExecutions: 3, attempts: 4 })).toBe(
      "4 attempts allocated · 1 refused before any process started",
    );
    // Nothing to explain when every attempt ran.
    expect(describeAttemptGap({ providerExecutions: 2, attempts: 2 })).toBeNull();
  });
});
