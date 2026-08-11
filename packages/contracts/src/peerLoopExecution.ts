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

import { PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestrationPeerLoopExecution, OrchestrationProposedPlanId } from "./orchestration.ts";
import { PeerLoopStartResult } from "./peerLoop.ts";

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
