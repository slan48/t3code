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
  PeerLoopAnswerOwnerDecisionResult,
  PeerLoopExecuteProposalResult,
  PeerLoopRunStateFile,
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
  describeOwnerDecisionAnswerFailure,
  type NavigatorDecisionAnswerFailure,
  type NavigatorOwnerDecisionAction,
  NO_EXECUTION_ATTEMPT,
  NO_EXECUTION_SNAPSHOT,
  proposalExecutionAvailability,
  selectNavigatorSnapshotAtom,
  type ExecutableProposal,
  type ExecuteProposalAvailability,
  type NavigatorExecutionAttempt,
  type NavigatorExecutionFacts,
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

export interface NavigatorExecutionTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly proposedPlanId: OrchestrationProposedPlanId;
}

/**
 * Execute one proposal, through the one gate that proposal has.
 *
 * THE SINGLE ENTRY POINT. The Execute button in the timeline, the one in the
 * Plan sidebar, and a recognized confirmation phrase submitted in the composer
 * all call this. They resolve to the same environment/thread/proposal key, so a
 * press and a phrase landing in the same tick produce one RPC and one run.
 */
export function useNavigatorExecuteProposal(): (
  target: NavigatorExecutionTarget,
) => Promise<PeerLoopExecuteProposalResult | null> {
  const executeProposal = useAtomCommand(peerLoopCommands.executeProposal, {
    reportFailure: false,
  });
  return useCallback(
    (target) =>
      navigatorExecutionStore.execute(navigatorExecutionKey(target), {
        // Exactly the environment wrapper and two ids. See the request builder.
        run: () => executeProposal(buildExecuteProposalRequest(target)),
      }),
    [executeProposal],
  );
}

/**
 * One proposal's execution state and the command that starts it.
 *
 * Every mounted copy of the action reads the same entry, so a press in the
 * timeline immediately shows as pending in the Plan sidebar too.
 */
export function useNavigatorExecution(input: NavigatorExecutionTarget) {
  const executeProposal = useNavigatorExecuteProposal();
  const key = navigatorExecutionKey(input);

  useSyncExternalStore(
    navigatorExecutionStore.subscribe,
    navigatorExecutionStore.version,
    navigatorExecutionStore.version,
  );
  const state = navigatorExecutionStore.read(key);

  const { environmentId, threadId, proposedPlanId } = input;
  const execute = useCallback(
    () => executeProposal({ environmentId, threadId, proposedPlanId }),
    [environmentId, executeProposal, proposedPlanId, threadId],
  );

  const dismissFailure = useCallback(() => navigatorExecutionStore.dismissFailure(key), [key]);

  return { state, execute, dismissFailure } as const;
}

/**
 * What the gate remembers about one proposal's last attempt.
 *
 * Read from the store rather than from a render, because the two surfaces ask
 * at different moments: a card asks while rendering and a confirmation phrase
 * asks while submitting. The store is the same in both.
 */
export function readNavigatorExecutionAttempt(input: {
  readonly facts: NavigatorExecutionFacts;
  readonly proposal: ExecutableProposal | null;
}): NavigatorExecutionAttempt {
  const { threadId, environmentId } = input.facts;
  if (input.proposal === null || threadId === null) return NO_EXECUTION_ATTEMPT;
  const state = navigatorExecutionStore.read(
    navigatorExecutionKey({ environmentId, threadId, proposedPlanId: input.proposal.id }),
  );
  return { pending: state.pending, disposition: state.failure?.disposition ?? null };
}

/**
 * Whether this proposal may be executed, answered once for every surface.
 *
 * THE SINGLE AVAILABILITY ANSWER. Both Execute buttons and the composer's
 * confirmation call this with the conversation's one facts object, so a card
 * that mounts offering the action and a phrase submitted the next moment cannot
 * reach different conclusions about the same proposal. Nothing is cached: a
 * proposal whose last attempt was a provable pre-start refusal is executable on
 * the first render after a mount, with no turn and no refresh in between.
 */
