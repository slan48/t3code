import { describe, expect, it, vi } from "vite-plus/test";

import {
  ThreadId,
  TurnId,
  type OrchestrationProposedPlanId,
  type PeerLoopProposalFingerprint,
} from "@t3tools/contracts";
import {
  createNavigatorArmedQuestionStore,
  type NavigatorApprovalGateResult,
} from "./navigatorApprovalGate";
import {
  applyNavigatorApprovalOutcome,
  consumeNavigatorApprovalForIneligibleSubmission,
  isNavigatorApprovalContinuationCurrent,
  syncNavigatorApprovalProviderTurn,
  type NavigatorApprovalTarget,
} from "./navigatorApprovalInteraction";
import type { ExecutableProposal } from "./navigatorExecution";

const TARGET: NavigatorApprovalTarget = {
  threadId: ThreadId.make("thread-a"),
  proposalId: "proposal-a" as OrchestrationProposedPlanId,
  fingerprint: "0123456789abcdef0123456789abcdef" as PeerLoopProposalFingerprint,
};
const OTHER_TARGET: NavigatorApprovalTarget = {
  ...TARGET,
  fingerprint: "fedcba9876543210fedcba9876543210" as PeerLoopProposalFingerprint,
};
const PROPOSAL: ExecutableProposal = {
  id: TARGET.proposalId,
  planMarkdown: "# Current plan",
  implementedAt: null,
  implementationThreadId: null,
  turnId: TurnId.make("turn-a"),
};

const result = (outcome: NavigatorApprovalGateResult["outcome"]): NavigatorApprovalGateResult => ({
  outcome,
  proposal: PROPOSAL,
});

function interaction(overrides: Partial<Parameters<typeof applyNavigatorApprovalOutcome>[0]> = {}) {
  const store = createNavigatorArmedQuestionStore(() => 1_000);
  const clearComposer = vi.fn();
  const clearTransient = vi.fn();
  const armQuestion = vi.fn((target: NavigatorApprovalTarget) => store.arm(target));
  const showDeclined = vi.fn();
  const execute = vi.fn(async () => undefined);
  return {
    store,
    clearComposer,
    clearTransient,
    armQuestion,
    showDeclined,
    execute,
    input: {
      result: result("SEND_TO_PROVIDER"),
      targetAtSend: TARGET,
      currentTarget: TARGET,
      targetVersionUnchanged: true,
      currentStage1Eligible: true,
      armedAtSend: null,
      threadId: TARGET.threadId,
      store,
      submittedText: "  Sí, procede con el plan.  ",
      clearComposer,
      clearTransient,
      armQuestion,
      showDeclined,
      execute,
      ...overrides,
    },
  };
}

describe("applyNavigatorApprovalOutcome", () => {
  it("asks, clears the triggering bare response, and arms only the current proposal", async () => {
    const state = interaction({ result: result("ASK_EXECUTION_CONFIRMATION") });
    expect(await applyNavigatorApprovalOutcome(state.input)).toBe(true);
    expect(state.clearComposer).toHaveBeenCalledOnce();
    expect(state.armQuestion).toHaveBeenCalledWith(TARGET);
    expect(state.store.read(TARGET)).toMatchObject(TARGET);
    expect(state.execute).not.toHaveBeenCalled();
  });

  it("executes an armed response once with the exact submitted Owner text and consumes authority", async () => {
    const state = interaction();
    const armed = state.store.arm(TARGET);
    state.input.armedAtSend = armed;
    state.input.result = { outcome: "EXECUTE", proposal: PROPOSAL };
    expect(await applyNavigatorApprovalOutcome(state.input)).toBe(true);
    expect(state.execute).toHaveBeenCalledWith(PROPOSAL, "  Sí, procede con el plan.  ");
    expect(state.store.read(TARGET)).toBeNull();
  });

  it("declines an armed response without executing or entering provider submission", async () => {
    const state = interaction();
    const armed = state.store.arm(TARGET);
    state.input.armedAtSend = armed;
    state.input.result = { outcome: "DECLINE_EXECUTION", proposal: PROPOSAL };
    expect(await applyNavigatorApprovalOutcome(state.input)).toBe(true);
    expect(state.clearComposer).toHaveBeenCalledOnce();
    expect(state.showDeclined).toHaveBeenCalledOnce();
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.store.read(TARGET)).toBeNull();
  });

  it("consumes authority and preserves the original provider submission on fail-closed SEND", async () => {
    const state = interaction();
    state.store.arm(TARGET);
    const armed = state.store.read(TARGET);
    expect(armed).not.toBeNull();
    expect(await applyNavigatorApprovalOutcome({ ...state.input, armedAtSend: armed })).toBe(false);
    expect(state.store.read(TARGET)).toBeNull();
    expect(state.clearTransient).toHaveBeenCalledOnce();
    expect(state.clearComposer).not.toHaveBeenCalled();
    expect(state.execute).not.toHaveBeenCalled();
  });

  it("turns a changed proposal into SEND and cannot execute stale authority", async () => {
    const state = interaction({
      currentTarget: OTHER_TARGET,
      result: { outcome: "EXECUTE", proposal: PROPOSAL },
    });
    state.store.arm(TARGET);
    const armed = state.store.read(TARGET);
    expect(await applyNavigatorApprovalOutcome({ ...state.input, armedAtSend: armed })).toBe(false);
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.store.read(TARGET)).toBeNull();
  });

  it("turns an otherwise matching result into SEND when stage 1 became ineligible", async () => {
    const state = interaction({
      currentStage1Eligible: false,
      result: { outcome: "EXECUTE", proposal: PROPOSAL },
    });
    state.store.arm(TARGET);
    const armed = state.store.read(TARGET);
    expect(await applyNavigatorApprovalOutcome({ ...state.input, armedAtSend: armed })).toBe(false);
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.clearComposer).not.toHaveBeenCalled();
    expect(state.store.read(TARGET)).toBeNull();
  });

  it("cannot execute when the proposal changed away and back during classification", async () => {
    const state = interaction({
      targetVersionUnchanged: false,
      result: { outcome: "EXECUTE", proposal: PROPOSAL },
    });
    state.store.arm(TARGET);
    const armed = state.store.read(TARGET);
    expect(await applyNavigatorApprovalOutcome({ ...state.input, armedAtSend: armed })).toBe(false);
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.store.read(TARGET)).toBeNull();
  });
});

