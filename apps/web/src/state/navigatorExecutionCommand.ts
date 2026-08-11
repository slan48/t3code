/**
 * `peerLoop.executeProposal`, as the web app runs it.
 *
 * One gate per proposal, held outside React, and that is the point. The Execute
 * action is rendered in two places at once — the proposal card in the timeline
 * and the Plan sidebar — so a hook-local flag would give a proposal two
 * independent gates and two presses in the same tick would start two runs. The
 * gate is keyed by conversation and proposal, so both controls are the same
 * control.
 *
 * The same rules as every other Peer Loop command apply, and one more:
 *
 *   - **Nothing is ever retried.** Peer Loop may have accepted the request and
 *     started a run after T3 Code stopped waiting; repeating it would fork the
 *     Reviewer's conversation. That includes timeouts and connection failures.
 *   - **Both error families survive.** A Peer Loop refusal and a T3 Code
 *     coordination failure are different problems, and `link-not-confirmed`
 *     means a run exists that T3 Code could not record.
 *   - **The structured result is kept.** The reply carries the run id and the
 *     association T3 Code persisted, and the surface needs both immediately —
 *     long before the synchronized read model catches up.
 *
 * @module NavigatorExecutionCommand
 */
import type {
  EnvironmentId,
  OrchestrationPeerLoopExecution,
  OrchestrationProposedPlanId,
  PeerLoopExecuteProposalResult,
  PeerLoopRunSummary,
  ThreadId,
} from "@t3tools/contracts";
import { PeerLoopError, PeerLoopExecutionCoordinationError } from "@t3tools/contracts";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import {
  buildExecuteProposalRequest,
  describeCoordinationError,
  NO_EXECUTION_SNAPSHOT,
  selectNavigatorSnapshotAtom,
  type NavigatorExecutionSnapshot,
  describePeerLoopExecutionError,
  EXECUTION_RESULT_UNKNOWN,
  localLinkIsDurable,
  reconcileExecutionLinks,
  selectNavigatorRunListAtom,
  type NavigatorExecutionFailure,
} from "~/navigatorExecution";
import { useAtomCommand } from "./use-atom-command";
import { peerLoopCommands, peerLoopEnvironment } from "./peerLoop";

/* --------------------------------------------------------------- store */

export interface NavigatorExecutionState {
  readonly pending: boolean;
  readonly failure: NavigatorExecutionFailure | null;
  /**
   * The association this client was handed, retained until it is durable.
   *
   * Dropped as soon as the same link appears in the synchronized thread, so
   * nothing is stored twice and nothing outlives its source of truth.
   */
  readonly link: OrchestrationPeerLoopExecution | null;
}

export const IDLE_NAVIGATOR_EXECUTION: NavigatorExecutionState = {
  pending: false,
  failure: null,
  link: null,
};

/**
 * Environment, conversation, proposal — length-prefixed, so no triple can be
 * spelled two ways.
 *
 * THE ENVIRONMENT IS PART OF THE IDENTITY. Thread ids and proposal ids are
 * T3 Code's, and two environments can hold the same one: a local checkout and
 * a cloud environment of the same project routinely do. Keyed without it, an
 * Execute pending on one machine would render as pending on the other, and a
 * retained link from one would be reconciled against the other's read model.
 */
export const navigatorExecutionKey = (input: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly proposedPlanId: string;
}): string =>
  `${input.environmentId.length}:${input.environmentId}:${input.threadId.length}:${input.threadId}:${input.proposedPlanId}`;

/** Hoisted: `Schema.is` compiles a checker, and every failed command runs it. */
const isPeerLoopError = Schema.is(PeerLoopError);
const isCoordinationError = Schema.is(PeerLoopExecutionCoordinationError);

/**
 * Which failure this was, in the order that keeps the two families apart.
 *
 * The coordination error is checked first because it is the only one that can
 * say a run started and was not recorded. Anything that is neither — a dropped
 * connection, an unauthorized session — is not a Peer Loop refusal and must not
 * be dressed as one.
 */
