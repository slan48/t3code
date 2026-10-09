/**
 * Pure deterministic stages for the Navigator approval gate.
 *
 * This module deliberately has no React, RPC, classifier, or persistence
 * dependency. The model only describes schema-validated traits; deterministic
 * code below combines those traits with the armed authority and chooses the
 * final outcome.
 */
import { NavigatorApprovalTraits as NavigatorApprovalTraitsSchema } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type {
  NavigatorApprovalTraits,
  OrchestrationProposedPlanId,
  PeerLoopProposalFingerprint,
  ThreadId,
  ThreadPurpose,
} from "@t3tools/contracts";

import {
  isNavigatorExecutionConfirmation,
  normalizeConfirmationText,
} from "./navigatorConfirmation";
import type { ExecutableProposal, ExecuteProposalAvailability } from "./navigatorExecution";
import {
  isNavigatorApprovalClassificationCandidate,
  NAVIGATOR_APPROVAL_CANDIDATE_MAX_CODE_POINTS,
} from "@t3tools/shared/navigatorApprovalCandidate";

export { isNavigatorApprovalClassificationCandidate, NAVIGATOR_APPROVAL_CANDIDATE_MAX_CODE_POINTS };

const isNavigatorApprovalTraits = Schema.is(NavigatorApprovalTraitsSchema);

/** The only final outcomes the deterministic gate may produce. */
export type NavigatorExecutionOutcome =
  | "EXECUTE"
  | "ASK_EXECUTION_CONFIRMATION"
  | "DECLINE_EXECUTION"
  | "SEND_TO_PROVIDER";

/* -------------------------------------------------------------- stage 1 */

export interface NavigatorExecutionProposalTarget {
  readonly proposal: ExecutableProposal;
  readonly isCurrent: boolean;
  readonly isLatest: boolean;
}

export type NavigatorExecutionEligibilityFailureReason =
  | "not-navigator-purpose"
  | "not-durable-thread"
  | "attachments-present"
  | "slash-prefixed-utterance"
  | "proposal-target-missing"
  | "proposal-target-not-unique"
  | "proposal-target-not-current-latest"
  | "proposal-not-settled"
  | "proposal-not-actionable"
  | "execution-unavailable";

export interface NavigatorExecutionStage1Input {
  readonly purpose: ThreadPurpose | undefined;
  readonly isDurableThread: boolean;
  readonly hasAttachments: boolean;
  readonly utterance: string;
  /** The selected target(s), after the caller's current/latest selection step. */
  readonly selectedProposalTargets: ReadonlyArray<NavigatorExecutionProposalTarget>;
  readonly proposalSettled: boolean;
  readonly proposalActionable: boolean;
  readonly availability: Pick<ExecuteProposalAvailability, "canExecute">;
}

export type NavigatorExecutionStage1Result =
  | {
      readonly eligible: true;
      readonly outcome: null;
      readonly proposal: ExecutableProposal;
    }
  | {
      readonly eligible: false;
      readonly outcome: "SEND_TO_PROVIDER";
      readonly reason: NavigatorExecutionEligibilityFailureReason;
    };

const sendToProvider = (
  reason: NavigatorExecutionEligibilityFailureReason,
): NavigatorExecutionStage1Result => ({
  eligible: false,
  outcome: "SEND_TO_PROVIDER",
  reason,
});

/**
 * Stage 1: prove that this utterance is even eligible for the approval gate.
 * A failed precondition is an ordinary provider send, and `eligible: false`
 * tells a caller it may skip every later stage, including classification.
 */
export function navigatorExecutionStage1(
  input: NavigatorExecutionStage1Input,
): NavigatorExecutionStage1Result {
  if (input.purpose !== "navigator") return sendToProvider("not-navigator-purpose");
  if (!input.isDurableThread) return sendToProvider("not-durable-thread");
  if (input.hasAttachments) return sendToProvider("attachments-present");
  if (input.utterance.trimStart().startsWith("/")) {
    return sendToProvider("slash-prefixed-utterance");
  }
  if (input.selectedProposalTargets.length === 0) {
    return sendToProvider("proposal-target-missing");
  }
  if (input.selectedProposalTargets.length !== 1) {
    return sendToProvider("proposal-target-not-unique");
  }

  const target = input.selectedProposalTargets[0];
  if (!target || !target.isCurrent || !target.isLatest) {
    return sendToProvider("proposal-target-not-current-latest");
  }
  if (!input.proposalSettled) return sendToProvider("proposal-not-settled");
  if (!input.proposalActionable) return sendToProvider("proposal-not-actionable");
  if (!input.availability.canExecute) return sendToProvider("execution-unavailable");

  return { eligible: true, outcome: null, proposal: target.proposal };
}

