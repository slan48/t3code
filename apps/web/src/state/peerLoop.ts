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
 * EVERYTHING HERE IS KEYED BY ENVIRONMENT AND RUN, NOT BY RUN ALONE. Run ids
 * are Peer Loop's, and two machines can hold the same one. Keyed by run only, a
 * change of primary environment would attach the second machine's run from the
 * first machine's cursor — skipping durable events it never saw — and would
 * render the first machine's state, activity and control availability while
 * doing it. Enabling a mutation from that is the part that actually hurts.
 */
export interface PeerLoopRunKey {
  readonly environmentId: EnvironmentIdType;
  readonly runId: string;
}

/** Length-prefixed, so no environment/run pair can be spelled two ways. */
export const peerLoopRunKey = (key: PeerLoopRunKey): string => {
  const environmentId = String(key.environmentId);
  return `${environmentId.length}:${environmentId}:${key.runId}`;
};

export interface PeerLoopRunSubscriptionState {
  /** The cursor the current subscription was opened with. */
  readonly cursor: number;
  readonly view: PeerLoopRunView;
}

const runStates = new Map<string, PeerLoopRunSubscriptionState>();

/**
 * The per-environment, per-run views currently being watched.
 *
 * A plain map, and it is emptied by the route: a session that opened twenty
 * runs must not still be holding twenty bounded activity slices for runs nobody
 * is looking at.
 */
export const peerLoopRunStore = {
  read: (key: PeerLoopRunKey): PeerLoopRunSubscriptionState | undefined =>
    runStates.get(peerLoopRunKey(key)),
  write: (key: PeerLoopRunKey, state: PeerLoopRunSubscriptionState): void => {
    runStates.set(peerLoopRunKey(key), state);
  },
  forget: (key: PeerLoopRunKey): void => {
    runStates.delete(peerLoopRunKey(key));
  },
  size: (): number => runStates.size,
  clear: (): void => runStates.clear(),
} as const;

/** Route teardown: the exact environment/run entry it mounted is dropped. */
export function forgetPeerLoopRun(key: PeerLoopRunKey): void {
  peerLoopRunStore.forget(key);
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
 * The cursor this environment's run is subscribed from.
 *
 * Setting it to the value it already holds is NOT a restart — the subscription
 * atom is keyed by that value, so nothing re-subscribes. Setting it to a
 * *different* value is: mounting the new key opens the replacement stream and
 * unmounting the old one disposes it. See `restartPeerLoopObservation`.
 */
export const peerLoopRunCursorAtom = Atom.family((key: string) =>
  Atom.make(runStates.get(key)?.cursor ?? 0).pipe(
    // Idle-collected like the rest of this app's per-entity atoms. The family
    // holds weak references, but a cursor that nothing has read for minutes is
    // not worth keeping around either.
    Atom.setIdleTTL(PEER_LOOP_OBSERVATION_IDLE_TTL_MS),
    Atom.withLabel(`web-peer-loop-run-cursor:${key}`),
  ),
);

/** Long enough to survive a route change, short enough not to accumulate. */
export const PEER_LOOP_OBSERVATION_IDLE_TTL_MS = 5 * 60_000;

/**
 * Bumped when a pair is disposed, and read by its observation.
 *
 * The retained view lives in a plain map, which nothing reactive watches. An
 * observation atom that was still cached would go on serving the view it had —
 * so leaving a run and coming straight back would show the state that was just
 * thrown away, with a cursor that no longer matches it. Changing this is what
 * tells the derived atom to fold again from nothing.
 */
const peerLoopRunGenerationAtom = Atom.family((key: string) =>
  Atom.make(0).pipe(
    Atom.setIdleTTL(PEER_LOOP_OBSERVATION_IDLE_TTL_MS),
    Atom.withLabel(`web-peer-loop-run-generation:${key}`),
  ),
);

/**
 * The exact subscription behind one environment's run view.
 *
 * Exposed so a restart can refresh *this* atom — environment, run and cursor —
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
  /** False when there is no primary environment: nothing may be retried. */
  readonly observable: boolean;
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

const DISCONNECTED: PeerLoopRunObservation = {
  view: emptyPeerLoopRunView(""),
  cursor: 0,
  waiting: false,
  error: NOT_CONNECTED,
  empty: true,
  observable: false,
};

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
  const cursor = (key: PeerLoopRunKey) => peerLoopRunCursorAtom(peerLoopRunKey(key));
  const generation = (key: PeerLoopRunKey) => peerLoopRunGenerationAtom(peerLoopRunKey(key));
  const events = (key: PeerLoopRunKey, afterSeq: number) =>
    deps.eventsAtom(key.environmentId, key.runId, afterSeq);

  const observation = Atom.family((runId: string) =>
    Atom.make((get): PeerLoopRunObservation => {
      const environmentId = get(deps.environmentIdAtom);
      // No environment: nothing is keyed, nothing is subscribed, and there is
      // no invented id to refresh. Retry is a no-op the route disables.
      if (environmentId === null) {
        return { ...DISCONNECTED, view: emptyPeerLoopRunView(runId) };
      }

      const key: PeerLoopRunKey = { environmentId, runId };
      // Read so disposal can invalidate this fold; the value itself is not used.
      get(generation(key));
      const existing = peerLoopRunStore.read(key);
      const at = get(cursor(key));
      const result = get(events(key, at));
      const event = Option.getOrNull(AsyncResult.value(result));
      const next = advancePeerLoopRun(runId, existing, at, event);
      // Only retain something there is something to retain. A recompute right
      // after disposal — the environment changed, or the route left — has no
      // previous entry and no event, and writing an empty one back would undo
      // the disposal that just happened.
      if (existing !== undefined || event !== null) peerLoopRunStore.write(key, next);

      return {
        view: next.view,
        cursor: at,
        waiting: result.waiting,
        error: AsyncResult.isFailure(result) ? presentObservationFailure(result.cause) : null,
        empty: next.view.state === null && next.view.activity.length === 0,
        observable: true,
      };
    }).pipe(
      Atom.setIdleTTL(PEER_LOOP_OBSERVATION_IDLE_TTL_MS),
      Atom.withLabel(`web-peer-loop-run-observation:${runId}`),
    ),
  );

  return {
    observation,
    cursor,
    generation,
    events,
    /** The view alone, for callers that do not care why observation stopped. */
    view: Atom.family((runId: string) =>
      Atom.make((get): PeerLoopRunView => get(observation(runId)).view).pipe(
        Atom.withLabel(`web-peer-loop-run-view:${runId}`),
      ),
    ),
  } as const;
}