export function describeExecutionResultFailure(
  result: AsyncResult.AsyncResult<unknown, unknown>,
): NavigatorExecutionFailure {
  // Not a failure at all: only reachable if a caller misuses this. Treated as
  // unknown rather than as success, because guessing the other way is the one
  // that starts a second run.
  if (!AsyncResult.isFailure(result)) return EXECUTION_RESULT_UNKNOWN;
  const error = Option.getOrNull(Cause.findErrorOption(result.cause));
  if (error !== null && isCoordinationError(error)) return describeCoordinationError(error);
  if (error !== null && isPeerLoopError(error)) return describePeerLoopExecutionError(error);
  // Nothing typed explains this. A dropped connection is not evidence that the
  // server did nothing, so the outcome is unknown rather than "not started".
  return EXECUTION_RESULT_UNKNOWN;
}

export interface NavigatorExecutionRunner {
  readonly run: () => Promise<AsyncResult.AsyncResult<PeerLoopExecuteProposalResult, unknown>>;
}

/**
 * The per-proposal gates, with no React in them.
 *
 * `inFlight` is a plain synchronous set, which is the whole point: a flag set
 * inside a `setState` updater is not a gate, because two presses in the same
 * tick both read the pre-render value. Two controls for one proposal share this
 * set, so the second press is refused before any RPC is created.
 */
export function createNavigatorExecutionStore() {
  const states = new Map<string, NavigatorExecutionState>();
  const inFlight = new Set<string>();
  const listeners = new Set<() => void>();
  let version = 0;

  /*
   * Idle is a SHAPE, not an object identity.
   *
   * Comparing against the shared constant looked equivalent and was not: a
   * released retained link produces a fresh `{pending: false, failure: null,
   * link: null}`, which is idle by every meaning that matters and was kept for
   * ever. One entry per proposal ever executed in a session is small, and it
   * still grows without bound over a long session, so idleness is detected
   * structurally and the entry goes.
   *
   * A pending request and a settled failure are NOT idle and are never evicted
   * here — a failure that may have left a run behind is safety information, and
   * dropping it because a card unmounted would re-offer Execute on the next
   * render.
   */
  const isIdle = (state: NavigatorExecutionState): boolean =>
    !state.pending && state.failure === null && state.link === null;

  const publish = (key: string, state: NavigatorExecutionState): void => {
    if (isIdle(state)) states.delete(key);
    else states.set(key, state);
    version += 1;
    for (const listener of listeners) listener();
  };

  const read = (key: string): NavigatorExecutionState =>
    states.get(key) ?? IDLE_NAVIGATOR_EXECUTION;

  return {
    read,
    /** A primitive snapshot, so `useSyncExternalStore` has a stable identity. */
    version: (): number => version,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isBusy: (key: string): boolean => inFlight.has(key),
    /**
     * How many entries are being retained.
     *
     * A read-only seam so a test can prove the store does not accumulate idle
     * entries as conversations come and go. Production callers get `read`; the
     * map itself is never handed out.
     */
    size: (): number => states.size,

    /**
     * Send one Execute request, or refuse.
     *
     * Returns null when the gate refused — a second press while the first is
     * outstanding — and null again on failure. A failure is terminal here; the
     * owner decides what happens next.
     */
    execute: async (
      key: string,
      runner: NavigatorExecutionRunner,
    ): Promise<PeerLoopExecuteProposalResult | null> => {
      if (inFlight.has(key)) return null;
      inFlight.add(key);
      publish(key, { pending: true, failure: null, link: read(key).link });

      try {
        const result = await runner.run();
        if (AsyncResult.isSuccess(result)) {
          publish(key, { pending: false, failure: null, link: result.value.execution });
          return result.value;
        }
        publish(key, {
          pending: false,
          failure: describeExecutionResultFailure(result),
          link: read(key).link,
        });
        return null;
      } catch {
        // A DEFECT IS STILL A TERMINAL STATE. Left to escape it would keep the
        // button visibly pending for ever and turn the caller's `.then` into an
        // unhandled rejection. Settled here, generically, and not retried.
        publish(key, {
          pending: false,
          failure: EXECUTION_RESULT_UNKNOWN,
          link: read(key).link,
        });
        return null;
      } finally {
        // Every path. The gate is released; the request is not repeated.
        inFlight.delete(key);
      }
    },

    /** The read model caught up. The retained copy is no longer needed. */
    releaseLink: (key: string): void => {
      const current = read(key);
      if (current.link === null) return;
      publish(key, { ...current, link: null });
    },

    dismissFailure: (key: string): void => {
      const current = read(key);
      if (current.failure === null) return;
      publish(key, { ...current, failure: null });
    },

    /** Tests only. Nothing in the app forgets an outstanding request. */
    reset: (): void => {
      states.clear();
      inFlight.clear();
      version += 1;
      for (const listener of listeners) listener();
    },
  } as const;
}

