/**
 * One client's view of one Peer Loop run.
 *
 * A pure reducer over the subscription stream, shared by web and mobile. It
 * keeps a cursor, an ordered and bounded slice of recent activity, and the
 * latest snapshot Peer Loop sent — and it decides nothing. It never resumes,
 * never recovers, never infers that a run "should" continue: those are owner
 * commands and Peer Loop's rules, and a UI that guessed at them would be a
 * second, quieter copy of the state machine.
 *
 * Peer Loop's `seq` is per-run and strictly increasing, but NOT contiguous: an
 * event can be given a number and then fail to be recorded, so a skip is
 * ordinary data rather than evidence of loss. A duplicate is therefore a `seq`
 * already seen, and a missing range is only ever something the server or Peer
 * Loop states outright — never something inferred from arithmetic.
 *
 * @module PeerLoopReducer
 */
import {
  PEER_LOOP_CLIENT_ACTIVITY_LIMIT,
  type PeerLoopEvent,
  type PeerLoopHaltKind,
  type PeerLoopRunOutcome,
  type PeerLoopRunStateFile,
  type PeerLoopSubscriptionEvent,
  type PeerLoopTransportStatus,
} from "@t3tools/contracts";

export interface PeerLoopRunView {
  readonly runId: string;
  /**
   * The highest `seq` this client has rendered.
   *
   * Sent back as `afterSeq` on every re-subscribe, which is how a phone that
   * slept for an hour picks up exactly what it missed.
   */
  readonly afterSeq: number;
  readonly transport: PeerLoopTransportStatus | null;
  /** The last durable run state Peer Loop sent. Never assembled locally. */
  readonly state: PeerLoopRunStateFile | null;
  readonly outcome: PeerLoopRunOutcome | null;
  /** True once Peer Loop reported the run finished and released it. */
  readonly finished: boolean;
  /**
   * The stream is known to be incomplete. Re-subscribe from `afterSeq`.
   *
   * Set only by an explicit `run-resync`. Never inferred from a sequence skip,
   * which is legitimate, and never from a quiet connection.
   */
  readonly needsResync: boolean;
  /** Recent activity, oldest first, bounded for a phone's sake. */
  readonly activity: readonly PeerLoopEvent[];
}

/**
 * Where a reconnect should resume from.
 *
 * Always the view's own cursor, resync or not: after a resync it has already
 * been rewound to the last safe point, so there is one answer and no chance of
 * a caller picking the wrong one.
 */
export function peerLoopResumeCursor(view: PeerLoopRunView): number {
  return view.afterSeq;
}

export function emptyPeerLoopRunView(runId: string, afterSeq = 0): PeerLoopRunView {
  return {
    runId,
    afterSeq,
    transport: null,
    state: null,
    outcome: null,
    finished: false,
    needsResync: false,
    activity: [],
  };
}

function appendBounded(
  activity: readonly PeerLoopEvent[],
  event: PeerLoopEvent,
  limit: number,
): readonly PeerLoopEvent[] {
  const next = [...activity, event];
  return next.length <= limit ? next : next.slice(next.length - limit);
}

/**
 * Fold one subscription event into the view.
 *
 * Returns the same reference when nothing changed, so a UI subscribed to this
 * does not repaint for a duplicate.
 */
export function applyPeerLoopSubscriptionEvent(
  view: PeerLoopRunView,
  event: PeerLoopSubscriptionEvent,
  limit: number = PEER_LOOP_CLIENT_ACTIVITY_LIMIT,
): PeerLoopRunView {
  switch (event.kind) {
    case "transport":
      // A transport change is a fact about the connection, never about the run:
      // the cursor and the activity survive it untouched, because Peer Loop's
      // durable log did too.
      return view.transport?.state === event.transport.state &&
        view.transport?.changedAt === event.transport.changedAt
        ? view
        : { ...view, transport: event.transport };

    case "run-event": {
      if (event.runId !== view.runId) return view;
      // Already rendered. A shared replay for another client lands here, and so
      // does the backlog after a reconnect.
      if (event.event.seq <= view.afterSeq) return view;
      // A skip is NOT loss: Peer Loop numbers an event before it records it, so
      // a number can be spent and never appear. Nothing is flagged here.
      return {
        ...view,
        afterSeq: event.event.seq,
        activity: appendBounded(view.activity, event.event, limit),
      };
    }

    case "run-outcome":
      return event.runId === view.runId
        ? { ...view, outcome: event.outcome, state: event.state ?? view.state }
        : view;

    case "run-finished":
      return event.runId === view.runId
        ? {
            ...view,
            outcome: event.outcome,
            state: event.state ?? view.state,
            finished: true,
          }
        : view;

    case "run-resync": {
      if (event.runId !== view.runId) return view;
      // Rewind to the last cursor anyone can vouch for, and trim the retained
      // activity back to match. Keeping events past the safe cursor would make
      // the next replay append them a second time — and the point of a resync
      // is that nobody knows what happened after that point.
      const safe = Math.min(view.afterSeq, event.afterSeq);
      return {
        ...view,
        needsResync: true,
        afterSeq: safe,
        activity: view.activity.filter((entry) => entry.seq <= safe),
      };
    }
  }
}

