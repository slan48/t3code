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
import type { PeerLoopStatusResult, PeerLoopListRunsResult } from "@t3tools/contracts";
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
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

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
 * A cursor change means a *new* subscription: the previous view is discarded
 * and the fold restarts from that cursor, which is exactly what an explicit
 * reattachment is.
 */
export function advancePeerLoopRun(
  runId: string,
  previous: PeerLoopRunSubscriptionState | undefined,
  cursor: number,
  event: import("@t3tools/contracts").PeerLoopSubscriptionEvent | null,
): PeerLoopRunSubscriptionState {
  const base =
    previous !== undefined && previous.cursor === cursor
      ? previous.view
      : emptyPeerLoopRunView(runId, cursor);
  return { cursor, view: event === null ? base : applyPeerLoopSubscriptionEvent(base, event) };
}

/**
 * The cursor this run should (re-)subscribe from.
 *
 * A separate atom because it is the *input* to the subscription: bumping it is
 * what performs an explicit reattachment, and doing that from inside the fold
 * would re-enter the atom that produced the event.
 */
export const peerLoopRunCursorAtom = Atom.family((runId: string) =>
  Atom.make(peerLoopRunStore.read(runId)?.cursor ?? 0).pipe(
    Atom.withLabel(`web-peer-loop-run-cursor:${runId}`),
  ),
);

/**
 * Fold one subscription's events into this run's view.
 *
 * `Atom.family` keyed by run id, and every entry is dropped when the route
 * stops observing it — see `forgetPeerLoopRun`. Retained activity is bounded by
 * the shared reducer, so a run that has been open for an hour costs the same as
 * one opened a minute ago.
 */
export const peerLoopRunViewAtom = Atom.family((runId: string) =>
  Atom.make((get): PeerLoopRunView => {
    const environmentId = get(primaryEnvironmentIdAtom);
    const existing = peerLoopRunStore.read(runId);
    if (environmentId === null) return existing?.view ?? emptyPeerLoopRunView(runId);

    const cursor = get(peerLoopRunCursorAtom(runId));
    const result = get(
      peerLoopEnvironment.events({ environmentId, input: { runId, afterSeq: cursor } }),
    );
    const event = Option.getOrNull(AsyncResult.value(result));
    const next = advancePeerLoopRun(runId, existing, cursor, event);
    peerLoopRunStore.write(runId, next);
    return next.view;
  }).pipe(Atom.withLabel(`web-peer-loop-run-view:${runId}`)),
);

/**
 * Reattach from the cursor a resync reported.
 *
 * Explicit, and only ever called from a user-visible reattachment: Peer Loop
 * said the stream had a hole, and the client re-subscribes from the last point
 * it can vouch for. This restores *observation*. It starts nothing, resumes
 * nothing and re-sends nothing.
 */
export const reattachPeerLoopRunAtom = Atom.family((runId: string) =>
  Atom.writable(
    () => null,
    (ctx) => {
      const view = peerLoopRunStore.read(runId)?.view;
      if (view === undefined) return;
      // The reducer has already rewound to the last point it can vouch for.
      // Re-subscribing with that cursor is the whole reattachment.
      const cursor = peerLoopResumeCursor(view);
      peerLoopRunStore.write(runId, { cursor, view });
      ctx.set(peerLoopRunCursorAtom(runId), cursor);
    },
  ).pipe(Atom.withLabel(`web-peer-loop-run-reattach:${runId}`)),
);