export type NavigatorExecutionStore = ReturnType<typeof createNavigatorExecutionStore>;

/** One store for the app: two controls for a proposal must share one gate. */
export const navigatorExecutionStore = createNavigatorExecutionStore();

/* ---------------------------------------------------------------- hooks */

/**
 * One proposal's execution state and the command that starts it.
 *
 * Every mounted copy of the action reads the same entry, so a press in the
 * timeline immediately shows as pending in the Plan sidebar too.
 */
export function useNavigatorExecution(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly proposedPlanId: OrchestrationProposedPlanId;
}) {
  const executeProposal = useAtomCommand(peerLoopCommands.executeProposal, {
    reportFailure: false,
  });
  const key = navigatorExecutionKey({
    environmentId: input.environmentId,
    threadId: input.threadId,
    proposedPlanId: input.proposedPlanId,
  });

  useSyncExternalStore(
    navigatorExecutionStore.subscribe,
    navigatorExecutionStore.version,
    navigatorExecutionStore.version,
  );
  const state = navigatorExecutionStore.read(key);

  const { environmentId, threadId, proposedPlanId } = input;
  const execute = useCallback(
    () =>
      navigatorExecutionStore.execute(key, {
        // Exactly the environment wrapper and two ids. See the request builder.
        run: () =>
          executeProposal(buildExecuteProposalRequest({ environmentId, threadId, proposedPlanId })),
      }),
    [environmentId, executeProposal, key, proposedPlanId, threadId],
  );

  const dismissFailure = useCallback(() => navigatorExecutionStore.dismissFailure(key), [key]);

  return { state, execute, dismissFailure } as const;
}

/**
 * The retained links for one conversation, and the durable ones they merge into.
 *
 * Reads every proposal's entry rather than one, because the conversation shows
 * all of its proposals at once and the retained link belongs to whichever one
 * produced it.
 */
export function useRetainedExecutionLinks(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly proposedPlanIds: ReadonlyArray<OrchestrationProposedPlanId>;
}): ReadonlyArray<OrchestrationPeerLoopExecution> {
  useSyncExternalStore(
    navigatorExecutionStore.subscribe,
    navigatorExecutionStore.version,
    navigatorExecutionStore.version,
  );
  const { environmentId, threadId, proposedPlanIds } = input;
  if (environmentId === null || threadId === null) return EMPTY_LINKS;
  const links: OrchestrationPeerLoopExecution[] = [];
  for (const proposedPlanId of proposedPlanIds) {
    const link = navigatorExecutionStore.read(
      navigatorExecutionKey({ environmentId, threadId, proposedPlanId }),
    ).link;
    if (link !== null) links.push(link);
  }
  // The shared empty array keeps the common case — nothing retained — free of
  // a new identity on every render.
  return links.length === 0 ? EMPTY_LINKS : links;
}

const EMPTY_LINKS: ReadonlyArray<OrchestrationPeerLoopExecution> = [];

