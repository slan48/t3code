/**
 * PeerLoopOwnerDecisionCoordinator - answering the question a linked run asked.
 *
 * A Peer Loop run that stops for its owner is waiting for one of the options it
 * recorded. Delivering that answer from T3 Code means being sure of three
 * separate things, and the whole coordinator is those three things in order:
 *
 *   1. **This conversation is entitled to answer this run.** Proved against
 *      T3 Code's own association table before Peer Loop is touched at all.
 *   2. **The run is still asking the question the owner answered.** Proved
 *      against a FRESH `run.attach`, never against anything a surface cached:
 *      the Navigator card's snapshot, the five-second run list and the activity
 *      stream are all views that can be a minute old, and a minute is long
 *      enough for a Reviewer to ask something else.
 *   3. **The text sent is Peer Loop's own.** The option is resolved by index
 *      out of the decision just read, so what reaches a Builder is a sentence
 *      the Reviewer wrote — never one a client supplied.
 *
 * CHECK-THEN-ACT, AND HONESTLY SO. Between the attach in step 2 and the send in
 * step 7 another surface — the Peer Loop CLI, a second T3 Code client, another
 * machine on the tailnet — can answer the same question. Nothing here prevents
 * that, and Peer Loop's `run.ownerMessage` is not a compare-and-swap: there is
 * no fingerprint to hand it and this coordinator does not invent one by
 * changing Peer Loop's protocol. What the freshness checks buy is that T3 Code
 * never sends an answer to a question it can see has already moved on, which is
 * the case an owner can actually cause by leaving a tab open.
 *
 * There is deliberately no local serialization gate. One would only stop two
 * T3 Code requests racing each other, would say nothing about the external
 * race above, and the surface that will use this offers one decision at a time.
 * Adding a bounded reference-counted map to narrow a window that stays open
 * anyway is machinery pretending to be a guarantee.
 *
 * @module PeerLoopOwnerDecisionCoordinator
 */
import {
  PeerLoopOwnerDecisionCoordinationError,
  type PeerLoopAnswerOwnerDecisionInput,
  type PeerLoopAnswerOwnerDecisionResult,
  type PeerLoopAttachResult,
  type PeerLoopError,
  type PeerLoopOwnerDecisionFailureReason,
  type PeerLoopOwnerDecisionRefreshReason,
  type ThreadId,
} from "@t3tools/contracts";
import { peerLoopOwnerDecisionFingerprint } from "@t3tools/shared/peerLoopDecisionFingerprint";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadPeerLoopExecutionRepository } from "../persistence/Services/ProjectionThreadPeerLoopExecutions.ts";
import { PeerLoopService } from "./Service.ts";

export interface PeerLoopOwnerDecisionCoordinatorShape {
  readonly answerOwnerDecision: (
    input: PeerLoopAnswerOwnerDecisionInput,
  ) => Effect.Effect<
    PeerLoopAnswerOwnerDecisionResult,
    PeerLoopError | PeerLoopOwnerDecisionCoordinationError
  >;
}

export class PeerLoopOwnerDecisionCoordinator extends Context.Service<
  PeerLoopOwnerDecisionCoordinator,
  PeerLoopOwnerDecisionCoordinatorShape
>()("t3/peerLoop/OwnerDecisionCoordinator/PeerLoopOwnerDecisionCoordinator") {}

/* --------------------------------------------------------------- errors */

/**
 * One fixed sentence per reason.
 *
 * Sanitized by construction. Nothing caught is interpolated: no SQL, no
 * filesystem path, no bridge diagnostic, no provider output. The only useful
 * variable is which rule refused, and the caller already has the ids it sent.
 */
const FAILURE_DETAILS: Readonly<Record<PeerLoopOwnerDecisionFailureReason, string>> = {
  "run-not-linked-to-thread":
    "That run is not linked to that conversation, so this conversation cannot answer it. Nothing was sent.",
  "option-out-of-range":
    "That option does not exist on the decision the run is waiting on. Nothing was sent.",
  "link-unreadable":
    "T3 Code could not read its own record of this conversation's runs, so it could not confirm the run belongs to it. Nothing was sent.",
};

const refuse = (input: {
  readonly reason: PeerLoopOwnerDecisionFailureReason;
  readonly threadId: ThreadId;
  readonly runId: string;
}) =>
  new PeerLoopOwnerDecisionCoordinationError({
    reason: input.reason,
    detail: FAILURE_DETAILS[input.reason],
    threadId: input.threadId,
    runId: input.runId,
  });

/** A stale view is not a failure. It is a run that has moved on. */
const refreshRequired = (
  reason: PeerLoopOwnerDecisionRefreshReason,
  currentDecisionFingerprint: string | null,
): PeerLoopAnswerOwnerDecisionResult => ({
  outcome: "refresh-required",
  reason,
  currentDecisionFingerprint,
});