describe("syncNavigatorApprovalProviderTurn", () => {
  it("keeps the actual question interaction before and at the asked timestamp", () => {
    for (const startedAt of [999, 1_000]) {
      const store = createNavigatorArmedQuestionStore(() => 1_000);
      store.arm(TARGET);
      expect(
        syncNavigatorApprovalProviderTurn({
          store,
          threadId: TARGET.threadId,
          target: TARGET,
          startedAt,
          questionVisible: true,
        }),
      ).toBe(true);
      expect(store.read(TARGET)).not.toBeNull();
    }
  });

  it("removes both authority and the question after a strictly later provider start", () => {
    const store = createNavigatorArmedQuestionStore(() => 1_000);
    store.arm(TARGET);
    expect(
      syncNavigatorApprovalProviderTurn({
        store,
        threadId: TARGET.threadId,
        target: TARGET,
        startedAt: 1_001,
        questionVisible: true,
      }),
    ).toBe(false);
    expect(store.read(TARGET)).toBeNull();
  });

  it("does not use a temporarily unavailable stage-1 target as provider invalidation", () => {
    const store = createNavigatorArmedQuestionStore(() => 1_000);
    store.arm(TARGET);
    expect(
      syncNavigatorApprovalProviderTurn({
        store,
        threadId: TARGET.threadId,
        target: null,
        startedAt: 1_000,
        questionVisible: true,
      }),
    ).toBe(true);
    expect(store.read(TARGET)).not.toBeNull();
  });
});

describe("isNavigatorApprovalContinuationCurrent", () => {
  const base = {
    submittedEnvironmentId: "environment-a",
    submittedThreadId: "thread-a",
    currentEnvironmentId: "environment-a",
    currentThreadId: "thread-a",
  };

  it.each([
    ["same route", base, true],
    ["thread navigation", { ...base, currentThreadId: "thread-b" }, false],
    ["environment navigation", { ...base, currentEnvironmentId: "environment-b" }, false],
  ])("recognizes %s", (_name, input, expected) => {
    expect(isNavigatorApprovalContinuationCurrent(input)).toBe(expected);
  });
});

describe("consumeNavigatorApprovalForIneligibleSubmission", () => {
  it("does not reopen a same-tick provider-send window for ordinary messages", () => {
    const store = createNavigatorArmedQuestionStore(() => 1_000);
    const lock = { locked: false };
    let providerSubmissions = 0;
    const submitIneligible = () => {
      if (lock.locked) return;
      lock.locked = true;
      consumeNavigatorApprovalForIneligibleSubmission({
        stage1: {
          eligible: false,
          outcome: "SEND_TO_PROVIDER",
          reason: "proposal-not-settled",
        },
        targetAtSend: null,
        threadId: TARGET.threadId,
        store,
        hasTransientQuestion: false,
        clearTransient: () => {},
      });
      providerSubmissions += 1;
    };

    submitIneligible();
    submitIneligible();

    expect(providerSubmissions).toBe(1);
  });

  it("consumes an armed question synchronously before the ordinary send", () => {
    const store = createNavigatorArmedQuestionStore(() => 1_000);
    store.arm(TARGET);
    let cleared = 0;
    let providerSubmissions = 0;
    const submit = () => {
      if (providerSubmissions > 0) return;
      consumeNavigatorApprovalForIneligibleSubmission({
        stage1: {
          eligible: false,
          outcome: "SEND_TO_PROVIDER",
          reason: "execution-unavailable",
        },
        targetAtSend: TARGET,
        threadId: TARGET.threadId,
        store,
        hasTransientQuestion: providerSubmissions === 0,
        clearTransient: () => {
          cleared += 1;
        },
      });
      providerSubmissions += 1;
    };

    submit();
    submit();

    expect(store.read(TARGET)).toBeNull();
    expect(cleared).toBe(1);
    expect(providerSubmissions).toBe(1);
  });
});
