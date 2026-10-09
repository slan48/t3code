import { describe, expect, it } from "vite-plus/test";

import { ThreadId, TurnId } from "@t3tools/contracts";
import type {
  NavigatorApprovalTraits,
  OrchestrationProposedPlanId,
  PeerLoopProposalFingerprint,
} from "@t3tools/contracts";

import {
  NAVIGATOR_ARMED_QUESTION_TTL_MS,
  NAVIGATOR_APPROVAL_CANDIDATE_MAX_CODE_POINTS,
  NAVIGATOR_KNOWN_BARE_AFFIRMATIONS,
  NAVIGATOR_KNOWN_BARE_NEGATIONS,
  combineNavigatorApprovalTraits,
  claimNavigatorApprovalSubmission,
  createNavigatorArmedQuestionStore,
  createNavigatorApprovalSubmissionLock,
  isNavigatorApprovalClassificationCandidate,
  navigatorApprovalCanBypassProvider,
  navigatorExecutionStage1,
  navigatorExecutionStage2FastPath,
  navigatorExecutionStage4CandidateFilter,
  recognizeNavigatorKnownBareResponse,
  resolveNavigatorApprovalGate,
  resolveNavigatorKnownBareResponse,
  type NavigatorArmedQuestion,
  type NavigatorExecutionOutcome,
  type NavigatorExecutionProposalTarget,
  type NavigatorExecutionStage1Input,
} from "./navigatorApprovalGate";
import { NAVIGATOR_CONFIRMATION_PHRASES } from "./navigatorConfirmation";
import type { ExecutableProposal } from "./navigatorExecution";

const THREAD_A = ThreadId.make("navigator-thread-a");
const THREAD_B = ThreadId.make("navigator-thread-b");
const PROPOSAL_A = "proposal-a" as OrchestrationProposedPlanId;
const PROPOSAL_B = "proposal-b" as OrchestrationProposedPlanId;
const FINGERPRINT_A = "a".repeat(32) as PeerLoopProposalFingerprint;
const FINGERPRINT_B = "b".repeat(32) as PeerLoopProposalFingerprint;

const PROPOSAL: ExecutableProposal = {
  id: PROPOSAL_A,
  planMarkdown: "# Current proposal",
  implementedAt: null,
  implementationThreadId: null,
  turnId: TurnId.make("proposal-turn"),
};

const TARGET: NavigatorExecutionProposalTarget = {
  proposal: PROPOSAL,
  isCurrent: true,
  isLatest: true,
};

const BASE_STAGE_1_INPUT: NavigatorExecutionStage1Input = {
  purpose: "navigator",
  isDurableThread: true,
  hasAttachments: false,
  utterance: "Please proceed",
  selectedProposalTargets: [TARGET],
  proposalSettled: true,
  proposalActionable: true,
  availability: { canExecute: true },
};

function stage1(
  overrides: Partial<NavigatorExecutionStage1Input> = {},
): ReturnType<typeof navigatorExecutionStage1> {
  return navigatorExecutionStage1({ ...BASE_STAGE_1_INPUT, ...overrides });
}