/**
 * Every link this conversation should show: the durable ones plus any this
 * client is still holding.
 *
 * The retained copy is released the moment its durable twin appears, so the two
 * are never both alive and the run is never listed twice. Releasing in an
 * effect rather than during render keeps the store out of React's render pass.
 */
export function useNavigatorExecutionLinks(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly durable: ReadonlyArray<OrchestrationPeerLoopExecution>;
  readonly proposedPlanIds: ReadonlyArray<OrchestrationProposedPlanId>;
}): ReadonlyArray<OrchestrationPeerLoopExecution> {
  const retained = useRetainedExecutionLinks({
    environmentId: input.environmentId,
    threadId: input.threadId,
    proposedPlanIds: input.proposedPlanIds,
  });
  const { environmentId, threadId, durable } = input;

  useEffect(() => {
    if (environmentId === null || threadId === null) return;
    for (const link of retained) {
      if (!localLinkIsDurable(durable, link)) continue;
      // Releasing writes an idle state, which the store evicts structurally —
      // so a conversation that has caught up leaves no entry behind.
      navigatorExecutionStore.releaseLink(
        navigatorExecutionKey({
          environmentId,
          threadId,
          proposedPlanId: link.proposedPlanId,
        }),
      );
    }
  }, [durable, environmentId, retained, threadId]);

  return useMemo(() => reconcileExecutionLinks(durable, retained), [durable, retained]);
}

/* ---------------------------------------------------------- observation */

/**
 * An atom that queries nothing.
 *
 * Read in place of the run list whenever a conversation has no execution links,
 * so a Navigator conversation that has never executed anything issues no Peer
 * Loop RPC and does not start the bridge.
 */
const NO_RUNS_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("navigator-execution-runs:none"),
);

const navigatorRunsAtomFor = (environmentId: EnvironmentId) =>
  peerLoopEnvironment.runs({ environmentId, input: {} });

type NavigatorRunsAtom = ReturnType<typeof navigatorRunsAtomFor> | typeof NO_RUNS_ATOM;

export interface NavigatorExecutionRuns {
  readonly runs: ReadonlyArray<PeerLoopRunSummary>;
  readonly unreadable: ReadonlyArray<string>;
  /** True when a Peer Loop query is actually being made for this conversation. */
  readonly observed: boolean;
  /** Re-read the summaries. Never starts anything. */
  readonly refresh: () => void;
}

/**
 * Peer Loop run summaries for one conversation's executions, or nothing at all.
 *
 * Keyed by the *thread's* environment. Run ids are Peer Loop's and are
 * per-machine, so another environment's list would match a link against a
 * stranger's run. The existing five-second summary poll is reused; no run is
 * attached or subscribed to from here.
 */
export function useNavigatorExecutionRuns(input: {
  readonly environmentId: EnvironmentId | null;
  readonly linkCount: number;
}): NavigatorExecutionRuns {
  const observed = input.environmentId !== null && input.linkCount > 0;
  const runsAtom = selectNavigatorRunListAtom<NavigatorRunsAtom>({
    environmentId: input.environmentId,
    linkCount: input.linkCount,
    runsAtomFor: navigatorRunsAtomFor,
    none: NO_RUNS_ATOM,
  });
  const result = useAtomValue(runsAtom);
  const refreshRuns = useAtomRefresh(runsAtom);
  const refresh = useCallback(() => {
    if (!observed) return;
    refreshRuns();
  }, [observed, refreshRuns]);

  const value = Option.getOrNull(AsyncResult.value(result));
  return useMemo(
    () => ({
      runs: value?.runs ?? [],
      unreadable: value?.unreadable ?? [],
      observed,
      refresh,
    }),
    [observed, refresh, value],
  );
}

/* ------------------------------------------------------ run snapshots */

/**
 * An atom that queries nothing, in place of a run snapshot.
 *
 * Read whenever a child execution has no structured detail worth fetching, so
 * an ordinary working run — or a conversation with no links at all — issues no
 * `peerLoop.attachRun`.
 */
const NO_SNAPSHOT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("navigator-execution-snapshot:none"),
);

