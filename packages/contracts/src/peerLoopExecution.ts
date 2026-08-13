/**
 * Executing one agreed Navigator Execution Proposal as a Peer Loop run.
 *
 * This is the contract for a *coordination* operation, not a second way to
 * start a run. `peerLoop.startRun` still exists and still takes a project path
 * and an objective; this one takes a thread and a proposal, and the server
 * derives everything else from its own read model. That is the whole point:
 * the objective is the proposal the owner already agreed to, and a client
 * cannot substitute a different one.
 *
 * WHAT A CLIENT DELIBERATELY CANNOT SEND:
 *
 *   - `projectPath` — taken from the project the thread belongs to, so a run
 *     cannot be aimed at a directory the caller merely names;
 *   - `objective` text — the proposal's own markdown, so an execution is the
 *     plan that was reviewed and not prose supplied at press time;
 *   - `newRun` — that flag bypasses Peer Loop's duplicate-run preflight, which
 *     is Peer Loop's protection and never T3 Code's to waive;
 *   - permission mode, owner policy, run id — Peer Loop owns all three.
 *
 * It lives in its own module because it is the one place the Peer Loop surface
 * and the orchestration read model meet. The bridge contract in `peerLoop.ts`
 * stays free of orchestration types.
 *
 * @module PeerLoopExecutionContracts
 */
import * as Schema from "effect/Schema";

import { NonNegativeInt, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestrationPeerLoopExecution, OrchestrationProposedPlanId } from "./orchestration.ts";
import { PeerLoopOwnerMessageResult, PeerLoopStartResult } from "./peerLoop.ts";

/**
 * The opaque name of one owner decision.
 *
 * Lower-case hex of a bounded length, and nothing else: a client cannot smuggle
 * a question, a path or a message through this field. Both sides compute it
 * with `@t3tools/shared/peerLoopDecisionFingerprint` from Peer Loop's own
 * question, reason, ordered options and iteration.
 */
const DECISION_FINGERPRINT_PATTERN = /^[0-9a-f]{32}$/u;

export const PeerLoopDecisionFingerprint = Schema.String.check(
  Schema.isPattern(DECISION_FINGERPRINT_PATTERN),
);
export type PeerLoopDecisionFingerprint = typeof PeerLoopDecisionFingerprint.Type;

export const PeerLoopExecuteProposalInput = Schema.Struct({
  /** The Navigator thread the proposal lives on. */
  threadId: ThreadId,
  proposedPlanId: OrchestrationProposedPlanId,
  /** Peer Loop's own optional iteration bound, forwarded untouched. */
  safetyLimit: Schema.optional(PositiveInt),
});
export type PeerLoopExecuteProposalInput = typeof PeerLoopExecuteProposalInput.Type;

/**
 * What Peer Loop said, and the link T3 Code recorded about it.
 *
 * Both, and structured. The caller needs the run id immediately — to open the
 * run, to subscribe to its activity — and must never have to find it by
 * reading a sentence.
 */
export const PeerLoopExecuteProposalResult = Schema.Struct({
  /** Peer Loop's own start result, passed through unchanged. */
  run: PeerLoopStartResult,
  /** The immutable association T3 Code persisted for it. */
  execution: OrchestrationPeerLoopExecution,
});
export type PeerLoopExecuteProposalResult = typeof PeerLoopExecuteProposalResult.Type;

/**
 * Why coordination stopped, in categories an operator can act on differently.
 *
 * Everything before `link-not-confirmed` happens before Peer Loop is called at
 * all; nothing was started and nothing needs cleaning up. `link-not-confirmed`
 * is the one that matters: a run exists and T3 Code could not prove it recorded
 * the association.
 */
export const PEER_LOOP_EXECUTION_FAILURE_REASONS = [
  /** No active thread with that id. Deleted, or never existed. */
  "navigator-thread-not-found",
  /** The thread is an ordinary coding thread; it has no execution proposals. */
  "not-a-navigator-thread",
  "proposal-not-found",
  /** Already executed: the proposal is linked to a Peer Loop run. */
  "proposal-already-executed",
  /** Already implemented the ordinary way, by a coding thread. */
  "proposal-already-implemented",
  /** The thread's project is gone or inactive, so there is no workspace root. */
  "project-not-found",
  /** The read model could not be read. Nothing was started. */
  "coordination-failed",
  /** The run started and the link could not be confirmed. See `runId`. */
  "link-not-confirmed",
] as const;
export const PeerLoopExecutionFailureReason = Schema.Literals(PEER_LOOP_EXECUTION_FAILURE_REASONS);
export type PeerLoopExecutionFailureReason = typeof PeerLoopExecutionFailureReason.Type;