describe("navigator deterministic approval gate primitives", () => {
  it("serializes synchronous gate claims and releases every terminal path", () => {
    const lock = createNavigatorApprovalSubmissionLock();
    expect(claimNavigatorApprovalSubmission({ stage1: BASE_STAGE_1_INPUT, lock })).toMatchObject({
      stage1: { eligible: true },
      lockHeld: true,
    });
    expect(lock.isLocked()).toBe(true);
    expect(claimNavigatorApprovalSubmission({ stage1: BASE_STAGE_1_INPUT, lock }).lockHeld).toBe(
      false,
    );
    expect(
      claimNavigatorApprovalSubmission({
        stage1: { ...BASE_STAGE_1_INPUT, purpose: "coding" },
        lock,
      }).lockHeld,
    ).toBe(false);

    for (const terminalPath of [
      "classifier-error",
      "fail-closed",
      "thrown-defect",
      "stale-target",
      "navigation-cancel",
      "ask",
      "decline",
      "execute",
      "send",
    ]) {
      lock.release();
      expect(lock.tryAcquire(), terminalPath).toBe(true);
    }
    lock.release();
    lock.release();
    expect(lock.isLocked()).toBe(false);
  });

  it("returns SEND_TO_PROVIDER for each failed stage-1 eligibility precondition", () => {
    const cases: ReadonlyArray<readonly [string, Partial<NavigatorExecutionStage1Input>, string]> =
      [
        ["coding thread", { purpose: "coding" }, "not-navigator-purpose"],
        ["draft thread", { isDurableThread: false }, "not-durable-thread"],
        ["attachment", { hasAttachments: true }, "attachments-present"],
        ["slash command", { utterance: "   /help" }, "slash-prefixed-utterance"],
        ["absent proposal", { selectedProposalTargets: [] }, "proposal-target-missing"],
        [
          "non-unique proposals",
          { selectedProposalTargets: [TARGET, TARGET] },
          "proposal-target-not-unique",
        ],
        [
          "not current proposal",
          {
            selectedProposalTargets: [{ ...TARGET, isCurrent: false }],
          },
          "proposal-target-not-current-latest",
        ],
        [
          "not latest proposal",
          {
            selectedProposalTargets: [{ ...TARGET, isLatest: false }],
          },
          "proposal-target-not-current-latest",
        ],
        ["unsettled proposal", { proposalSettled: false }, "proposal-not-settled"],
        ["non-actionable proposal", { proposalActionable: false }, "proposal-not-actionable"],
        ["unavailable execution", { availability: { canExecute: false } }, "execution-unavailable"],
      ];

    for (const [name, overrides, reason] of cases) {
      const result = stage1(overrides);
      expect(result, name).toEqual({
        eligible: false,
        outcome: "SEND_TO_PROVIDER",
        reason,
      });
    }
  });

  it("returns the selected proposal only when every stage-1 precondition holds", () => {
    expect(stage1()).toEqual({ eligible: true, outcome: null, proposal: PROPOSAL });
    expect(stage1({ utterance: "  Please proceed  " })).toMatchObject({ eligible: true });
  });

  it("preserves all five exact confirmation phrases as the stage-2 fast path", () => {
    for (const phrase of NAVIGATOR_CONFIRMATION_PHRASES) {
      expect(navigatorExecutionStage2FastPath(phrase)).toBe("EXECUTE");
    }
    expect(navigatorExecutionStage2FastPath("yes")).toBeNull();
    expect(navigatorExecutionStage2FastPath("let's do it?")).toBeNull();
  });

  it("only bypasses a missing provider for deterministic outcomes", () => {
    expect(
      navigatorApprovalCanBypassProvider({
        stage1: { ...BASE_STAGE_1_INPUT, utterance: NAVIGATOR_CONFIRMATION_PHRASES[0]! },
        hasArmedQuestion: false,
      }),
    ).toBe(true);
    expect(
      navigatorApprovalCanBypassProvider({
        stage1: { ...BASE_STAGE_1_INPUT, utterance: "sí" },
        hasArmedQuestion: false,
      }),
    ).toBe(true);
    expect(
      navigatorApprovalCanBypassProvider({
        stage1: { ...BASE_STAGE_1_INPUT, utterance: "no" },
        hasArmedQuestion: false,
      }),
    ).toBe(false);
    expect(
      navigatorApprovalCanBypassProvider({
        stage1: { ...BASE_STAGE_1_INPUT, utterance: "no" },
        hasArmedQuestion: true,
      }),
    ).toBe(true);
    expect(
      navigatorApprovalCanBypassProvider({
        stage1: { ...BASE_STAGE_1_INPUT, utterance: "Perfecto, me parece bien." },
        hasArmedQuestion: false,
      }),
    ).toBe(false);
  });

  it("recognizes only the closed known bare response lists", () => {
    for (const affirmation of [...NAVIGATOR_KNOWN_BARE_AFFIRMATIONS, "SÍ!", "OK.", "👍️", "👍🏽!"]) {
      expect(recognizeNavigatorKnownBareResponse(affirmation), affirmation).toBe("affirmation");
    }

    for (const negation of [...NAVIGATOR_KNOWN_BARE_NEGATIONS, "NO!", "Todavía no."]) {
      expect(recognizeNavigatorKnownBareResponse(negation), negation).toBe("negation");
    }

    for (const unknown of ["yes", "okay", "sí?", "¿sí?", "👍?", "not quite"]) {
      expect(recognizeNavigatorKnownBareResponse(unknown), unknown).toBeNull();
    }
  });

  it("resolves known bare responses without accepting a classifier", () => {
    expect(resolveNavigatorKnownBareResponse({ utterance: "sí", hasArmedQuestion: false })).toBe(
      "ASK_EXECUTION_CONFIRMATION",
    );
    expect(resolveNavigatorKnownBareResponse({ utterance: "sí", hasArmedQuestion: true })).toBe(
      "EXECUTE",
    );
    expect(
      resolveNavigatorKnownBareResponse({ utterance: "todavía no", hasArmedQuestion: true }),
    ).toBe("DECLINE_EXECUTION");
    expect(
      resolveNavigatorKnownBareResponse({ utterance: "todavía no", hasArmedQuestion: false }),
    ).toBe("SEND_TO_PROVIDER");
    expect(
      resolveNavigatorKnownBareResponse({
        utterance: "una respuesta distinta",
        hasArmedQuestion: false,
      }),
    ).toBeNull();
  });

  it("keeps stage 4 a permissive cost filter", () => {
    const ownerPositiveExamples = [
      "Perfecto, me parece bien. Puedes empezar.",
      "Listo, aprobado. Dale.",
      "Sí, procede con el plan.",
      "Me convence, adelante con esto.",
      "Todo bien, puedes ejecutarlo.",
    ];

    for (const utterance of ownerPositiveExamples) {
      expect(isNavigatorApprovalClassificationCandidate(utterance), utterance).toBe(true);
    }
    expect(isNavigatorApprovalClassificationCandidate("The repository is large")).toBe(true);
    expect(isNavigatorApprovalClassificationCandidate("   ")).toBe(false);
    expect(
      isNavigatorApprovalClassificationCandidate(
        "🙂".repeat(NAVIGATOR_APPROVAL_CANDIDATE_MAX_CODE_POINTS),
      ),
    ).toBe(true);
    expect(
      isNavigatorApprovalClassificationCandidate(
        "🙂".repeat(NAVIGATOR_APPROVAL_CANDIDATE_MAX_CODE_POINTS + 1),
      ),
    ).toBe(false);
    expect(isNavigatorApprovalClassificationCandidate("Is this ready?")).toBe(false);
    expect(isNavigatorApprovalClassificationCandidate("¿Está listo")).toBe(false);
  });

  it("runs the six stages in order and never classifies deterministic or ineligible input", async () => {
    let classifierCalls = 0;
    const classify = async (): Promise<NavigatorApprovalTraits> => {
      classifierCalls += 1;
      return traits();
    };

    for (const overrides of [
      { purpose: "coding" as const },
      { isDurableThread: false },
      { hasAttachments: true },
      { utterance: "  /help" },
      { selectedProposalTargets: [] },
      { proposalSettled: false },
      { proposalActionable: false },
      { availability: { canExecute: false } },
    ]) {
      const result = await resolveNavigatorApprovalGate({
        ...BASE_STAGE_1_INPUT,
        ...overrides,
        hasArmedQuestion: false,
        classify,
      });
      expect(result.outcome).toBe("SEND_TO_PROVIDER");
    }
    expect(classifierCalls).toBe(0);

    for (const phrase of NAVIGATOR_CONFIRMATION_PHRASES) {
      const result = await resolveNavigatorApprovalGate({
        ...BASE_STAGE_1_INPUT,
        utterance: phrase,
        hasArmedQuestion: false,
        classify,
      });
      expect(result.outcome).toBe("EXECUTE");
    }
    expect(classifierCalls).toBe(0);

    expect(
      await resolveNavigatorApprovalGate({
        ...BASE_STAGE_1_INPUT,
        utterance: "sí",
        hasArmedQuestion: false,
        classify: async () => {
          throw new Error("classifier unavailable");
        },
      }),
    ).toMatchObject({ outcome: "ASK_EXECUTION_CONFIRMATION" });
    expect(classifierCalls).toBe(0);

    expect(
      await resolveNavigatorApprovalGate({
        ...BASE_STAGE_1_INPUT,
        utterance: "?",
        hasArmedQuestion: false,
        classify,
      }),
    ).toMatchObject({ outcome: "SEND_TO_PROVIDER" });
    expect(classifierCalls).toBe(0);

    expect(navigatorExecutionStage4CandidateFilter("unrelated short statement")).toBe(true);
  });

  it("classifies natural approval candidates exactly once and keeps the model trait-only", async () => {
    const positiveExamples = [
      "Perfecto, me parece bien. Puedes empezar.",
      "Listo, aprobado. Dale.",
      "Sí, procede con el plan.",
      "Me convence, adelante con esto.",
      "Todo bien, puedes ejecutarlo.",
    ];
    let classifierCalls = 0;
    for (const utterance of positiveExamples) {
      const result = await resolveNavigatorApprovalGate({
        ...BASE_STAGE_1_INPUT,
        utterance,
        hasArmedQuestion: false,
        classify: async () => {
          classifierCalls += 1;
          return traits();
        },
      });
      expect(result.outcome, utterance).toBe("EXECUTE");
    }
    expect(classifierCalls).toBe(positiveExamples.length);

    expect(
      await resolveNavigatorApprovalGate({
        ...BASE_STAGE_1_INPUT,
        utterance: "An ambiguous approval candidate",
        hasArmedQuestion: false,
        classify: async () => ({ expressesApproval: true }) as NavigatorApprovalTraits,
      }),
    ).toMatchObject({ outcome: "SEND_TO_PROVIDER" });

    for (const key of DIRECT_DISQUALIFIERS) {
      const result = await resolveNavigatorApprovalGate({
        ...BASE_STAGE_1_INPUT,
        utterance: "It seems okay, but read this first.",
        hasArmedQuestion: false,
        classify: async () => traits({ [key]: true }),
      });
      expect(result.outcome, key).toBe("SEND_TO_PROVIDER");
    }
  });

  it("uses armed authority only after a semantic bare-affirmation trait", async () => {
    const classify = async () => traits({ isBareAffirmation: true });
    expect(
      await resolveNavigatorApprovalGate({
        ...BASE_STAGE_1_INPUT,
        utterance: "yes",
        hasArmedQuestion: false,
        classify,
      }),
    ).toMatchObject({ outcome: "ASK_EXECUTION_CONFIRMATION" });
    expect(
      await resolveNavigatorApprovalGate({
        ...BASE_STAGE_1_INPUT,
        utterance: "yes",
        hasArmedQuestion: true,
        classify,
      }),
    ).toMatchObject({ outcome: "EXECUTE" });

    for (const classifyFailure of [
      async () => null,
      async () => {
        throw new Error("timeout");
      },
    ]) {
      expect(
        await resolveNavigatorApprovalGate({
          ...BASE_STAGE_1_INPUT,
          utterance: "sí",
          hasArmedQuestion: false,
          classify: classifyFailure,
        }),
      ).toMatchObject({ outcome: "ASK_EXECUTION_CONFIRMATION" });
    }
  });
});