/**
 * One run's durable snapshot, keyed by environment and run.
 *
 * `peerLoop.attachRun` is the existing read-only snapshot method; nothing new
 * is added on the server and no event subscription is opened. The atom family
 * keys on the argument, so the timeline copy and the sidebar copy of the same
 * execution read one atom and issue one bridge request.
 */
const navigatorSnapshotAtomFor = (environmentId: EnvironmentId, runId: string) =>
  peerLoopEnvironment.attach({ environmentId, input: { runId } });

type NavigatorSnapshotAtom = ReturnType<typeof navigatorSnapshotAtomFor> | typeof NO_SNAPSHOT_ATOM;

/**
 * Who gets to refresh a shared snapshot when its run summary moves.
 *
 * Both copies of an execution see the same new `updatedAt` in the same tick and
 * would both refresh the atom they share — two `run.attach` calls for one
 * change. The first to claim a (run, revision) pair does it; the second finds
 * the pair already claimed and does nothing.
 */
export function createSnapshotRefreshLedger() {
  const claimed = new Map<string, string>();
  return {
    /** True for the first caller of each (key, revision). False afterwards. */
    claim: (key: string, revision: string): boolean => {
      if (claimed.get(key) === revision) return false;
      claimed.set(key, revision);
      return true;
    },
    size: (): number => claimed.size,
    reset: (): void => claimed.clear(),
  } as const;
}

export const snapshotRefreshLedger = createSnapshotRefreshLedger();

/** Length-prefixed, like every other composite key in this module. */
export const navigatorSnapshotKey = (input: {
  readonly environmentId: string;
  readonly runId: string;
}): string => `${input.environmentId.length}:${input.environmentId}:${input.runId}`;

/**
 * The structured snapshot behind one child execution, when it is worth reading.
 *
 * `wanted` is the caller's answer to "does this run's attention state have
 * structured detail an owner needs" — DONE and OWNER_REQUIRED, and nothing
 * else. When it is false this reads an atom that queries nothing.
 *
 * `revision` is the run summary's own `updatedAt`. A change to it re-reads the
 * snapshot exactly once across every mounted copy; nothing here polls, and
 * nothing subscribes to the run's activity.
 */
export function useNavigatorExecutionSnapshot(input: {
  readonly environmentId: EnvironmentId | null;
  readonly runId: string;
  readonly wanted: boolean;
  readonly revision: string | null;
}): NavigatorExecutionSnapshot {
  const snapshotAtom = selectNavigatorSnapshotAtom<NavigatorSnapshotAtom>({
    environmentId: input.environmentId,
    runId: input.runId,
    wanted: input.wanted,
    snapshotAtomFor: navigatorSnapshotAtomFor,
    none: NO_SNAPSHOT_ATOM,
  });
  const result = useAtomValue(snapshotAtom);
  const refresh = useAtomRefresh(snapshotAtom);

  const { environmentId, runId, wanted, revision } = input;
  const observedRevision = useRef<string | null>(null);
  useEffect(() => {
    if (!wanted || environmentId === null || revision === null) return;
    const key = navigatorSnapshotKey({ environmentId: String(environmentId), runId });
    const first = observedRevision.current === null;
    const changed = observedRevision.current !== revision;
    observedRevision.current = revision;
    const claimed = snapshotRefreshLedger.claim(key, revision);
    // Mounting the atom already issues the read; only a later revision needs a
    // refresh, and only the first copy to notice it performs one.
    if (!first && changed && claimed) refresh();
  }, [environmentId, refresh, revision, runId, wanted]);

  return useMemo(() => {
    if (!wanted || environmentId === null) return NO_EXECUTION_SNAPSHOT;
    if (AsyncResult.isFailure(result)) return { status: "failed", state: null };
    const value = Option.getOrNull(AsyncResult.value(result));
    if (value === null) return { status: "loading", state: null };
    return { status: "ready", state: value.state };
  }, [environmentId, result, wanted]);
}