/* -------------------------------------------------------------- stage 2 */

/** Stage 2: preserve the existing five-phrase exact confirmation fast path. */
export function navigatorExecutionStage2FastPath(
  utterance: string,
): NavigatorExecutionOutcome | null {
  return isNavigatorExecutionConfirmation(utterance) ? "EXECUTE" : null;
}

/* -------------------------------------------------------------- stage 3 */

export type NavigatorKnownBareResponse = "affirmation" | "negation" | null;

/**
 * These are canonical values after `normalizeConfirmationText`. Accents are
 * intentionally represented by their normalized `si` form; no English
 * synonym is included. Skin-tone variants are the closed Unicode modifiers
 * for the single thumbs-up meaning.
 */
const KNOWN_BARE_AFFIRMATIONS: ReadonlySet<string> = new Set([
  "si",
  "ok",
  "vale",
  "👍",
  "👍🏻",
  "👍🏼",
  "👍🏽",
  "👍🏾",
  "👍🏿",
]);

const KNOWN_BARE_NEGATIONS: ReadonlySet<string> = new Set(["no", "nope", "todavia no"]);

export const NAVIGATOR_KNOWN_BARE_AFFIRMATIONS: ReadonlyArray<string> = [
  ...KNOWN_BARE_AFFIRMATIONS,
];
export const NAVIGATOR_KNOWN_BARE_NEGATIONS: ReadonlyArray<string> = [...KNOWN_BARE_NEGATIONS];

/** Recognize only the closed, whole-utterance bare response vocabulary. */
export function recognizeNavigatorKnownBareResponse(utterance: string): NavigatorKnownBareResponse {
  // Unlike terminal punctuation, a question mark is never harmless here.
  if (utterance.includes("?") || utterance.includes("¿")) return null;

  const normalized = normalizeConfirmationText(utterance);
  if (KNOWN_BARE_AFFIRMATIONS.has(normalized)) return "affirmation";
  if (KNOWN_BARE_NEGATIONS.has(normalized)) return "negation";
  return null;
}

const knownBareAffirmationTraits = (): NavigatorApprovalTraits => ({
  expressesApproval: true,
  addsCondition: false,
  requestsModification: false,
  asksQuestion: false,
  expressesDoubt: false,
  isNegation: false,
  isQuotationOrHypothetical: false,
  referencesSomethingElse: false,
  isBareAffirmation: true,
  confidence: "high",
});

const knownBareNegationTraits = (): NavigatorApprovalTraits => ({
  expressesApproval: false,
  addsCondition: false,
  requestsModification: false,
  asksQuestion: false,
  expressesDoubt: false,
  isNegation: true,
  isQuotationOrHypothetical: false,
  referencesSomethingElse: false,
  isBareAffirmation: false,
  confidence: "high",
});

/**
 * Resolve a known bare response without a classifier. `sí` therefore becomes
 * an explicit confirmation question when no armed authority exists.
 */
export function resolveNavigatorKnownBareResponse(input: {
  readonly utterance: string;
  readonly hasArmedQuestion: boolean;
}): NavigatorExecutionOutcome | null {
  const response = recognizeNavigatorKnownBareResponse(input.utterance);
  if (response === null) return null;

  return combineNavigatorApprovalTraits({
    traits: response === "affirmation" ? knownBareAffirmationTraits() : knownBareNegationTraits(),
    hasArmedQuestion: input.hasArmedQuestion,
  });
}

/**
 * Decide whether the composer may submit without a conversation provider.
 * Exact phrases and known bare affirmations/armed negations are deterministic
 * actions; a natural-language candidate must remain blocked when its required
 * SEND_TO_PROVIDER fallback cannot be delivered.
 */
export function navigatorApprovalCanBypassProvider(input: {
  readonly stage1: NavigatorExecutionStage1Input;
  readonly hasArmedQuestion: boolean;
}): boolean {
  if (!navigatorExecutionStage1(input.stage1).eligible) return false;
  if (navigatorExecutionStage2FastPath(input.stage1.utterance) !== null) return true;
  const knownResponse = recognizeNavigatorKnownBareResponse(input.stage1.utterance);
  return (
    knownResponse === "affirmation" || (knownResponse === "negation" && input.hasArmedQuestion)
  );
}

/* -------------------------------------------------------------- stage 4 */

/**
 * Stage 4: a permissive cost filter only. It deliberately has no vocabulary,
 * language, sentiment, proposal, or approval-word knowledge.
 */