function traits(overrides: Partial<NavigatorApprovalTraits> = {}): NavigatorApprovalTraits {
  return {
    expressesApproval: true,
    addsCondition: false,
    requestsModification: false,
    asksQuestion: false,
    expressesDoubt: false,
    isNegation: false,
    isQuotationOrHypothetical: false,
    referencesSomethingElse: false,
    isBareAffirmation: false,
    confidence: "high",
    ...overrides,
  };
}

const DIRECT_DISQUALIFIERS = [
  "addsCondition",
  "requestsModification",
  "asksQuestion",
  "expressesDoubt",
  "isNegation",
  "isQuotationOrHypothetical",
  "referencesSomethingElse",
] as const satisfies ReadonlyArray<keyof NavigatorApprovalTraits>;

describe("combineNavigatorApprovalTraits", () => {
  it("applies the exhaustive fail-closed policy table", () => {
    const allDisqualifiers = traits({
      addsCondition: true,
      requestsModification: true,
      asksQuestion: true,
      expressesDoubt: true,
      isNegation: true,
      isQuotationOrHypothetical: true,
      referencesSomethingElse: true,
    });
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly traits: NavigatorApprovalTraits;
      readonly hasArmedQuestion: boolean;
      readonly expected: NavigatorExecutionOutcome;
    }> = [
      {
        name: "direct high-confidence approval",
        traits: traits(),
        hasArmedQuestion: false,
        expected: "EXECUTE",
      },
      {
        name: "direct approval with armed question",
        traits: traits(),
        hasArmedQuestion: true,
        expected: "EXECUTE",
      },
      ...DIRECT_DISQUALIFIERS.map((key) => ({
        name: `direct approval + ${key}`,
        traits: traits({ [key]: true }),
        hasArmedQuestion: false,
        expected: "SEND_TO_PROVIDER" as const,
      })),
      {
        name: "all disqualifiers together",
        traits: allDisqualifiers,
        hasArmedQuestion: false,
        expected: "SEND_TO_PROVIDER",
      },
      {
        name: "low confidence",
        traits: traits({ confidence: "low" }),
        hasArmedQuestion: false,
        expected: "SEND_TO_PROVIDER",
      },
      {
        name: "bare affirmation without authority",
        traits: traits({ isBareAffirmation: true }),
        hasArmedQuestion: false,
        expected: "ASK_EXECUTION_CONFIRMATION",
      },
      {
        name: "bare affirmation with authority",
        traits: traits({ isBareAffirmation: true }),
        hasArmedQuestion: true,
        expected: "EXECUTE",
      },
      {
        name: "bare affirmation + approval without authority",
        traits: traits({ isBareAffirmation: true, expressesApproval: true }),
        hasArmedQuestion: false,
        expected: "ASK_EXECUTION_CONFIRMATION",
      },
      {
        name: "bare affirmation contradictory to approval",
        traits: traits({ isBareAffirmation: true, expressesApproval: false }),
        hasArmedQuestion: true,
        expected: "SEND_TO_PROVIDER",
      },
      {
        name: "bare affirmation contradicting approval without authority",
        traits: traits({ isBareAffirmation: true, expressesApproval: false }),
        hasArmedQuestion: false,
        expected: "SEND_TO_PROVIDER",
      },
      ...DIRECT_DISQUALIFIERS.map((key) => ({
        name: `bare affirmation + ${key}`,
        traits: traits({ isBareAffirmation: true, [key]: true }),
        hasArmedQuestion: true,
        expected: "SEND_TO_PROVIDER" as const,
      })),
      {
        name: "pure negation without authority",
        traits: traits({ expressesApproval: false, isNegation: true }),
        hasArmedQuestion: false,
        expected: "SEND_TO_PROVIDER",
      },
      {
        name: "pure negation with authority",
        traits: traits({ expressesApproval: false, isNegation: true }),
        hasArmedQuestion: true,
        expected: "DECLINE_EXECUTION",
      },
      {
        name: "negation contradicting approval",
        traits: traits({ isNegation: true }),
        hasArmedQuestion: true,
        expected: "SEND_TO_PROVIDER",
      },
      {
        name: "negation contradicting bare affirmation",
        traits: traits({ expressesApproval: false, isNegation: true, isBareAffirmation: true }),
        hasArmedQuestion: true,
        expected: "SEND_TO_PROVIDER",
      },
      {
        name: "negation plus condition is high risk",
        traits: traits({ expressesApproval: false, isNegation: true, addsCondition: true }),
        hasArmedQuestion: true,
        expected: "SEND_TO_PROVIDER",
      },
      {
        name: "contradictory record with every flag",
        traits: allDisqualifiers,
        hasArmedQuestion: true,
        expected: "SEND_TO_PROVIDER",
      },
    ];

    for (const testCase of cases) {
      expect(
        combineNavigatorApprovalTraits({
          traits: testCase.traits,
          hasArmedQuestion: testCase.hasArmedQuestion,
        }),
        testCase.name,
      ).toBe(testCase.expected);
    }
  });
});