/**
 * A coordination failure, sanitized by construction.
 *
 * `detail` is assembled from a fixed sentence per reason plus the ids the
 * caller itself supplied. No SQL, no stack, no filesystem path beyond the
 * project this authorized client already sees, and no provider output — a
 * coordination failure is a fact about T3 Code's own read model, and the only
 * interesting variable in it is which rule stopped the operation.
 *
 * Peer Loop's own errors are NOT wrapped in this. A duplicate-run refusal, a
 * timeout with `mayHaveApplied`, an unavailable bridge — each keeps its own
 * type and its own code, because they have different fixes and collapsing them
 * into "coordination failed" would throw that away.
 */
export class PeerLoopExecutionCoordinationError extends Schema.TaggedErrorClass<PeerLoopExecutionCoordinationError>()(
  "PeerLoopExecutionCoordinationError",
  {
    reason: PeerLoopExecutionFailureReason,
    detail: Schema.String,
    threadId: ThreadId,
    proposedPlanId: OrchestrationProposedPlanId,
    /**
     * The run this failure is about, when there is one.
     *
     * Either the run the proposal was already linked to, or — with
     * `mayHaveStarted` — the run this request started but could not record.
     * Structured so recovery can open the advanced run inspector directly
     * rather than parsing a run id out of a message.
     */
    runId: Schema.NullOr(TrimmedNonEmptyString),
    /**
     * True only when this request may have left a Peer Loop run behind.
     *
     * False means nothing was started, full stop. Nothing is retried either
     * way: repeating a start that actually worked would fork a session.
     */
    mayHaveStarted: Schema.Boolean,
  },
) {
  override get message(): string {
    return this.mayHaveStarted
      ? `Peer Loop execution coordination failed after the run started (${this.reason}): ${this.detail}`
      : `Peer Loop execution coordination failed before any run started (${this.reason}): ${this.detail}`;
  }
}

/* ------------------------------------------- answering an owner decision */

/**
 * Answering the question a linked Peer Loop run has stopped to ask.
 *
 * A coordination operation, and for the same reason as executing a proposal:
 * what reaches Peer Loop must be derived from state the server just read, not
 * from anything a client asserts. The whole payload is a thread, a run, the
 * fingerprint of the decision the owner was looking at, and which option they
 * chose.
 *
 * WHAT A CLIENT DELIBERATELY CANNOT SEND:
 *
 *   - the option TEXT — the server resolves it by index out of the decision it
 *     just read from Peer Loop, so an owner's click cannot become an arbitrary
 *     instruction to a Builder;
 *   - the question or the reason — they are what the fingerprint is *about*,
 *     and accepting them would let a caller describe a decision rather than
 *     name one;
 *   - free-form message text, a project path, or any mutable run state.
 *
 * The fingerprint is `@t3tools/shared/peerLoopDecisionFingerprint`, computed by
 * both sides from Peer Loop's own fields. It is how "the owner answered THIS
 * question" survives the trip.
 */
export const PeerLoopAnswerOwnerDecisionInput = Schema.Struct({
  /** The Navigator thread the run must be linked to. Proved server-side. */
  threadId: ThreadId,
  runId: TrimmedNonEmptyString,
  /** The decision the owner was shown, named rather than described. */
  decisionFingerprint: PeerLoopDecisionFingerprint,
  /** Which option, in the order Peer Loop recorded them. */
  optionIndex: NonNegativeInt,
});
export type PeerLoopAnswerOwnerDecisionInput = typeof PeerLoopAnswerOwnerDecisionInput.Type;

/**
 * Why an answer was not sent, when nothing is wrong with the request.
 *
 * ALL OF THESE ARE ORDINARY. A run that moved on, a decision that changed, an
 * answer already queued — none of them is a failure, and reporting them as
 * errors would teach a surface to show an alarm where the honest response is to
 * re-read the run and show the owner what it is asking now.
 */