/* ---------------------------------------------------------------- make */

export const make = Effect.fn("peerLoop.OwnerDecisionCoordinator.make")(function* () {
  const peerLoop = yield* PeerLoopService;
  const executions = yield* ProjectionThreadPeerLoopExecutionRepository;

  /**
   * Is this run one of the conversation's own?
   *
   * The association table, not the thread snapshot: this is an authorization
   * question, and it is answered from the narrowest record that can answer it.
   * A read failure refuses rather than proceeding — an unprovable link is not
   * a link.
   */
  const requireLinkedRun = Effect.fn("peerLoop.OwnerDecisionCoordinator.requireLinkedRun")(
    function* (input: { readonly threadId: ThreadId; readonly runId: string }) {
      const links = yield* executions
        .listByThreadId({ threadId: input.threadId })
        .pipe(Effect.mapError(() => refuse({ ...input, reason: "link-unreadable" })));
      if (!links.some((link) => link.runId === input.runId)) {
        return yield* refuse({ ...input, reason: "run-not-linked-to-thread" });
      }
    },
  );

  /**
   * What the run is asking right now, from a reading taken for this request.
   *
   * Returns the decision's fingerprint and its options, or null when the run is
   * not waiting on an owner question at all.
   */
  const currentDecision = (
    attached: PeerLoopAttachResult,
  ): { readonly fingerprint: string; readonly options: ReadonlyArray<string> } | null => {
    const state = attached.state;
    if (state.state !== "owner_required") return null;
    const decision = state.lastReviewerDecision;
    if (decision === null || decision.decision !== "OWNER_REQUIRED") return null;
    const fingerprint = peerLoopOwnerDecisionFingerprint({
      decision,
      iteration: state.iteration,
    });
    if (fingerprint === null) return null;
    return { fingerprint, options: decision.options };
  };

  const answerOwnerDecision: PeerLoopOwnerDecisionCoordinatorShape["answerOwnerDecision"] =
    Effect.fn("peerLoop.OwnerDecisionCoordinator.answerOwnerDecision")(function* (
      input: PeerLoopAnswerOwnerDecisionInput,
    ): Effect.fn.Return<
      PeerLoopAnswerOwnerDecisionResult,
      PeerLoopError | PeerLoopOwnerDecisionCoordinationError
    > {
      // 1. Entitlement, before Peer Loop is touched. A caller that names a run
      //    this conversation never started gets no attach and no send.
      yield* requireLinkedRun({ threadId: input.threadId, runId: input.runId });

      // 2. A reading taken now, for this request. Never a cached snapshot, the
      //    run-list poll, a copied projection or activity state — those are the
      //    views that can be showing a question the run has already left.
      const attached = yield* peerLoop.attachRun({ runId: input.runId });

      // 3. Still waiting, and waiting with a structured question. A run that
      //    resumed, finished or halted for another reason is not answerable,
      //    and an OWNER_REQUIRED state whose recorded decision is not an owner
      //    question has no options to resolve an index against.
      const current = currentDecision(attached);
      if (current === null) {
        const reason: PeerLoopOwnerDecisionRefreshReason =
          attached.state.state === "owner_required" ? "decision-changed" : "not-owner-required";
        return refreshRequired(reason, null);
      }

      // 4. The same question the owner answered. The fingerprint is recomputed
      //    from the fresh decision and the fresh iteration; a Reviewer that has
      //    asked something else since produces a different one.
      if (current.fingerprint !== input.decisionFingerprint) {
        return refreshRequired("decision-changed", current.fingerprint);
      }

      // 5. One answer at a time. A queued owner message is an answer already on
      //    its way, and adding a second would deliver two.
      if (attached.state.queuedOwnerMessages.length > 0) {
        return refreshRequired("owner-response-queued", current.fingerprint);
      }

      // 6. The option, resolved out of the reading above. The client sent an
      //    index; the text is Peer Loop's own. An index outside the list it
      //    fingerprinted is a malformed request, not a stale one.
      const option = current.options[input.optionIndex];
      if (option === undefined) {
        return yield* refuse({
          reason: "option-out-of-range",
          threadId: input.threadId,
          runId: input.runId,
        });
      }

      // 7. Once. Peer Loop's own refusals and timeouts travel back untouched —
      //    a timeout in particular may have delivered, and this never retries.
      const delivery = yield* peerLoop.sendOwnerMessage({ runId: input.runId, text: option });
      return {
        outcome: "answered",
        delivery,
        decisionFingerprint: current.fingerprint,
      };
    });

  return { answerOwnerDecision } satisfies PeerLoopOwnerDecisionCoordinatorShape;
});

export const layer = Layer.effect(PeerLoopOwnerDecisionCoordinator, make());
