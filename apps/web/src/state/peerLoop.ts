/**
 * Peer Loop, as the web and desktop-wrapped web app sees it.
 *
 * Everything goes over the authenticated primary-environment RPC session, the
 * same one every other feature uses. No subprocess is started here, no Peer
 * Loop file is read, no terminal output is parsed, and no lifecycle or policy
 * decision is reproduced: the server forwards owner intent to Peer Loop and
 * this module renders what comes back.
 *
 * Two rules shape the whole file:
 *
 *   - **Nothing here is automatic.** Reconnecting restores observation and
 *     nothing else. A run is never resumed, recovered, started or re-messaged
 *     because a socket came back, and a timed-out mutation is never retried —
 *     Peer Loop may have accepted it and finished after we stopped waiting.
 *   - **The primary environment only.** Peer Loop runs on the machine hosting
 *     the T3 Code server. A cloud environment has no view of it, and an empty
 *     list there would read as "no runs" rather than "not here".
 *
 * @module WebPeerLoopState
 */
import type {
  PeerLoopListRunsResult,
  PeerLoopStatusResult,
  PeerLoopSubscriptionEvent,
} from "@t3tools/contracts";
import { PeerLoopError } from "@t3tools/contracts";
import type { EnvironmentId as EnvironmentIdType } from "@t3tools/contracts";
import {
  createPeerLoopEnvironmentAtoms,
  createPeerLoopEnvironmentCommands,
} from "@t3tools/client-runtime/state/peer-loop";
import {
  applyPeerLoopSubscriptionEvent,
  emptyPeerLoopRunView,
  peerLoopResumeCursor,
  type PeerLoopRunView,
} from "@t3tools/client-runtime/state/peer-loop-reducer";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { describeError, type PeerLoopErrorPresentation } from "~/peerLoopPresentation";

import { connectionAtomRuntime } from "../connection/runtime";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";

export const peerLoopEnvironment = createPeerLoopEnvironmentAtoms(connectionAtomRuntime);
export const peerLoopCommands = createPeerLoopEnvironmentCommands(connectionAtomRuntime);

const UNCONFIGURED: PeerLoopStatusResult = {
  configured: false,
  executableSource: "none",
  transport: { state: "unavailable", changedAt: "", detail: null, protocolVersion: null },
  health: null,
};

const NO_RUNS: PeerLoopListRunsResult = { runs: [], unreadable: [] };

/**
 * Status, read only where the surface is open.
 *
 * DELIBERATELY NOT READ BY THE SIDEBAR. The first `peerLoop.status` is what
 * starts the bridge subprocess, so an always-mounted component reading this
 * would spawn `peer-loop` on every ordinary T3 Code startup — on machines that
 * have never used the feature. The navigation entry is static; the first RPC
 * happens when someone opens the surface.
 */
export const peerLoopStatusAtom = Atom.make((get): PeerLoopStatusResult => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return UNCONFIGURED;
  return (
    Option.getOrNull(
      AsyncResult.value(get(peerLoopEnvironment.status({ environmentId, input: {} }))),
    ) ?? UNCONFIGURED
  );
}).pipe(Atom.withLabel("web-peer-loop-status"));

export const peerLoopStatusPendingAtom = Atom.make((get): boolean => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return false;
  return AsyncResult.isWaiting(get(peerLoopEnvironment.status({ environmentId, input: {} })));
}).pipe(Atom.withLabel("web-peer-loop-status-pending"));

export const peerLoopRunsAtom = Atom.make((get): PeerLoopListRunsResult => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return NO_RUNS;
  return (
    Option.getOrNull(
      AsyncResult.value(get(peerLoopEnvironment.runs({ environmentId, input: {} }))),
    ) ?? NO_RUNS
  );
}).pipe(Atom.withLabel("web-peer-loop-runs"));

/**
 * One run's live view, folded from a single subscription.
 *
 * The subscription carries its own attach snapshot, so this needs no second
 * `run.attach`: asking again would make Peer Loop replay the backlog a second
 * time and serialise behind the replay already running.
 *
 * The cursor comes from the view itself. After an explicit `run-resync` the
 * reducer has already rewound to the last point it can vouch for, and
 * re-subscribing with that cursor is the whole reattachment — there is no
 * arithmetic anywhere that decides a gap happened.
 */