export type PeerLoopRunObservationAtoms = ReturnType<typeof createPeerLoopRunObservationAtoms>;

const runObservationAtoms = createPeerLoopRunObservationAtoms({
  environmentIdAtom: primaryEnvironmentIdAtom,
  eventsAtom: peerLoopRunEventsAtom,
});

export const peerLoopRunObservationAtom = runObservationAtoms.observation;
export const peerLoopRunViewAtom = runObservationAtoms.view;
export const peerLoopObservationAtoms = runObservationAtoms;

/**
 * Rewind this run to the cursor a resync reported, keeping what it can vouch for.
 *
 * Returns the cursor the subscription must run at next. The reducer has already
 * trimmed the view to that point, so the view is kept as it is.
 */
export function rewindPeerLoopRun(key: PeerLoopRunKey): number {
  const existing = peerLoopRunStore.read(key);
  if (existing === undefined) return 0;
  const cursor = peerLoopResumeCursor(existing.view);
  peerLoopRunStore.write(key, { cursor, view: existing.view });
  return cursor;
}

/**
 * Stop observing one environment/run pair, completely.
 *
 * BOTH HALVES, OR NEITHER. Forgetting the bounded view while leaving the cursor
 * atom at its last value is the worst of both: a later visit to the same pair
 * opens at cursor 100 with an empty view, and events 1–100 — which this client
 * discarded — are never replayed. The cursor is reset through the registry, so
 * the family's own entry is the thing that changes rather than some cache
 * beside it.
 *
 * Disposal only. Nothing is refreshed and no subscription is reopened: leaving
 * the pair is exactly when the stream should stop, not restart.
 */
export function disposePeerLoopRun(
  registry: Pick<PeerLoopRestartRegistry, "get" | "set">,
  atoms: PeerLoopRunObservationAtoms,
  key: PeerLoopRunKey,
): void {
  registry.set(atoms.cursor(key), 0);
  // Always changes, so a still-cached observation cannot go on serving the view
  // this just discarded. Setting the cursor alone would be a no-op whenever it
  // was already 0 — which is most of the time.
  registry.set(atoms.generation(key), registry.get(atoms.generation(key)) + 1);
  // Forgotten LAST. Either of those writes can make a still-mounted observation
  // recompute synchronously, and a recompute that still had the subscription's
  // last event would retain the pair again on the way out.
  peerLoopRunStore.forget(key);
}

/** The registry operations a restart needs. Narrow, so a test can supply them. */
export interface PeerLoopRestartRegistry {
  readonly get: <A>(atom: Atom.Atom<A>) => A;
  readonly set: <R, W>(atom: Atom.Writable<R, W>, value: W) => void;
  readonly refresh: <A>(atom: Atom.Atom<A>) => void;
}

export interface PeerLoopRestartOutcome {
  readonly cursor: number;
  /** True when the cursor moved, so a *new* subscription key was mounted. */
  readonly switched: boolean;
}

/**
 * Observe this run again, exactly once, at the cursor it can vouch for.
 *
 * TWO CASES, AND DOING BOTH IS THE BUG THIS REPLACES. The old code captured the
 * cursor from a render, then always set it *and* refreshed — so a resync from 0
 * to 5 refreshed the dead `(run, 0)` subscription while mounting `(run, 5)`,
 * issuing a second, pointless attach at the old cursor that Peer Loop then had
 * to serialise or supersede.
 *
 *   - the target moved: setting the cursor is the whole restart. Mounting the
 *     new key opens the replacement and unmounting the old key disposes it. The
 *     old key is never refreshed;
 *   - the target is unchanged: the key is the same, so nothing would remount.
 *     Refreshing that exact atom is what opens the replacement.
 *
 * The current cursor is read from the registry at action time, so a stale
 * render value in a route closure cannot pick the wrong branch.
 */
export function restartPeerLoopObservation(
  registry: PeerLoopRestartRegistry,
  atoms: PeerLoopRunObservationAtoms,
  key: PeerLoopRunKey,
): PeerLoopRestartOutcome {
  const cursorAtom = atoms.cursor(key);
  const current = registry.get(cursorAtom);
  const target = rewindPeerLoopRun(key);

  if (target !== current) {
    registry.set(cursorAtom, target);
    return { cursor: target, switched: true };
  }
  registry.refresh(atoms.events(key, current));
  return { cursor: current, switched: false };
}
