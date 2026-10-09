import type { ThreadId } from "@t3tools/contracts";

import type {
  NavigatorArmedQuestion,
  NavigatorArmedQuestionStore,
  NavigatorExecutionOutcome,
  NavigatorApprovalGateResult,
  NavigatorExecutionStage1Result,
} from "./navigatorApprovalGate";
import type { ExecutableProposal } from "./navigatorExecution";

export type NavigatorApprovalTarget = Omit<NavigatorArmedQuestion, "askedAt">;

/** Route identity for a captured submission; proposal changes are separate. */
export function isNavigatorApprovalContinuationCurrent(input: {
  readonly submittedEnvironmentId: string;
  readonly submittedThreadId: string;
  readonly currentEnvironmentId: string;
  readonly currentThreadId: string;
}): boolean {
  return (
    input.submittedEnvironmentId === input.currentEnvironmentId &&
    input.submittedThreadId === input.currentThreadId
  );
}

export interface NavigatorApprovalInteractionInput {
  readonly result: NavigatorApprovalGateResult;
  readonly targetAtSend: NavigatorApprovalTarget | null;
  readonly currentTarget: NavigatorApprovalTarget | null;
  /** False when the proposal changed at any point during this submission. */
  readonly targetVersionUnchanged: boolean;
  /** Re-check stage-1 eligibility after an asynchronous classifier returns. */
  readonly currentStage1Eligible: boolean;
  readonly armedAtSend: NavigatorArmedQuestion | null;
  readonly threadId: ThreadId | null;
  readonly store: NavigatorArmedQuestionStore;
  readonly submittedText: string;
  readonly clearComposer: () => void;
  readonly clearTransient: () => void;
  readonly armQuestion: (target: NavigatorApprovalTarget) => void;
  readonly showDeclined: () => void;
  readonly execute: (proposal: ExecutableProposal, ownerApprovalText: string) => Promise<unknown>;
}

function sameTarget(
  left: NavigatorApprovalTarget | null,
  right: NavigatorApprovalTarget | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.threadId === right.threadId &&
    left.proposalId === right.proposalId &&
    left.fingerprint === right.fingerprint
  );
}

function consumeAuthority(
  input: NavigatorApprovalInteractionInput,
  outcome: NavigatorExecutionOutcome,
): void {
  if (input.targetAtSend !== null) {
    input.store.complete({ ...input.targetAtSend, outcome });
  } else if (input.threadId !== null) {
    input.store.invalidateThread(input.threadId);
  }
}

/**
 * Consume a mounted question before the ordinary provider path when stage 1
 * is already known to be ineligible. This must stay synchronous: an ordinary
 * message should not cross an approval-gate await just to rediscover that it
 * cannot be classified, or two same-tick provider submissions can pass the
 * existing send guard together.
 */
export function consumeNavigatorApprovalForIneligibleSubmission(input: {
  readonly stage1: NavigatorExecutionStage1Result;
  readonly targetAtSend: NavigatorApprovalTarget | null;
  readonly threadId: ThreadId | null;
  readonly store: NavigatorArmedQuestionStore;
  readonly hasTransientQuestion: boolean;
  readonly clearTransient: () => void;
}): void {
  if (input.stage1.eligible) return;
  if (input.targetAtSend !== null) {
    input.store.complete({ ...input.targetAtSend, outcome: "SEND_TO_PROVIDER" });
  } else if (input.threadId !== null) {
    input.store.invalidateThread(input.threadId);
  }
  if (input.hasTransientQuestion) input.clearTransient();
}

/**
 * Apply one deterministic final outcome to the mounted composer interaction.
 * A changed proposal is treated as SEND_TO_PROVIDER, never as permission to
 * execute the stale result. Every outcome consumes any authority present at
 * submission time; ASK may then create the replacement question.
 */
export async function applyNavigatorApprovalOutcome(
  input: NavigatorApprovalInteractionInput,
): Promise<boolean> {
  const targetStillCurrent =
    input.targetVersionUnchanged &&
    input.currentStage1Eligible &&
    sameTarget(input.targetAtSend, input.currentTarget);
  let outcome = input.result.outcome;
  if (!targetStillCurrent && outcome !== "SEND_TO_PROVIDER") {
    outcome = "SEND_TO_PROVIDER";
  }

  if (outcome === "EXECUTE" && input.result.proposal !== null && targetStillCurrent) {
    if (
      input.armedAtSend !== null &&
      input.targetAtSend !== null &&
      !input.store.complete({ ...input.targetAtSend, outcome: "EXECUTE" })
    ) {
      outcome = "SEND_TO_PROVIDER";
    } else {
      input.clearTransient();
      input.clearComposer();
      await input.execute(input.result.proposal, input.submittedText);
      return true;
    }
  }
  if (outcome === "EXECUTE") outcome = "SEND_TO_PROVIDER";

  if (outcome === "ASK_EXECUTION_CONFIRMATION" && targetStillCurrent) {
    if (
      input.armedAtSend !== null &&
      input.targetAtSend !== null &&
      !input.store.complete({ ...input.targetAtSend, outcome: "ASK_EXECUTION_CONFIRMATION" })
    ) {
      outcome = "SEND_TO_PROVIDER";
    } else if (input.targetAtSend !== null) {
      input.clearComposer();
      input.armQuestion(input.targetAtSend);
      return true;
    }
  }
  if (outcome === "ASK_EXECUTION_CONFIRMATION") outcome = "SEND_TO_PROVIDER";

  if (outcome === "DECLINE_EXECUTION" && targetStillCurrent && input.armedAtSend !== null) {
    if (
      input.targetAtSend !== null &&
      input.store.complete({ ...input.targetAtSend, outcome: "DECLINE_EXECUTION" })
    ) {
      input.clearComposer();
      input.showDeclined();
      return true;
    }
    outcome = "SEND_TO_PROVIDER";
  }
  if (outcome === "DECLINE_EXECUTION") outcome = "SEND_TO_PROVIDER";

  // The ordinary provider path is the only caller that returns false. Its
  // captured text and attachments remain untouched by this helper.
  if (outcome === "SEND_TO_PROVIDER") {
    consumeAuthority(input, "SEND_TO_PROVIDER");
    input.clearTransient();
  }
  return false;
}

/**
 * Apply the strict provider-start invalidation rule while keeping the
 * transient question visible when a target is temporarily not stage-1
 * eligible. Proposal-version invalidation is handled separately by the
 * mounted interaction, so this helper only answers the provider-turn event.
 */
export function syncNavigatorApprovalProviderTurn(input: {
  readonly store: NavigatorArmedQuestionStore;
  readonly threadId: ThreadId;
  readonly target: NavigatorApprovalTarget | null;
  readonly startedAt: number;
  readonly questionVisible: boolean;
}): boolean {
  input.store.invalidateForProviderTurn({
    threadId: input.threadId,
    startedAt: input.startedAt,
  });
  if (!input.questionVisible || input.target === null) return input.questionVisible;
  return input.store.read(input.target) !== null;
}