export interface PeerLoopRunSubscriptionState {
  /** The cursor the current subscription was opened with. */
  readonly cursor: number;
  readonly view: PeerLoopRunView;
}

const runStates = new Map<string, PeerLoopRunSubscriptionState>();

/**
 * The per-run views currently being watched.
 *
 * A plain map, and it is emptied by the route: a session that opened twenty
 * runs must not still be holding twenty bounded activity slices for runs nobody
 * is looking at.
 */
export const peerLoopRunStore = {
  read: (runId: string): PeerLoopRunSubscriptionState | undefined => runStates.get(runId),
  write: (runId: string, state: PeerLoopRunSubscriptionState): void => {
    runStates.set(runId, state);
  },
  forget: (runId: string): void => {
    runStates.delete(runId);
  },
  size: (): number => runStates.size,
  clear: (): void => runStates.clear(),
} as const;

/** Route teardown: a view nobody is watching is dropped. */
export function forgetPeerLoopRun(runId: string): void {
  peerLoopRunStore.forget(runId);
}

export function peerLoopRunStateCount(): number {
  return peerLoopRunStore.size();
}

/**
 * Fold one subscription event into a run's state, cursor and all.
 *
 * Pure, and separate from the atom so the interesting behaviour — a snapshot
 * seeding the view, a backlog arriving after it, a duplicate being dropped, a
 * resync rewinding — is testable without a live connection.
 *
 * A RESTART AT THE CURSOR THE VIEW WAS ALREADY TRIMMED TO KEEPS THE VIEW. That
 * is what a reattachment is: the reducer has already rewound to the last point
 * it can vouch for and dropped everything past it, and throwing the rest away
 * would lose `needsResync`, the authoritative snapshot, and activity the client
 * legitimately still has. Only a cursor that does not match the view's own
 * position starts from nothing — that is a different subscription, not a resumed
 * one.
 */
export function advancePeerLoopRun(
  runId: string,
  previous: PeerLoopRunSubscriptionState | undefined,
  cursor: number,
  event: PeerLoopSubscriptionEvent | null,
): PeerLoopRunSubscriptionState {
  const base = resolveFoldBase(runId, previous, cursor);
  return { cursor, view: event === null ? base : applyPeerLoopSubscriptionEvent(base, event) };
}

function resolveFoldBase(
  runId: string,
  previous: PeerLoopRunSubscriptionState | undefined,
  cursor: number,
): PeerLoopRunView {
  if (previous === undefined) return emptyPeerLoopRunView(runId, cursor);
  if (previous.cursor === cursor) return previous.view;
  if (previous.view.afterSeq === cursor) return previous.view;
  return emptyPeerLoopRunView(runId, cursor);
}

/**
 * The cursor this run is subscribed from.
 *
 * A separate atom because it is the *input* to the subscription. Note that
 * setting it to the value it already holds is NOT a restart — the subscription
 * atom is keyed by that value, so nothing re-subscribes. Restarting is
 * `useAtomRefresh` on the events atom itself; see `peerLoopRunEventsAtom`.
 */
export const peerLoopRunCursorAtom = Atom.family((runId: string) =>
  Atom.make(peerLoopRunStore.read(runId)?.cursor ?? 0).pipe(
    Atom.withLabel(`web-peer-loop-run-cursor:${runId}`),
  ),
);

/**
 * The exact subscription behind one run's view.
 *
 * Exposed so the route can refresh *this* atom — environment, run and cursor —
 * which is the repository's supported way to tear the completed stream down and
 * open one replacement.
 */
export function peerLoopRunEventsAtom(
  environmentId: EnvironmentIdType,
  runId: string,
  afterSeq: number,
) {
  return peerLoopEnvironment.events({ environmentId, input: { runId, afterSeq } });
}

/**
 * What the route needs to render one run: the view, and whether observing it is
 * still working.
 *
 * A failed subscription — the run does not exist, the transport went, the
 * session is not authorized — must not render as a run with nothing in it. The
 * failure is carried out so the page can say so and offer to look again.
 */
export interface PeerLoopRunObservation {
  readonly view: PeerLoopRunView;
  readonly cursor: number;
  readonly waiting: boolean;
  readonly error: PeerLoopErrorPresentation | null;
  /** True before the subscription has produced anything at all. */
  readonly empty: boolean;
}