/* ---------------------------------------------------------- projections */

/**
 * What a run is waiting on, if anything.
 *
 * Presentation only, and deliberately thin: every value here is read straight
 * out of what Peer Loop reported. The client shows it; the owner acts on it.
 */
export type PeerLoopAttentionKind =
  | "none"
  /** The Reviewer escalated a product decision. */
  | "owner-decision"
  /** The run needs an objective before anything will start. */
  | "needs-objective"
  /** A Builder condition the owner fixes outside T3Code. */
  | "capacity-exhausted"
  | "auth-required"
  /** A Builder turn was cut off partway; the repository may already have moved. */
  | "transport-interrupted"
  /** A turn was in flight when Peer Loop stopped. Requires an explicit choice. */
  | "recovery-required"
  | "paused"
  | "blocked"
  | "failed"
  | "done";

export interface PeerLoopAttention {
  readonly kind: PeerLoopAttentionKind;
  /** True when a person has to do something before the run can continue. */
  readonly actionable: boolean;
  /** Peer Loop's own halt kind, when there is one. Never a local invention. */
  readonly haltKind: PeerLoopHaltKind | null;
  /** Peer Loop's own words. */
  readonly message: string | null;
}

const HALT_ATTENTION: Readonly<Record<PeerLoopHaltKind, PeerLoopAttentionKind>> = {
  OWNER_REQUIRED: "owner-decision",
  OWNER_OBJECTIVE_REQUIRED: "needs-objective",
  CAPACITY_EXHAUSTED: "capacity-exhausted",
  AUTH_REQUIRED: "auth-required",
  TRANSPORT_INTERRUPTED: "transport-interrupted",
  AMBIGUOUS_INTERRUPTED_TURN: "recovery-required",
  OWNER_PAUSED: "paused",
  SAFETY_LIMIT: "paused",
  SYSTEM_BLOCKED: "blocked",
  CAPABILITY_MISMATCH: "failed",
  PROTOCOL_ERROR: "failed",
  PROCESS_ERROR: "failed",
};

const NOT_ACTIONABLE: ReadonlySet<PeerLoopAttentionKind> = new Set(["none", "done", "paused"]);

/**
 * Project the run's current condition.
 *
 * `DONE` wins over a halt reason, because a finished run's last halt is
 * history. Everything else comes from `state.haltReason`, which is the only
 * place Peer Loop records why a run is not moving.
 */
export function peerLoopAttention(view: PeerLoopRunView): PeerLoopAttention {
  if (view.outcome?.kind === "done") {
    return { kind: "done", actionable: false, haltKind: null, message: view.outcome.summary };
  }

  const halt = view.state?.haltReason ?? null;
  if (halt === null) {
    return { kind: "none", actionable: false, haltKind: null, message: null };
  }

  const kind = HALT_ATTENTION[halt.kind];
  return {
    kind,
    actionable: !NOT_ACTIONABLE.has(kind),
    haltKind: halt.kind,
    message: halt.message,
  };
}

/**
 * The task the Builder was last given, and the Reviewer's last decision.
 *
 * Kept separate from the activity slice so trimming the feed never loses the
 * answer to "what is it doing right now".
 */
export interface PeerLoopRunSnapshot {
  readonly state: PeerLoopRunStateFile["state"] | null;
  readonly iteration: number | null;
  readonly currentTask: string | null;
  readonly lastDecision: PeerLoopRunStateFile["lastReviewerDecision"];
  readonly queuedOwnerMessages: number;
}

export function peerLoopRunSnapshot(view: PeerLoopRunView): PeerLoopRunSnapshot {
  const state = view.state;
  return {
    state: state?.state ?? null,
    iteration: state?.iteration ?? null,
    currentTask: state?.lastBuilderTask ?? null,
    lastDecision: state?.lastReviewerDecision ?? null,
    queuedOwnerMessages: state?.queuedOwnerMessages.length ?? 0,
  };
}