const AUTHORITY_A: Omit<NavigatorArmedQuestion, "askedAt"> = {
  threadId: THREAD_A,
  proposalId: PROPOSAL_A,
  fingerprint: FINGERPRINT_A,
};

function currentProposal(overrides: Partial<typeof AUTHORITY_A> = {}): typeof AUTHORITY_A {
  return { ...AUTHORITY_A, ...overrides };
}

describe("createNavigatorArmedQuestionStore", () => {
  it("isolates records by thread and replaces the older question for a thread", () => {
    const store = createNavigatorArmedQuestionStore(() => 1_000);
    store.arm(AUTHORITY_A);

    expect(
      store.read({
        threadId: THREAD_B,
        proposalId: PROPOSAL_A,
        fingerprint: FINGERPRINT_A,
      }),
    ).toBeNull();
    expect(store.read(currentProposal())).not.toBeNull();

    const replacement = currentProposal({ proposalId: PROPOSAL_B, fingerprint: FINGERPRINT_B });
    store.arm(replacement);
    expect(store.read(replacement)).toMatchObject({
      threadId: THREAD_A,
      proposalId: PROPOSAL_B,
      fingerprint: FINGERPRINT_B,
      askedAt: 1_000,
    });
    expect(Object.keys(store.read(replacement) ?? {}).toSorted()).toEqual([
      "askedAt",
      "fingerprint",
      "proposalId",
      "threadId",
    ]);
  });

  it("validates proposal and fingerprint on read and use, deleting stale authority", () => {
    const staleProposalStore = createNavigatorArmedQuestionStore(() => 1_000);
    staleProposalStore.arm(AUTHORITY_A);
    expect(staleProposalStore.read(currentProposal({ proposalId: PROPOSAL_B }))).toBeNull();
    expect(staleProposalStore.read(currentProposal())).toBeNull();

    const staleFingerprintStore = createNavigatorArmedQuestionStore(() => 1_000);
    staleFingerprintStore.arm(AUTHORITY_A);
    expect(
      staleFingerprintStore.complete({
        ...currentProposal({ fingerprint: FINGERPRINT_B }),
        outcome: "EXECUTE",
      }),
    ).toBe(false);
    expect(staleFingerprintStore.read(currentProposal())).toBeNull();
  });

  it("consumes authority exactly once for every final outcome", () => {
    const outcomes: ReadonlyArray<NavigatorExecutionOutcome> = [
      "EXECUTE",
      "ASK_EXECUTION_CONFIRMATION",
      "DECLINE_EXECUTION",
      "SEND_TO_PROVIDER",
    ];

    for (const outcome of outcomes) {
      const store = createNavigatorArmedQuestionStore(() => 1_000);
      store.arm(AUTHORITY_A);
      expect(store.complete({ ...currentProposal(), outcome }), outcome).toBe(true);
      expect(store.read(currentProposal())).toBeNull();
      expect(store.complete({ ...currentProposal(), outcome })).toBe(false);
    }
  });

  it("invalidates on navigation and a fresh store represents reload", () => {
    const store = createNavigatorArmedQuestionStore(() => 1_000);
    store.arm(AUTHORITY_A);
    store.invalidateThread(THREAD_A);
    expect(store.read(currentProposal())).toBeNull();

    const reloadedStore = createNavigatorArmedQuestionStore(() => 1_000);
    expect(reloadedStore.read(currentProposal())).toBeNull();
  });

  it("expires at the 120-second TTL boundary", () => {
    let now = 10_000;
    const store = createNavigatorArmedQuestionStore(() => now);
    store.arm(AUTHORITY_A);

    now += NAVIGATOR_ARMED_QUESTION_TTL_MS - 1;
    expect(store.read(currentProposal())).not.toBeNull();
    now += 1;
    expect(store.read(currentProposal())).toBeNull();
  });

  it("invalidates only for provider turns that started strictly after the question", () => {
    let now = 1_000;
    const store = createNavigatorArmedQuestionStore(() => now);
    store.arm(AUTHORITY_A);

    now = 1_001;
    store.invalidateForProviderTurn({ threadId: THREAD_A, startedAt: 999 });
    expect(store.read(currentProposal())).not.toBeNull();

    store.invalidateForProviderTurn({ threadId: THREAD_A, startedAt: 1_000 });
    expect(store.read(currentProposal())).not.toBeNull();

    store.invalidateForProviderTurn({ threadId: THREAD_A, startedAt: 1_001 });
    expect(store.read(currentProposal())).toBeNull();
  });
});