export function navigatorExecutionAvailability(input: {
  readonly facts: NavigatorExecutionFacts;
  readonly proposal: ExecutableProposal | null;
}): ExecuteProposalAvailability {
  return proposalExecutionAvailability({
    facts: input.facts,
    proposal: input.proposal,
    attempt: readNavigatorExecutionAttempt(input),
  });
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
 * Who re-reads a shared snapshot, so that one revision costs one `run.attach`.
 *
 * Both copies of an execution see the same reading and the same new `updatedAt`
 * in the same tick and would both refresh the atom they share. The first to
 * claim a (run, revision) pair does it; every later caller for that pair finds
 * it claimed and does nothing. A claim against a key nobody is observing is
 * refused — there is no card on screen to read for.
 *
 * NOTHING HERE DECIDES WHETHER A READ IS NEEDED. That was the defect: this
 * remembered which revision each card had *seen* and treated a card's first
 * sighting as a reading, because mounting the atom reads it. A card whose first
 * sighting landed on a revision change — the Plan sidebar opening onto a run
 * that had just finished, a timeline row scrolling back in — then recorded the
 * new revision while reading nothing, and the copy holding the older reading
 * found the pair claimed and stood down. The DONE status arrived over the
 * OWNER_REQUIRED snapshot underneath it and nothing replaced it. Whether a
 * reading is behind is answered from the reading itself, in
 * {@link snapshotReadingIsBehind}; this only settles who acts on it.
 *
 * OWNERSHIP IS REFERENCE-COUNTED, because a plain map here is a leak: one entry
 * per environment/run that an owner ever looked at, kept for the lifetime of
 * the tab. Each mounted observer retains, each unmount releases, and the last
 * release drops the entry. A claim against an unretained key creates nothing,
 * so a stray call cannot resurrect the leak.
 *
 * React's StrictMode development mount runs setup → cleanup → setup, which
 * takes the count 1 → 0 → 1 and forgets which pairs were claimed. That is
 * harmless: a forgotten claim only lets a card ask again, and it asks only
 * while the reading it holds is genuinely behind the run list.
 */
export function createSnapshotRefreshLedger() {
  const entries = new Map<string, { observers: number; revision: string | null }>();
  return {
    retain: (key: string): void => {
      const entry = entries.get(key);
      if (entry === undefined) entries.set(key, { observers: 1, revision: null });
      else entry.observers += 1;
    },
    release: (key: string): void => {
      const entry = entries.get(key);
      if (entry === undefined) return;
      entry.observers -= 1;
      if (entry.observers <= 0) entries.delete(key);
    },
    /**
     * True for the first retained caller of each (key, revision).
     *
     * False for every later caller of the same pair, and false for a key
     * nobody is observing — there is no card on screen to read for.
     */
    claim: (key: string, revision: string): boolean => {
      const entry = entries.get(key);
      if (entry === undefined) return false;
      if (entry.revision === revision) return false;
      entry.revision = revision;
      return true;
    },
    /** The revision a read has already been issued for, if anyone is looking. */
    claimed: (key: string): string | null => entries.get(key)?.revision ?? null,
    observers: (key: string): number => entries.get(key)?.observers ?? 0,
    size: (): number => entries.size,
    reset: (): void => entries.clear(),
  } as const;
}

export const snapshotRefreshLedger = createSnapshotRefreshLedger();

/** Length-prefixed, like every other composite key in this module. */
export const navigatorSnapshotKey = (input: {
  readonly environmentId: string;
  readonly runId: string;
}): string => `${input.environmentId.length}:${input.environmentId}:${input.runId}`;

/**
 * Whether the snapshot a card is holding was taken before the run list moved.
 *
 * THE READING SAYS WHEN IT WAS TAKEN. Peer Loop stamps its run state file with
 * the same `updatedAt` its run list reports, so a card can compare the two
 * rather than reason about which copy mounted the shared atom first, whether a
 * node survived a run passing through a working state, or how long an unused
 * one lingers. Those were all guesses, and every one of them was wrong in some
 * ordering.
 *
 * Holding nothing yet is not behind: the read that mounting started is the
 * answer, and a second one would be the duplicate this avoids. A reading at or
 * after the listed revision is not behind either — an attach lands after the
 * summary that prompted it and routinely comes back newer.
 *
 * Two stamps that cannot be compared are treated as behind, which costs at most
 * one extra read: {@link createSnapshotRefreshLedger} allows one per revision.
 */
export function snapshotReadingIsBehind(reading: string | null, revision: string): boolean {
  if (reading === null) return false;
  if (reading === revision) return false;
  const held = Date.parse(reading);
  const listed = Date.parse(revision);
  if (Number.isNaN(held) || Number.isNaN(listed)) return true;
  return held < listed;
}

/**
 * One mounted card, reporting the reading it holds and the revision it is being
 * asked to show.
 *
 * The body of the hook's effect, lifted out of React so the behaviour that
 * matters — which copy re-reads, and when — can be driven directly, against the
 * real atom, in the order React commits it. Nothing else about it is different.
 */
export function observeSnapshotRevision(input: {
  /** Null when this card wants no snapshot at all. Nothing is read or claimed. */
  readonly key: string | null;
  /** Peer Loop's `updatedAt` from the run list. Null when there is no summary. */
  readonly revision: string | null;
  /** The `updatedAt` of the snapshot this card is holding, if it holds one. */
  readonly reading: string | null;
  readonly refresh: () => void;
}): void {
  if (input.key === null || input.revision === null) return;
  if (!snapshotReadingIsBehind(input.reading, input.revision)) return;
  if (snapshotRefreshLedger.claim(input.key, input.revision)) input.refresh();
}

/**
 * The structured snapshot behind one child execution, when it is worth reading.
 *
 * `wanted` is the caller's answer to "does this run's attention state have
 * structured detail an owner needs" — DONE and OWNER_REQUIRED, and nothing
 * else. When it is false this reads an atom that queries nothing.
 *
 * `revision` is the run summary's own `updatedAt`. A snapshot stamped before it
 * is re-read exactly once across every mounted copy, whichever copy notices;
 * nothing here polls, and nothing subscribes to the run's activity.
 */
export function useNavigatorExecutionSnapshot(input: {
  readonly environmentId: EnvironmentId | null;
  readonly runId: string;
  readonly wanted: boolean;
  readonly revision: string | null;
}): NavigatorExecutionSnapshot & {
  /**
   * Re-read this run now, whatever the ledger remembers.
   *
   * FOR AN ACTION THIS CLIENT JUST TOOK, and nothing else. The revision ledger
   * decides who re-reads when a *summary* moves, which is a question about
   * polling; answering a decision is a question about a request whose whole
   * point was to change the run. The two never conflict: the reading that comes
   * back is stamped, so the ledger's own comparison stays true afterwards, and
   * a card that is not showing an answerable decision never calls this.
   */
  readonly refresh: () => void;
} {
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
  const ledgerKey =
    wanted && environmentId !== null
      ? navigatorSnapshotKey({ environmentId: String(environmentId), runId })
      : null;

  const snapshot = useMemo(
    () => navigatorSnapshotOf({ wanted, environmentId, result }),
    [environmentId, result, wanted],
  );

  // Ownership, on its own effect and keyed only on the entry. A revision change
  // must not churn the reference count — and must not momentarily drop it to
  // zero, which would let both copies read for one change.
  useEffect(() => {
    if (ledgerKey === null) return;
    snapshotRefreshLedger.retain(ledgerKey);
    return () => snapshotRefreshLedger.release(ledgerKey);
  }, [ledgerKey]);

  // WHETHER THIS CARD IS BEHIND IS A FACT ABOUT WHAT IT IS HOLDING, not about
  // which copy mounted the shared atom first. A run that finishes, or stops for
  // the owner a second time, is a reading stamped before the summary above it —
  // whichever copy notices says so, and exactly one of them re-reads.
  const reading = snapshot.state?.updatedAt ?? null;
  useEffect(() => {
    observeSnapshotRevision({ key: ledgerKey, revision, reading, refresh });
  }, [ledgerKey, reading, refresh, revision]);

  return useMemo(() => ({ ...snapshot, refresh }), [refresh, snapshot]);
}

/**
 * What a card sees, from whatever the snapshot atom currently holds.
 *
 * A card that wants no snapshot has none — not an empty one — because "this run
 * has no structured detail worth reading" and "the read failed" are different
 * things to say. A failure leaves the run-list status above it untouched.
 */
export function navigatorSnapshotOf(input: {
  readonly wanted: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly result: AsyncResult.AsyncResult<{ readonly state: PeerLoopRunStateFile }, unknown>;
}): NavigatorExecutionSnapshot {
  if (!input.wanted || input.environmentId === null) return NO_EXECUTION_SNAPSHOT;
  if (AsyncResult.isFailure(input.result)) return { status: "failed", state: null };
  const value = Option.getOrNull(AsyncResult.value(input.result));
  if (value === null) return { status: "loading", state: null };
  return { status: "ready", state: value.state };
}

/* ------------------------------------------- answering an owner decision */

export interface NavigatorDecisionAnswerState {
  /** True while this client's own answer is outstanding, for every copy. */
  readonly pending: boolean;
  readonly failure: NavigatorDecisionAnswerFailure | null;
}

const IDLE_DECISION_ANSWER: NavigatorDecisionAnswerState = { pending: false, failure: null };

/** Length-prefixed, like every other composite key in this module. */
export const navigatorDecisionKey = (input: {
  readonly environmentId: string;
  readonly runId: string;
}): string => `${input.environmentId.length}:${input.environmentId}:${input.runId}`;

/**
 * One gate per run, held outside React, for the same reason the Execute gate is.
 *
 * The decision block is rendered twice — the timeline card and the Plan sidebar
 * are separate components with separate callbacks — so a hook-local flag would
 * give one run two gates, and two clicks in the same tick would send two
 * answers to a Reviewer that asked one question. Keyed by environment and run,
 * so both copies are the same control and neither can act while the other is
 * mid-flight.
 *
 * KEYED BY RUN, NOT BY DECISION. Two options of one question are still one
 * answer, and the second click must be refused just as firmly as a repeat of
 * the first.
 */
export function createNavigatorDecisionAnswerStore() {
  const states = new Map<string, NavigatorDecisionAnswerState>();
  const inFlight = new Set<string>();
  const listeners = new Set<() => void>();
  let version = 0;

  const isIdle = (state: NavigatorDecisionAnswerState): boolean =>
    !state.pending && state.failure === null;

  const publish = (key: string, state: NavigatorDecisionAnswerState): void => {
    // Idle by shape, so a dismissed failure leaves no entry behind and the map
    // cannot grow one row per run an owner ever looked at.
    if (isIdle(state)) states.delete(key);
    else states.set(key, state);
    version += 1;
    for (const listener of listeners) listener();
  };

  return {
    read: (key: string): NavigatorDecisionAnswerState => states.get(key) ?? IDLE_DECISION_ANSWER,
    version: (): number => version,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    isBusy: (key: string): boolean => inFlight.has(key),
    /** A read-only seam, so a test can prove nothing accumulates. */
    size: (): number => states.size,

    /**
     * Send one answer, or refuse.
     *
     * Returns null when the gate refused — a second click while the first is
     * outstanding. A failure is terminal and inline; the owner decides whether
     * to try again.
     */
    answer: async (
      key: string,
      runner: () => Promise<AsyncResult.AsyncResult<PeerLoopAnswerOwnerDecisionResult, unknown>>,
    ): Promise<PeerLoopAnswerOwnerDecisionResult | null> => {
      if (inFlight.has(key)) return null;
      inFlight.add(key);
      publish(key, { pending: true, failure: null });
      try {
        const result = await runner();
        if (AsyncResult.isSuccess(result)) {
          publish(key, IDLE_DECISION_ANSWER);
          return result.value;
        }
        publish(key, {
          pending: false,
          failure: describeOwnerDecisionAnswerFailure(
            AsyncResult.isFailure(result)
              ? Option.getOrNull(Cause.findErrorOption(result.cause))
              : null,
          ),
        });
        return null;
      } catch {
        // A defect is still terminal: left to escape it would keep every copy
        // of the control disabled for ever.
        publish(key, { pending: false, failure: describeOwnerDecisionAnswerFailure(null) });
        return null;
      } finally {
        inFlight.delete(key);
      }
    },

    dismissFailure: (key: string): void => {
      const current = states.get(key);
      if (current === undefined || current.failure === null) return;
      publish(key, { ...current, failure: null });
    },

    /** Tests only. Nothing in the app forgets an outstanding answer. */
    reset: (): void => {
      states.clear();
      inFlight.clear();
      version += 1;
      for (const listener of listeners) listener();
    },
  } as const;
}

export type NavigatorDecisionAnswerStore = ReturnType<typeof createNavigatorDecisionAnswerStore>;

/** One store for the app: two copies of a decision must share one gate. */
export const navigatorDecisionAnswerStore = createNavigatorDecisionAnswerStore();

/**
 * Answer one linked run's owner decision.
 *
 * The request is the whole safety story and it is four fields: a thread, a run,
 * the fingerprint of the decision on screen, and which option. No text of any
 * kind travels — the server resolves the option out of a reading it takes for
 * itself, and refuses the fingerprint if the run has moved on.
 *
 * BOTH OUTCOMES RE-READ. Answered means the run is about to move, and the card
 * should show that without waiting for a poll. Refresh-required means the card
 * is already showing something the run has left, which is precisely when a
 * re-read is owed — and it is a re-read of the *snapshot*, not only the summary,
 * because a Reviewer can ask a second question without the run list's own
 * `updatedAt` having reached this client yet.
 */
export function useNavigatorOwnerDecisionAnswer(input: {
  readonly environmentId: EnvironmentId | null;
  readonly runId: string;
  /** Re-read the run list. Never starts anything. */
  readonly refreshRuns: () => void;
  /** Re-read this run's attached snapshot, unconditionally. */
  readonly refreshSnapshot: () => void;
}) {
  const answerOwnerDecision = useAtomCommand(peerLoopCommands.answerOwnerDecision, {
    reportFailure: false,
  });

  useSyncExternalStore(
    navigatorDecisionAnswerStore.subscribe,
    navigatorDecisionAnswerStore.version,
    navigatorDecisionAnswerStore.version,
  );

  const { environmentId, runId, refreshRuns, refreshSnapshot } = input;
  const key =
    environmentId === null
      ? null
      : navigatorDecisionKey({ environmentId: String(environmentId), runId });
  const state = key === null ? IDLE_DECISION_ANSWER : navigatorDecisionAnswerStore.read(key);

  const answer = useCallback(
    async (action: NavigatorOwnerDecisionAction, optionIndex: number): Promise<void> => {
      if (environmentId === null || key === null) return;
      const result = await navigatorDecisionAnswerStore.answer(key, () =>
        answerOwnerDecision({
          environmentId,
          // EXACTLY THESE FOUR. Not the option's text, not the question, not
          // the reason, not the snapshot the client is holding.
          input: {
            threadId: action.threadId,
            runId: action.runId,
            decisionFingerprint: action.fingerprint,
            optionIndex,
          },
        }),
      );
      // A refused second click returns null and must not re-read: the first
      // click's own completion does that.
      if (result === null) return;
      // Both outcomes. `answered` because the run is moving; `refresh-required`
      // because this card is demonstrably behind, and re-reading is the whole
      // of the response — no error, no success, just the current question.
      refreshRuns();
      refreshSnapshot();
    },
    [answerOwnerDecision, environmentId, key, refreshRuns, refreshSnapshot],
  );

  const dismissFailure = useCallback(() => {
    if (key !== null) navigatorDecisionAnswerStore.dismissFailure(key);
  }, [key]);

  return { state, answer, dismissFailure } as const;
}