export function navigatorExecutionStage4CandidateFilter(utterance: string): boolean {
  return isNavigatorApprovalClassificationCandidate(utterance);
}

/* -------------------------------------------------------------- stage 6 */

const APPROVAL_DISQUALIFIERS = [
  "addsCondition",
  "requestsModification",
  "asksQuestion",
  "expressesDoubt",
  "isNegation",
  "isQuotationOrHypothetical",
  "referencesSomethingElse",
] as const satisfies ReadonlyArray<keyof NavigatorApprovalTraits>;

function hasApprovalDisqualifier(traits: NavigatorApprovalTraits): boolean {
  return APPROVAL_DISQUALIFIERS.some((key) => traits[key]);
}

/**
 * Stage 6: combine only decoded traits and armed-question authority.
 * Contradiction and uncertainty always fail closed.
 */
export function combineNavigatorApprovalTraits(input: {
  readonly traits: NavigatorApprovalTraits;
  readonly hasArmedQuestion: boolean;
}): NavigatorExecutionOutcome {
  const { traits } = input;
  const hasDisqualifier = hasApprovalDisqualifier(traits);
  const contradictoryNegation =
    traits.isNegation &&
    (traits.expressesApproval ||
      traits.addsCondition ||
      traits.requestsModification ||
      traits.asksQuestion ||
      traits.expressesDoubt ||
      traits.isQuotationOrHypothetical ||
      traits.referencesSomethingElse ||
      traits.isBareAffirmation ||
      traits.confidence !== "high");

  if (input.hasArmedQuestion && traits.isNegation) {
    return contradictoryNegation ? "SEND_TO_PROVIDER" : "DECLINE_EXECUTION";
  }

  // Bare affirmation is checked before direct approval. This prevents a model
  // record carrying both `expressesApproval` and `isBareAffirmation` from
  // executing without the explicit T3 question that gave it an object.
  if (traits.isBareAffirmation) {
    if (hasDisqualifier || traits.confidence !== "high" || !traits.expressesApproval) {
      return "SEND_TO_PROVIDER";
    }
    if (!input.hasArmedQuestion) return "ASK_EXECUTION_CONFIRMATION";
    return "EXECUTE";
  }

  if (traits.expressesApproval && traits.confidence === "high" && !hasDisqualifier) {
    return "EXECUTE";
  }

  return "SEND_TO_PROVIDER";
}

/* ------------------------------------------------------ stage orchestration */

export interface NavigatorApprovalGateInput extends NavigatorExecutionStage1Input {
  readonly hasArmedQuestion: boolean;
  /** Returns decoded traits only; it cannot choose an execution outcome. */
  readonly classify: () => Promise<NavigatorApprovalTraits | null>;
  /** Called synchronously only after stages 1–4 pass, immediately before RPC. */
  readonly onClassificationStarted?: () => void;
}

export interface NavigatorApprovalGateResult {
  readonly outcome: NavigatorExecutionOutcome;
  readonly proposal: ExecutableProposal | null;
}

/**
 * Run the six stages in order. The callback is reached at most once, and only
 * after deterministic eligibility, fast paths, and the permissive cost filter
 * pass. Any classifier uncertainty is the ordinary provider path.
 */
export async function resolveNavigatorApprovalGate(
  input: NavigatorApprovalGateInput,
): Promise<NavigatorApprovalGateResult> {
  const stage1 = navigatorExecutionStage1(input);
  if (!stage1.eligible) {
    return { outcome: "SEND_TO_PROVIDER", proposal: null };
  }

  const fastPath = navigatorExecutionStage2FastPath(input.utterance);
  if (fastPath !== null) {
    return { outcome: fastPath, proposal: stage1.proposal };
  }

  const knownResponse = resolveNavigatorKnownBareResponse({
    utterance: input.utterance,
    hasArmedQuestion: input.hasArmedQuestion,
  });
  if (knownResponse !== null) {
    return { outcome: knownResponse, proposal: stage1.proposal };
  }

  if (!navigatorExecutionStage4CandidateFilter(input.utterance)) {
    return { outcome: "SEND_TO_PROVIDER", proposal: stage1.proposal };
  }

  input.onClassificationStarted?.();
  let classifiedTraits: NavigatorApprovalTraits | null;
  try {
    classifiedTraits = await input.classify();
  } catch {
    classifiedTraits = null;
  }
  if (classifiedTraits === null || !isNavigatorApprovalTraits(classifiedTraits)) {
    return { outcome: "SEND_TO_PROVIDER", proposal: stage1.proposal };
  }

  return {
    outcome: combineNavigatorApprovalTraits({
      traits: classifiedTraits,
      hasArmedQuestion: input.hasArmedQuestion,
    }),
    proposal: stage1.proposal,
  };
}