export const PEER_LOOP_OWNER_DECISION_REFRESH_REASONS = [
  /** The run is not waiting on its owner any more. */
  "not-owner-required",
  /**
   * The run is waiting, and not for the question this answer was about.
   *
   * Also covers a run whose state says OWNER_REQUIRED while its recorded
   * decision is not a structured owner question: there is nothing to answer by
   * index, and inventing one would be a guess.
   */
  "decision-changed",
  /** An owner response is already queued for this run. One answer at a time. */
  "owner-response-queued",
] as const;
export const PeerLoopOwnerDecisionRefreshReason = Schema.Literals(
  PEER_LOOP_OWNER_DECISION_REFRESH_REASONS,
);
export type PeerLoopOwnerDecisionRefreshReason = typeof PeerLoopOwnerDecisionRefreshReason.Type;

/**
 * What happened to the answer.
 *
 * Two outcomes, kept apart because they mean opposite things to a surface:
 * `answered` carries Peer Loop's own owner-message result and the run has the
 * decision; `refresh-required` means nothing was sent and the view the owner
 * acted on is behind.
 */
export const PeerLoopAnswerOwnerDecisionResult = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("answered"),
    /** Peer Loop's structured answer, passed through unchanged. */
    delivery: PeerLoopOwnerMessageResult,
    /**
     * The decision the answer was applied to, re-stated from fresh state.
     *
     * The same value the client sent, echoed only because it proves which
     * question was answered when a surface has since moved on.
     */
    decisionFingerprint: PeerLoopDecisionFingerprint,
  }),
  Schema.Struct({
    outcome: Schema.Literal("refresh-required"),
    reason: PeerLoopOwnerDecisionRefreshReason,
    /**
     * What the run is asking now, when it is still asking something.
     *
     * Null when the run is not waiting on its owner at all. A surface can use
     * this to re-render without a second round trip; it is a fingerprint, so it
     * carries no question text.
     */
    currentDecisionFingerprint: Schema.NullOr(PeerLoopDecisionFingerprint),
  }),
]);
export type PeerLoopAnswerOwnerDecisionResult = typeof PeerLoopAnswerOwnerDecisionResult.Type;

/**
 * Why a request was refused outright, as opposed to found stale.
 *
 * STRUCTURAL ONLY. Both of these mean the request could not have come from a
 * surface that was showing this owner this decision, so neither is something a
 * refresh would fix.
 */
export const PEER_LOOP_OWNER_DECISION_FAILURE_REASONS = [
  /**
   * The run is not linked to that thread.
   *
   * Checked against T3 Code's own association table before Peer Loop is
   * touched, so a caller cannot answer a run this conversation never started.
   */
  "run-not-linked-to-thread",
  /**
   * The decision matched and the option index is outside its option list.
   *
   * Impossible for a client that rendered what it fingerprinted, so it is a
   * malformed request rather than a stale one.
   */
  "option-out-of-range",
  /**
   * T3 Code could not read its own association table.
   *
   * Not stale and not malformed: entitlement could not be established, so the
   * request was refused before Peer Loop was touched. An unprovable link is
   * not a link, and the alternative — proceeding, or reporting it as a view
   * that needs refreshing — would be a guess dressed as an answer.
   */
  "link-unreadable",
] as const;
export const PeerLoopOwnerDecisionFailureReason = Schema.Literals(
  PEER_LOOP_OWNER_DECISION_FAILURE_REASONS,
);
export type PeerLoopOwnerDecisionFailureReason = typeof PeerLoopOwnerDecisionFailureReason.Type;

/**
 * A structurally invalid or unauthorized answer, sanitized by construction.
 *
 * `detail` is a fixed sentence per reason. Nothing caught is attached: no SQL,
 * no path, no bridge diagnostic, no provider output. The interesting fact is
 * which rule refused, and the caller already knows the ids it sent.
 *
 * Peer Loop's own errors are not wrapped in this — a refusal, a timeout with
 * `mayHaveApplied`, an unavailable bridge each keep their own type, because a
 * flattened error is one a surface cannot act on correctly.
 */
export class PeerLoopOwnerDecisionCoordinationError extends Schema.TaggedErrorClass<PeerLoopOwnerDecisionCoordinationError>()(
  "PeerLoopOwnerDecisionCoordinationError",
  {
    reason: PeerLoopOwnerDecisionFailureReason,
    detail: Schema.String,
    threadId: ThreadId,
    runId: TrimmedNonEmptyString,
  },
) {
  override get message(): string {
    return `Peer Loop owner decision refused (${this.reason}): ${this.detail}`;
  }
}
