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
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import {
  buildExecuteProposalRequest,
  describeCoordinationError,
  describePeerLoopExecutionError,
  EXECUTION_SEND_FAILED,
  EXECUTION_SEND_FAILED_UNEXPECTEDLY,
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

/** Length-prefixed, so no conversation/proposal pair can be spelled two ways. */
export const navigatorExecutionKey = (input: {
  readonly threadId: string;
  readonly proposedPlanId: string;
}): string => `${input.threadId.length}:${input.threadId}:${input.proposedPlanId}`;

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
  if (!AsyncResult.isFailure(result)) return EXECUTION_SEND_FAILED;
  const error = Option.getOrNull(Cause.findErrorOption(result.cause));
  if (error !== null && isCoordinationError(error)) return describeCoordinationError(error);
  if (error !== null && isPeerLoopError(error)) return describePeerLoopExecutionError(error);
  return EXECUTION_SEND_FAILED;
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

  const publish = (key: string, state: NavigatorExecutionState): void => {
    if (state === IDLE_NAVIGATOR_EXECUTION) states.delete(key);
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
          failure: EXECUTION_SEND_FAILED_UNEXPECTEDLY,
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
  readonly threadId: ThreadId | null;
  readonly proposedPlanIds: ReadonlyArray<OrchestrationProposedPlanId>;
}): ReadonlyArray<OrchestrationPeerLoopExecution> {
  useSyncExternalStore(
    navigatorExecutionStore.subscribe,
    navigatorExecutionStore.version,
    navigatorExecutionStore.version,
  );
  const { threadId, proposedPlanIds } = input;
  if (threadId === null) return EMPTY_LINKS;
  const links: OrchestrationPeerLoopExecution[] = [];
  for (const proposedPlanId of proposedPlanIds) {
    const link = navigatorExecutionStore.read(
      navigatorExecutionKey({ threadId, proposedPlanId }),
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
  readonly threadId: ThreadId | null;
  readonly durable: ReadonlyArray<OrchestrationPeerLoopExecution>;
  readonly proposedPlanIds: ReadonlyArray<OrchestrationProposedPlanId>;
}): ReadonlyArray<OrchestrationPeerLoopExecution> {
  const retained = useRetainedExecutionLinks({
    threadId: input.threadId,
    proposedPlanIds: input.proposedPlanIds,
  });
  const { threadId, durable } = input;

  useEffect(() => {
    if (threadId === null) return;
    for (const link of retained) {
      if (!localLinkIsDurable(durable, link)) continue;
      navigatorExecutionStore.releaseLink(
        navigatorExecutionKey({ threadId, proposedPlanId: link.proposedPlanId }),
      );
    }
  }, [durable, retained, threadId]);

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