/* ---------------------------------------------- submission serialization */

/**
 * A synchronous whole-gate claim for one mounted composer interaction.
 *
 * This is intentionally separate from the visible classifier-pending state:
 * exact phrases and known bare responses also need a claim before their first
 * await, while ordinary provider sends remain outside the approval gate.
 */
export interface NavigatorApprovalSubmissionLock {
  /** Claim the gate before starting any asynchronous stage. */
  tryAcquire(): boolean;
  /** Release is idempotent so route cleanup and the request owner may race. */
  release(): void;
  isLocked(): boolean;
}

export function createNavigatorApprovalSubmissionLock(): NavigatorApprovalSubmissionLock {
  let locked = false;
  return {
    tryAcquire: () => {
      if (locked) return false;
      locked = true;
      return true;
    },
    release: () => {
      locked = false;
    },
    isLocked: () => locked,
  };
}

/**
 * Evaluate stage 1 and, when eligible, claim the mounted whole-gate lock in
 * the same synchronous operation. Callers must do this before their first
 * await; an ineligible ordinary message never claims the approval lock.
 */
export function claimNavigatorApprovalSubmission(input: {
  readonly stage1: NavigatorExecutionStage1Input;
  readonly lock: NavigatorApprovalSubmissionLock;
}): {
  readonly stage1: NavigatorExecutionStage1Result;
  readonly lockHeld: boolean;
} {
  const stage1 = navigatorExecutionStage1(input.stage1);
  return {
    stage1,
    lockHeld: stage1.eligible ? input.lock.tryAcquire() : false,
  };
}

/* ----------------------------------------------- in-memory armed authority */

export const NAVIGATOR_ARMED_QUESTION_TTL_MS = 120_000;

/** The complete armed-question record, with no message or draft dependency. */
export interface NavigatorArmedQuestion {
  readonly threadId: ThreadId;
  readonly proposalId: OrchestrationProposedPlanId;
  readonly fingerprint: PeerLoopProposalFingerprint;
  readonly askedAt: number;
}

interface CurrentNavigatorProposal {
  readonly threadId: ThreadId;
  readonly proposalId: OrchestrationProposedPlanId;
  readonly fingerprint: PeerLoopProposalFingerprint;
}

export interface NavigatorArmedQuestionStore {
  arm(input: Omit<NavigatorArmedQuestion, "askedAt">): NavigatorArmedQuestion;
  read(input: CurrentNavigatorProposal): NavigatorArmedQuestion | null;
  complete(
    input: CurrentNavigatorProposal & { readonly outcome: NavigatorExecutionOutcome },
  ): boolean;
  invalidateThread(threadId: ThreadId): void;
  invalidateForProviderTurn(input: {
    readonly threadId: ThreadId;
    readonly startedAt: number;
  }): void;
}

/** Make a fresh, reload-empty, in-memory armed-question authority. */
export function createNavigatorArmedQuestionStore(
  now: () => number = () => Date.now(),
): NavigatorArmedQuestionStore {
  const records = new Map<ThreadId, NavigatorArmedQuestion>();

  const isExpired = (record: NavigatorArmedQuestion): boolean =>
    now() - record.askedAt >= NAVIGATOR_ARMED_QUESTION_TTL_MS;

  const read = (input: CurrentNavigatorProposal): NavigatorArmedQuestion | null => {
    const record = records.get(input.threadId);
    if (
      record === undefined ||
      isExpired(record) ||
      record.proposalId !== input.proposalId ||
      record.fingerprint !== input.fingerprint
    ) {
      if (record !== undefined) records.delete(input.threadId);
      return null;
    }
    return record;
  };

  return {
    arm: (input) => {
      const record: NavigatorArmedQuestion = {
        threadId: input.threadId,
        proposalId: input.proposalId,
        fingerprint: input.fingerprint,
        askedAt: now(),
      };
      records.set(input.threadId, record);
      return record;
    },
    read,
    complete: (input) => {
      // `outcome` is deliberately accepted for all four final outcomes, but
      // consuming authority is the same regardless of which one was chosen.
      const record = read(input);
      if (record === null) return false;
      records.delete(input.threadId);
      return true;
    },
    invalidateThread: (threadId) => {
      records.delete(threadId);
    },
    invalidateForProviderTurn: ({ threadId, startedAt }) => {
      const record = records.get(threadId);
      if (record === undefined) return;
      if (isExpired(record) || startedAt > record.askedAt) {
        records.delete(threadId);
      }
    },
  };
}