/** Hoisted: `Schema.is` compiles a checker, and every failed stream runs it. */
const isPeerLoopError = Schema.is(PeerLoopError);

const GENERIC_OBSERVATION_FAILURE: PeerLoopErrorPresentation = {
  title: "This run could not be observed",
  detail: "The connection to this environment failed. Nothing about the run has changed.",
  code: null,
  tone: "warning",
  mayHaveApplied: false,
};

const NOT_CONNECTED: PeerLoopErrorPresentation = {
  title: "Not connected to the machine running Peer Loop",
  detail: null,
  code: null,
  tone: "warning",
  mayHaveApplied: false,
};

function presentObservationFailure(cause: Cause.Cause<unknown>): PeerLoopErrorPresentation {
  const error = Option.getOrNull(Cause.findErrorOption(cause));
  // A connection or authorization failure is not a Peer Loop refusal and must
  // not be dressed as one; it also must not leak whatever it carried.
  return error !== null && isPeerLoopError(error)
    ? describeError(error)
    : GENERIC_OBSERVATION_FAILURE;
}

/**
 * Fold one subscription's events into one run's view.
 *
 * A factory over its two dependencies so a test can drive the real fold, the
 * real store and the real refresh mechanism against a subscription it controls
 * — which is the only way to prove that restarting actually opens a second
 * stream and disposes the first.
 */
export function createPeerLoopRunObservationAtoms(deps: {
  readonly environmentIdAtom: Atom.Atom<EnvironmentIdType | null>;
  readonly eventsAtom: (
    environmentId: EnvironmentIdType,
    runId: string,
    afterSeq: number,
  ) => Atom.Atom<AsyncResult.AsyncResult<PeerLoopSubscriptionEvent, unknown>>;
}) {
  const observation = Atom.family((runId: string) =>
    Atom.make((get): PeerLoopRunObservation => {
      const environmentId = get(deps.environmentIdAtom);
      const existing = peerLoopRunStore.read(runId);
      if (environmentId === null) {
        return {
          view: existing?.view ?? emptyPeerLoopRunView(runId),
          cursor: existing?.cursor ?? 0,
          waiting: false,
          error: NOT_CONNECTED,
          empty: existing === undefined,
        };
      }

      const cursor = get(peerLoopRunCursorAtom(runId));
      const result = get(deps.eventsAtom(environmentId, runId, cursor));
      const event = Option.getOrNull(AsyncResult.value(result));
      const next = advancePeerLoopRun(runId, existing, cursor, event);
      peerLoopRunStore.write(runId, next);

      return {
        view: next.view,
        cursor,
        waiting: result.waiting,
        error: AsyncResult.isFailure(result) ? presentObservationFailure(result.cause) : null,
        empty: next.view.state === null && next.view.activity.length === 0,
      };
    }).pipe(Atom.withLabel(`web-peer-loop-run-observation:${runId}`)),
  );

  return {
    observation,
    /** The view alone, for callers that do not care why observation stopped. */
    view: Atom.family((runId: string) =>
      Atom.make((get): PeerLoopRunView => get(observation(runId)).view).pipe(
        Atom.withLabel(`web-peer-loop-run-view:${runId}`),
      ),
    ),
  } as const;
}

const runObservationAtoms = createPeerLoopRunObservationAtoms({
  environmentIdAtom: primaryEnvironmentIdAtom,
  eventsAtom: peerLoopRunEventsAtom,
});

export const peerLoopRunObservationAtom = runObservationAtoms.observation;
export const peerLoopRunViewAtom = runObservationAtoms.view;

/**
 * Rewind this run to the cursor a resync reported, keeping what it can vouch for.
 *
 * Explicit, and only ever called from a user-visible reattachment or after a
 * command whose effect the run's own snapshot has to reflect. It restores
 * *observation*: it starts nothing, resumes nothing and re-sends nothing.
 *
 * Returns the cursor the caller must then refresh the events atom at — setting
 * the cursor atom alone does not restart a subscription when the value has not
 * changed.
 */
export function rewindPeerLoopRun(runId: string): number {
  const existing = peerLoopRunStore.read(runId);
  if (existing === undefined) return 0;
  const cursor = peerLoopResumeCursor(existing.view);
  peerLoopRunStore.write(runId, { cursor, view: existing.view });
  return cursor;
}
