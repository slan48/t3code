/**
 * Executing a Navigator Execution Proposal, as pure decisions.
 *
 * Three questions live here, and none of them needs React:
 *
 *   - **May this proposal be executed at all?** A draft conversation, a coding
 *     thread, an unsettled turn, an already-linked proposal and one a coding
 *     thread already implemented are five different "no"s, and collapsing them
 *     would make the button appear in places it must not.
 *   - **What does a failure mean?** Peer Loop's own refusals and T3 Code's
 *     coordination failures are separate families with separate fixes.
 *     `link-not-confirmed` in particular means a run exists that T3 Code could
 *     not record — the one case where the honest answer is "do not press this
 *     again, go and look".
 *   - **What is this child execution doing?** Answered only from Peer Loop's
 *     structured run summary. A link with no summary is "status unavailable",
 *     never an invented lifecycle state.
 *
 * PEER LOOP OWNS EVERY MUTABLE RUN FACT. The durable association T3 Code keeps
 * is a run id, a proposal id and a timestamp; state, iteration, halt reason and
 * outcome are read live from Peer Loop's list and are never copied here.
 *
 * @module NavigatorExecution
 */
import type {
  EnvironmentId,
  OrchestrationPeerLoopExecution,
  OrchestrationProposedPlanId,
  PeerLoopError,
  PeerLoopExecutionCoordinationError,
  PeerLoopExecutionFailureReason,
  PeerLoopRunStateFile,
  PeerLoopRunSummary,
  ThreadId,
  ThreadPurpose,
  TurnId,
} from "@t3tools/contracts";

import { formatRelative } from "./agentRunFormat";
import {
  describeCompletionFromRecord,
  describeError,
  describeOwnerDecisionFromRecord,
  describeRunAttention,
  existingRunIdFromRefusal,
  type PeerLoopAttentionKey,
  type PeerLoopAttentionPresentation,
  type PeerLoopCompletion,
  type PeerLoopErrorPresentation,
  type PeerLoopOwnerDecision,
} from "./peerLoopPresentation";

/* --------------------------------------------------------- eligibility */

/**
 * Why an Execute action is not offered.
 *
 * Separate values rather than one boolean because they are shown differently:
 * a coding thread gets nothing at all, an already-executed proposal gets its
 * child execution card instead, and an in-flight one gets a pending button.
 */
export type ExecuteProposalBlockedReason =
  /** Not a planning conversation. Nothing about execution belongs here. */
  | "not-a-navigator-thread"
  /** A draft has no durable thread id, so there is nothing to execute against. */
  | "draft-conversation"
  | "no-proposal"
  /** The turn that produced it has not settled; the proposal can still change. */
  | "proposal-not-settled"
  /** Already linked to a Peer Loop run. The child card is the answer. */
  | "already-executed"
  /** Already implemented the ordinary way, by a coding thread. */
  | "already-implemented"
  /** This client is executing it right now. */
  | "executing"
  /**
   * The last attempt's outcome is not known.
   *
   * A run may exist. Offering Execute again would be an invitation to start a
   * second one, so the action is withheld until the owner has looked.
   */
  | "outcome-unknown";

/**
 * What the owner may do after a failed attempt.
 *
 * SEPARATE FROM `mayHaveStarted`, WHICH IS ABOUT THIS REQUEST. A
 * `proposal-already-executed` refusal is `mayHaveStarted: false` — this request
 * started nothing — and yet the proposal demonstrably has a run, so re-offering
 * Execute would be wrong. Overloading one boolean to answer both questions was
 * how those two cases got the same treatment.
 */
export type ExecutionRetryDisposition =
  /** Provably nothing started and nothing exists. The owner may press again. */
  | "retryable"
  /** A run already exists for this proposal. Look at it; do not start another. */
  | "inspect-existing"
  /** This request may have started a run. Withhold until the owner has looked. */
  | "unknown";

export interface ExecuteProposalAvailability {
  readonly canExecute: boolean;
  readonly blockedReason: ExecuteProposalBlockedReason | null;
}

const AVAILABLE: ExecuteProposalAvailability = { canExecute: true, blockedReason: null };
const blocked = (blockedReason: ExecuteProposalBlockedReason): ExecuteProposalAvailability => ({
  canExecute: false,
  blockedReason,
});

/** The proposal facts this decision needs. A subset, so a test can be honest. */
export interface ExecutableProposal {
  readonly id: OrchestrationProposedPlanId;
  readonly implementedAt: string | null;
  readonly implementationThreadId: string | null;
  /**
   * The turn that produced it, which is how "can this still change" is asked.
   *
   * Null for a plan whose turn the read model does not carry: unplaceable, and
   * therefore not claimable as the output of whatever is running now.
   */
  readonly turnId: TurnId | null;
}

/**
 * Whether this proposal may be handed to Peer Loop.
 *
 * Order matters. The structural answers come first — a coding thread and a
 * draft are not "proposals that cannot be executed yet", they are conversations
 * where the question does not arise — and the ones the owner can influence come
 * last, so the reason they are shown is the one they can act on.
 */
export function executeProposalAvailability(input: {
  readonly purpose: ThreadPurpose | undefined;
  /** True only for a thread the server has: a draft has no durable id. */
  readonly isDurableThread: boolean;
  /**
   * False while THIS PROPOSAL'S OWN producing turn can still change it.
   *
   * Not "the conversation is idle". A thread-wide answer was what withheld
   * every historical proposal on a rehydrated conversation, because a settled
   * thread arrives from the server with no latest-turn record at all — see
   * `unsettledTurnId` in `session-logic`.
   */
  readonly proposalSettled: boolean;
  readonly proposal: ExecutableProposal | null;
  /** Links already recorded for this proposal, durable or just returned. */
  readonly executionCount: number;
  /** True while this client's own Execute request is outstanding. */
  readonly executing: boolean;
  /**
   * What the last attempt left behind, or null if there was none.
   *
   * `unknown` covers both the typed cases Peer Loop is explicit about and every
   * unclassified client failure, because a lost response cannot prove the
   * server did nothing. `inspect-existing` is a different fact: this request
   * started nothing, and a run exists anyway.
   */
  readonly lastAttemptDisposition: ExecutionRetryDisposition | null;
}): ExecuteProposalAvailability {
  if (input.purpose !== "navigator") return blocked("not-a-navigator-thread");
  if (!input.isDurableThread) return blocked("draft-conversation");
  if (input.proposal === null) return blocked("no-proposal");
  if (!input.proposalSettled) return blocked("proposal-not-settled");
  if (input.executionCount > 0) return blocked("already-executed");
  if (input.proposal.implementedAt !== null || input.proposal.implementationThreadId !== null) {
    return blocked("already-implemented");
  }
  if (input.executing) return blocked("executing");
  if (input.lastAttemptDisposition === "unknown") return blocked("outcome-unknown");
  // The server says this proposal already has a run even though the client's
  // read model has not caught up. The failure notice links straight to it.
  if (input.lastAttemptDisposition === "inspect-existing") return blocked("already-executed");
  return AVAILABLE;
}

/**
 * Whether anything about execution belongs on this proposal's card.
 *
 * A coding thread's plan card must look exactly as it does today, and a draft
 * conversation has nothing to show either — no action and no children.
 */
export function showsExecutionArea(input: {
  readonly purpose: ThreadPurpose | undefined;
  readonly isDurableThread: boolean;
}): boolean {
  return input.purpose === "navigator" && input.isDurableThread;
}

/**
 * What the conversation knows about executing, derived once and handed down.
 *
 * ONE OBJECT, EVERY SURFACE. The Execute button in the timeline, the one in the
 * Plan sidebar and the composer's confirmation all decide from this and nothing
 * of their own — see {@link proposalExecutionAvailability}. Deliberately free of
 * anything Peer Loop reports: it travels through the timeline's row context, and
 * putting a five-second poll in it would re-render every row in the
 * conversation.
 */
export interface NavigatorExecutionFacts {
  readonly environmentId: EnvironmentId;
  /** Null for a draft conversation: there is nothing durable to execute. */
  readonly threadId: ThreadId | null;
  readonly purpose: ThreadPurpose;
  /**
   * The turn still producing, or null when nothing is.
   *
   * DELIBERATELY NOT "IS THE THREAD SETTLED". That question cannot be answered
   * from a rehydrated conversation — the server clears its latest-turn pointer
   * whenever a session stops running — and answering it wrongly withheld every
   * proposal a conversation had ever produced until an unrelated provider turn
   * happened to repopulate the field.
   */
  readonly unsettledTurnId: TurnId | null;
  readonly executionsByProposal: ReadonlyMap<string, ReadonlyArray<OrchestrationPeerLoopExecution>>;
}

/**
 * Whether this proposal's own producing turn can still change it.
 *
 * A proposal from a turn that is not the one in flight is final, whatever else
 * the conversation is doing, and a conversation with nothing in flight has no
 * unfinished proposals at all.
 */
export function proposalIsSettled(input: {
  readonly proposal: ExecutableProposal;
  readonly unsettledTurnId: TurnId | null;
}): boolean {
  if (input.unsettledTurnId === null) return true;
  if (input.proposal.turnId === null) return true;
  return input.proposal.turnId !== input.unsettledTurnId;
}

/** What the per-proposal gate remembers about the last attempt. */
export interface NavigatorExecutionAttempt {
  /** True while this client's own request is outstanding. */
  readonly pending: boolean;
  /** Null when nothing has been attempted, or nothing failed. */
  readonly disposition: ExecutionRetryDisposition | null;
}

/** Nothing attempted. What a proposal's first mount looks like. */
export const NO_EXECUTION_ATTEMPT: NavigatorExecutionAttempt = {
  pending: false,
  disposition: null,
};

/**
 * Whether this proposal may be executed, from the conversation's facts and the
 * gate's own record of what the last attempt left behind.
 *
 * ONE PLACE THAT TURNS THE CONVERSATION'S FACTS INTO A PER-PROPOSAL ANSWER.
 * Settledness in particular is derived here rather than passed in, because
 * passing it in is how a thread-wide "is the conversation busy" ended up
 * deciding a per-proposal question — and on a rehydrated conversation, where
 * the server carries no latest-turn pointer at all, that answer withheld every
 * proposal the thread had ever produced.
 *
 * A retryable refusal is nowhere in this: `CONTROL_UNAVAILABLE` and
 * `PROJECT_HAS_UNFINISHED_RUN` are provable pre-start refusals, so a proposal
 * carrying one is executable the moment it mounts, with no turn, no
 * regeneration and no refresh in between. Only `unknown` and `inspect-existing`
 * withhold the action, and they do it here, once, for every surface.
 */
export function proposalExecutionAvailability(input: {
  readonly facts: NavigatorExecutionFacts;
  /** Null when the conversation has no proposal a confirmation could be about. */
  readonly proposal: ExecutableProposal | null;
  readonly attempt: NavigatorExecutionAttempt;
}): ExecuteProposalAvailability {
  return executeProposalAvailability({
    purpose: input.facts.purpose,
    isDurableThread: input.facts.threadId !== null,
    proposalSettled:
      input.proposal === null
        ? false
        : proposalIsSettled({
            proposal: input.proposal,
            unsettledTurnId: input.facts.unsettledTurnId,
          }),
    proposal: input.proposal,
    executionCount:
      input.proposal === null
        ? 0
        : (input.facts.executionsByProposal.get(input.proposal.id)?.length ?? 0),
    executing: input.attempt.pending,
    lastAttemptDisposition: input.attempt.disposition,
  });
}

/* ------------------------------------------------------------- request */

/**
 * Exactly what goes on the wire, and nothing else.
 *
 * Built here rather than inline at the call site so "what does T3 Code send"
 * is one assertable value. A client cannot name the project, the objective, a
 * run id, `newRun`, an owner policy or a permission mode: the server derives
 * the project and the objective from its own record, and Peer Loop owns the
 * rest. Sending any of them would let a press aim a run at a directory the
 * owner never reviewed.
 *
 * Peer Loop's optional `safetyLimit` is not sent either. This surface does not
 * offer the owner a way to choose one, and inventing a bound they never asked
 * for would be T3 Code making a Peer Loop decision.
 */
export function buildExecuteProposalRequest(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly proposedPlanId: OrchestrationProposedPlanId;
}): {
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly threadId: ThreadId;
    readonly proposedPlanId: OrchestrationProposedPlanId;
  };
} {
  return {
    environmentId: input.environmentId,
    input: { threadId: input.threadId, proposedPlanId: input.proposedPlanId },
  };
}

/* -------------------------------------------------------- reconciliation */

/**
 * A pair of ids, spelled one way.
 *
 * Length-prefixed rather than joined by a separator: a proposal id and a run id
 * are both opaque strings from elsewhere, and two different pairs must never
 * produce the same key just because one of them contains the separator.
 */
export const executionLinkKey = (link: {
  readonly proposedPlanId: string;
  readonly runId: string;
}): string => `${link.proposedPlanId.length}:${link.proposedPlanId}:${link.runId}`;

/**
 * The durable links plus one this client has just been handed.
 *
 * `peerLoop.executeProposal` returns the association it recorded, and the
 * synchronized thread read model catches up a moment later. Without this the
 * card would blank out in between — or worse, offer Execute a second time for a
 * run that already exists.
 *
 * The durable link wins on an exact proposal-and-run match, which is the only
 * match that means "the same execution". Nothing is stored twice: the local
 * link is dropped the instant its durable twin appears.
 */
export function reconcileExecutionLinks(
  durable: ReadonlyArray<OrchestrationPeerLoopExecution>,
  retained: ReadonlyArray<OrchestrationPeerLoopExecution>,
): ReadonlyArray<OrchestrationPeerLoopExecution> {
  if (retained.length === 0) return durable;
  const seen = new Set(durable.map(executionLinkKey));
  const merged = [...durable];
  for (const link of retained) {
    const key = executionLinkKey(link);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(link);
  }
  return merged.length === durable.length ? durable : merged;
}

/** True once the read model carries the link this client is holding on to. */
export function localLinkIsDurable(
  durable: ReadonlyArray<OrchestrationPeerLoopExecution>,
  local: OrchestrationPeerLoopExecution | null,
): boolean {
  if (local === null) return false;
  return durable.some((entry) => executionLinkKey(entry) === executionLinkKey(local));
}

/**
 * Links indexed by the proposal they belong to, in association order.
 *
 * Association order is the durable list's own order, which is chronological.
 * It is preserved rather than re-sorted, and a link is never shown under a
 * proposal other than its own.
 */
export function groupExecutionsByProposal(
  links: ReadonlyArray<OrchestrationPeerLoopExecution>,
): ReadonlyMap<string, ReadonlyArray<OrchestrationPeerLoopExecution>> {
  const byProposal = new Map<string, OrchestrationPeerLoopExecution[]>();
  for (const link of links) {
    const existing = byProposal.get(link.proposedPlanId);
    if (existing === undefined) byProposal.set(link.proposedPlanId, [link]);
    else existing.push(link);
  }
  return byProposal;
}

/* --------------------------------------------------------- observation */

/**
 * Which run-list atom a Navigator conversation reads. Usually none.
 *
 * THE FIRST PEER LOOP QUERY IS WHAT STARTS THE BRIDGE SUBPROCESS. Opening
 * `/navigator`, a Navigator draft, or a conversation that has never executed
 * anything must not spawn `peer-loop` on a machine that has never used it, so
 * the atom is not merely ignored — it is never asked for. `runsAtomFor` is a
 * factory rather than an atom precisely so "not called" is observable.
 *
 * The environment is the thread's own. Peer Loop run ids are per-machine, and
 * reading another environment's list would match a link against a stranger's
 * run.
 */
export function selectNavigatorRunListAtom<A>(input: {
  readonly environmentId: EnvironmentId | null;
  readonly linkCount: number;
  readonly runsAtomFor: (environmentId: EnvironmentId) => A;
  /** What to read when there is nothing to observe. Must query nothing. */
  readonly none: A;
}): A {
  if (input.environmentId === null || input.linkCount === 0) return input.none;
  return input.runsAtomFor(input.environmentId);
}

/**
 * The attention states where a structured snapshot tells the owner something
 * the run list cannot.
 *
 * Deliberately two. `DONE` has a Reviewer summary, a final state and a
 * repository HEAD the list does not carry; `OWNER_REQUIRED` has the question
 * itself. An ordinary working run has nothing extra worth a second RPC, and
 * attaching to every historical child run would cost one bridge request per
 * card for information nobody asked for.
 */
const SNAPSHOT_WORTH_READING: ReadonlySet<PeerLoopAttentionKey> = new Set([
  "done",
  "owner-decision",
]);

export function executionSnapshotIsUseful(status: NavigatorExecutionStatus): boolean {
  return status.kind === "summary" && SNAPSHOT_WORTH_READING.has(status.attention.key);
}

/**
 * Which snapshot atom a child execution reads. Usually none.
 *
 * Same shape and same reason as the run list: a factory rather than an atom,
 * so "never asked for" is observable. Keyed by environment *and* run, so the
 * timeline copy and the sidebar copy of one execution share a single
 * `peerLoop.attachRun` rather than issuing two bridge requests for the same
 * answer.
 */
export function selectNavigatorSnapshotAtom<A>(input: {
  readonly environmentId: EnvironmentId | null;
  readonly runId: string;
  readonly wanted: boolean;
  readonly snapshotAtomFor: (environmentId: EnvironmentId, runId: string) => A;
  /** What to read when there is nothing to observe. Must query nothing. */
  readonly none: A;
}): A {
  if (!input.wanted || input.environmentId === null) return input.none;
  return input.snapshotAtomFor(input.environmentId, input.runId);
}

/* -------------------------------------------------------- child cards */

export type NavigatorExecutionStatus =
  | {
      readonly kind: "summary";
      readonly attention: PeerLoopAttentionPresentation;
      readonly iteration: number;
      /** Peer Loop's own `updatedAt`, already relative. Null if unparseable. */
      readonly updatedLabel: string | null;
      /**
       * Peer Loop's structured `updatedAt`. What a snapshot is measured against:
       * a reading stamped before this one is a reading of an earlier run.
       */
      readonly updatedAt: string;
      readonly queuedOwnerMessages: number;
    }
  /** Peer Loop named this run as one it could not read. Said, not hidden. */
  | { readonly kind: "unreadable" }
  /** No summary and no complaint. Neutral: not a lifecycle state. */
  | { readonly kind: "unavailable" };

export interface NavigatorExecutionPresentation {
  readonly runId: string;
  /** When T3 Code recorded the link — not when Peer Loop started the run. */
  readonly linkedAt: string;
  readonly status: NavigatorExecutionStatus;
}

/** How much of a run id is shown before it is just noise. The link keeps it all. */
export const NAVIGATOR_RUN_ID_DISPLAY_CHARS = 24;

export const compactRunId = (runId: string): string =>
  runId.length <= NAVIGATOR_RUN_ID_DISPLAY_CHARS
    ? runId
    : `${runId.slice(0, NAVIGATOR_RUN_ID_DISPLAY_CHARS - 1)}…`;

/**
 * One child execution, from Peer Loop's structured run list and nothing else.
 *
 * No prompt is parsed, no Builder report is read, no run directory is opened.
 * When the list has no summary for this run the card says the status is
 * unavailable — a run T3 Code cannot see is not a run that is idle, finished or
 * failed, and guessing between those is exactly the mistake this avoids.
 */
export function describeExecution(input: {
  readonly link: OrchestrationPeerLoopExecution;
  readonly runs: ReadonlyArray<PeerLoopRunSummary>;
  readonly unreadable: ReadonlyArray<string>;
  /** For the relative label. Passed in so this stays pure and testable. */
  readonly nowMs: number;
}): NavigatorExecutionPresentation {
  const summary = input.runs.find((run) => run.runId === input.link.runId) ?? null;
  const base = { runId: input.link.runId, linkedAt: input.link.createdAt } as const;
  if (summary !== null) {
    return {
      ...base,
      status: {
        kind: "summary",
        attention: describeRunAttention(summary),
        iteration: summary.iteration,
        // The same relative helper the Peer Loop index uses, so "23m ago"
        // reads the same on both surfaces and no raw ISO reaches the owner.
        updatedLabel: formatRelative(summary.updatedAt, input.nowMs),
        updatedAt: summary.updatedAt,
        queuedOwnerMessages: summary.queuedOwnerMessages,
      },
    };
  }
  if (input.unreadable.includes(input.link.runId))
    return { ...base, status: { kind: "unreadable" } };
  return { ...base, status: { kind: "unavailable" } };
}

/* -------------------------------------------------- structured detail */

/**
 * A run's durable snapshot as this card sees it.
 *
 * `peerLoop.attachRun` and nothing else: a read-only snapshot, no event
 * subscription, no activity replay. `state` is Peer Loop's own run state file.
 */
export interface NavigatorExecutionSnapshot {
  readonly status: "absent" | "loading" | "failed" | "ready";
  readonly state: PeerLoopRunStateFile | null;
}

export const NO_EXECUTION_SNAPSHOT: NavigatorExecutionSnapshot = {
  status: "absent",
  state: null,
};

/**
 * The extra, structured paragraph under a child execution's status line.
 *
 * Only two attention states produce one, and both come from Peer Loop's own
 * `lastReviewerDecision` through the helpers the advanced inspector uses. When
 * the snapshot has not arrived, failed, or carries no structured decision, that
 * is said — the status line above it is never weakened or second-guessed.
 */
export type NavigatorExecutionDetail =
  | { readonly kind: "none" }
  | { readonly kind: "loading" }
  /** The snapshot read failed. The run-list status stands unchanged. */
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "completion";
      readonly completion: PeerLoopCompletion;
      /** Peer Loop's own recorded HEAD. Never derived by walking git here. */
      readonly head: string | null;
      readonly branch: string | null;
    }
  /** Peer Loop says DONE and recorded no structured completion decision. */
  | { readonly kind: "completion-missing" }
  | { readonly kind: "owner-required"; readonly decision: PeerLoopOwnerDecision }
  /** Waiting on the owner, with no structured question recorded. */
  | { readonly kind: "owner-required-missing" };

/** A git object id is short; anything longer is not one, so it is bounded. */
export const NAVIGATOR_HEAD_DISPLAY_CHARS = 40;

const boundedRef = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= NAVIGATOR_HEAD_DISPLAY_CHARS
    ? trimmed
    : `${trimmed.slice(0, NAVIGATOR_HEAD_DISPLAY_CHARS - 1)}…`;
};

export function describeExecutionDetail(input: {
  readonly status: NavigatorExecutionStatus;
  readonly snapshot: NavigatorExecutionSnapshot;
}): NavigatorExecutionDetail {
  // A driverless or interrupted run is NOT a run asking an owner a question,
  // and this is where that stays true: nothing outside the two useful states
  // gets a structured block at all.
  if (!executionSnapshotIsUseful(input.status)) return { kind: "none" };
  if (input.snapshot.status === "absent") return { kind: "none" };
  if (input.snapshot.status === "loading") return { kind: "loading" };
  if (input.snapshot.status === "failed") return { kind: "unavailable" };

  const state = input.snapshot.state;
  if (state === null) return { kind: "unavailable" };
  const decision = state.lastReviewerDecision;
  const attention = input.status.kind === "summary" ? input.status.attention.key : "none";

  if (attention === "done") {
    const completion = describeCompletionFromRecord(decision);
    if (completion === null) return { kind: "completion-missing" };
    return {
      kind: "completion",
      completion,
      head: boundedRef(state.repo?.head),
      branch: boundedRef(state.repo?.branch),
    };
  }

  const owner = describeOwnerDecisionFromRecord(decision);
  return owner === null
    ? { kind: "owner-required-missing" }
    : { kind: "owner-required", decision: owner };
}

/* --------------------------------------------------- answering a decision */

/**
 * One option, and the index Peer Loop gave it.
 *
 * THE INDEX IS THE OPTION'S OWN, NOT ITS POSITION ON SCREEN. Presentation is
 * allowed to bound a long label or drop an empty one; renumbering what is left
 * would send an owner's click to a different sentence, and the server resolves
 * the text by exactly this number out of the decision it re-reads.
 */
export interface NavigatorOwnerDecisionOption {
  /** The position in Peer Loop's own `options` array. Never re-derived. */
  readonly index: number;
  readonly label: string;
}

/**
 * What an owner may actually answer, from the run's own snapshot.
 *
 * Null whenever anything about the answer would be a guess: no fresh reading,
 * a run that is not waiting, a waiting run with no structured question, an
 * answer already queued, a conversation with no durable thread or no link to
 * this run, or a purpose that may not answer at all.
 */
export interface NavigatorOwnerDecisionAction {
  readonly runId: string;
  readonly threadId: ThreadId;
  /** Names the exact decision on screen. Recomputed server-side before use. */
  readonly fingerprint: string;
  /** Every option Peer Loop recorded, in its order, with its own index. */
  readonly options: ReadonlyArray<NavigatorOwnerDecisionOption>;
}

/**
 * The answerable decision this card is showing, or none.
 *
 * DERIVED FROM THE ATTACHED SNAPSHOT AND NOTHING ELSE. Not the run-list
 * summary, which has no question in it; not the presented detail, whose text is
 * bounded for display; not a durable orchestration record, which holds no
 * mutable run state at all. The fingerprint has to name what Peer Loop wrote,
 * character for character, or the server will rightly refuse it.
 */
export function describeOwnerDecisionAction(input: {
  readonly snapshot: NavigatorExecutionSnapshot;
  /** This conversation's durable thread. Null in a draft. */
  readonly threadId: ThreadId | null;
  readonly runId: string;
  /** True once T3 Code holds a link from this thread to this run. */
  readonly linkedToThread: boolean;
  /** The conversation's purpose capability. UI hygiene, checked again below. */
  readonly capable: boolean;
  /** The fingerprint of the decision, from the shared helper. */
  readonly fingerprintOf: (input: {
    readonly decision: PeerLoopRunStateFile["lastReviewerDecision"];
    readonly iteration: number;
  }) => string | null;
}): NavigatorOwnerDecisionAction | null {
  if (!input.capable) return null;
  if (input.threadId === null || !input.linkedToThread) return null;
  if (input.snapshot.status !== "ready") return null;
  const state = input.snapshot.state;
  if (state === null) return null;
  if (state.state !== "owner_required") return null;
  const decision = state.lastReviewerDecision;
  if (decision === null || decision.decision !== "OWNER_REQUIRED") return null;
  // An answer is already on its way. A second one would be delivered too, and
  // the server refuses it anyway — so the control does not offer it.
  if (state.queuedOwnerMessages.length > 0) return null;
  const fingerprint = input.fingerprintOf({ decision, iteration: state.iteration });
  if (fingerprint === null) return null;
  return {
    runId: input.runId,
    threadId: input.threadId,
    fingerprint,
    options: decision.options.map((label, index) => ({ index, label })),
  };
}

/** How much of an option is shown before it is unreadable. The click is exact. */
export const NAVIGATOR_OPTION_DISPLAY_CHARS = 160;

/**
 * The options a card draws, with their own indices intact.
 *
 * An option Peer Loop recorded as empty has nothing to put on a button, so it
 * is not drawn — and every other option keeps the number it came with. That is
 * the whole reason this returns the index rather than relying on the caller's
 * own loop counter.
 */
export function presentOwnerDecisionOptions(
  options: ReadonlyArray<NavigatorOwnerDecisionOption>,
): ReadonlyArray<NavigatorOwnerDecisionOption> {
  const shown: Array<NavigatorOwnerDecisionOption> = [];
  for (const option of options) {
    const trimmed = option.label.trim();
    if (trimmed.length === 0) continue;
    shown.push({
      index: option.index,
      label:
        trimmed.length <= NAVIGATOR_OPTION_DISPLAY_CHARS
          ? trimmed
          : `${trimmed.slice(0, NAVIGATOR_OPTION_DISPLAY_CHARS - 1)}\u2026`,
    });
  }
  return shown;
}

/* ------------------------------------------------------------- failures */

export interface NavigatorExecutionFailure {
  readonly presentation: PeerLoopErrorPresentation;
  /**
   * A run to open in the advanced inspector, when the failure named one.
   *
   * Structured, and exact. An owner recovering from `link-not-confirmed` must
   * not have to read a run id out of a sentence and retype it.
   */
  readonly inspectorRunId: string | null;
  /**
   * True when *this request* may have left a run behind. Never retried.
   *
   * Peer Loop's and the coordinator's own answer, passed through. It is not the
   * same question as whether Execute should be offered again — see
   * {@link NavigatorExecutionFailure.disposition}.
   */
  readonly mayHaveStarted: boolean;
  /** What the owner may do next. See {@link ExecutionRetryDisposition}. */
  readonly disposition: ExecutionRetryDisposition;
}

const NEVER_RETRIED =
  "Nothing was retried. Starting again would create a second run rather than repeating this one.";

const COORDINATION_TITLES: Readonly<Record<PeerLoopExecutionFailureReason, string>> = {
  "navigator-thread-not-found": "This conversation is no longer available",
  "not-a-navigator-thread": "This is not a planning conversation",
  "proposal-not-found": "This Execution Proposal is no longer available",
  "proposal-already-executed": "This Execution Proposal has already been executed",
  "proposal-already-implemented": "This Execution Proposal was already implemented",
  "project-not-found": "This conversation's project is not available",
  "coordination-failed": "T3 Code could not read its own record",
  "link-not-confirmed": "The run started, but the link was not recorded",
};

/**
 * What an owner is told, per reason.
 *
 * Fixed sentences. Nothing from the server is interpolated: the coordination
 * error's own `detail` is assembled from ids the client already sent, but the
 * only variable worth showing is the run id, and that travels structurally so
 * it can become a link rather than prose.
 */
const COORDINATION_DETAILS: Readonly<Record<PeerLoopExecutionFailureReason, string>> = {
  "navigator-thread-not-found": `T3 Code has no record of this conversation, so nothing was started. ${NEVER_RETRIED}`,
  "not-a-navigator-thread":
    "Only a Navigator conversation's Execution Proposal can be handed to Peer Loop. Nothing was started.",
  "proposal-not-found": `The proposal is no longer on this conversation, so nothing was started. ${NEVER_RETRIED}`,
  "proposal-already-executed":
    "A Peer Loop run was already started from this proposal. Open that execution rather than starting another.",
  "proposal-already-implemented":
    "A coding thread already implemented this proposal. Nothing was started.",
  "project-not-found":
    "This conversation's project is gone or inactive, so there is no workspace to run in. Nothing was started.",
  "coordination-failed": `T3 Code could not read the record it needed, so nothing was started. ${NEVER_RETRIED}`,
  "link-not-confirmed":
    "Peer Loop started a run and T3 Code could not record it against this proposal. " +
    "Do not press Execute again — that would start a second run. " +
    "Open the execution in the advanced inspector to see where it stands.",
};

const COORDINATION_TONES: Readonly<
  Record<PeerLoopExecutionFailureReason, PeerLoopErrorPresentation["tone"]>
> = {
  "navigator-thread-not-found": "warning",
  "not-a-navigator-thread": "neutral",
  "proposal-not-found": "warning",
  "proposal-already-executed": "neutral",
  "proposal-already-implemented": "neutral",
  "project-not-found": "warning",
  "coordination-failed": "warning",
  // A run exists that T3 Code cannot account for. Nothing else here is that.
  "link-not-confirmed": "danger",
};

export function describeCoordinationError(
  error: PeerLoopExecutionCoordinationError,
): NavigatorExecutionFailure {
  return {
    presentation: {
      title: COORDINATION_TITLES[error.reason],
      detail: COORDINATION_DETAILS[error.reason],
      // Peer Loop refusal codes are Peer Loop's. A coordination reason is not
      // one and must not be dressed as one.
      code: null,
      tone: COORDINATION_TONES[error.reason],
      mayHaveApplied: error.mayHaveStarted,
    },
    inspectorRunId: error.runId,
    mayHaveStarted: error.mayHaveStarted,
    disposition: COORDINATION_DISPOSITIONS[error.reason],
  };
}

/**
 * What each coordination reason leaves the owner able to do.
 *
 * Everything before `link-not-confirmed` happens before Peer Loop is called, so
 * pressing Execute again once the cause is fixed is safe — except
 * `proposal-already-executed`, where nothing started but a run exists anyway.
 */
const COORDINATION_DISPOSITIONS: Readonly<
  Record<PeerLoopExecutionFailureReason, ExecutionRetryDisposition>
> = {
  "navigator-thread-not-found": "retryable",
  "not-a-navigator-thread": "retryable",
  "proposal-not-found": "retryable",
  // `mayHaveStarted` is false and this is still not retryable: the run exists.
  "proposal-already-executed": "inspect-existing",
  "proposal-already-implemented": "retryable",
  "project-not-found": "retryable",
  "coordination-failed": "retryable",
  "link-not-confirmed": "unknown",
};

/**
 * A Peer Loop refusal, timeout or transport failure from this same call.
 *
 * `describeError` already carries the refusal code and the timeout's
 * `mayHaveApplied`; both survive here unchanged. A duplicate-run refusal names
 * the run that already exists, and that becomes the inspector link.
 */
export function describePeerLoopExecutionError(error: PeerLoopError): NavigatorExecutionFailure {
  const presentation = describeError(error);
  return {
    presentation,
    // A `PROJECT_HAS_UNFINISHED_RUN` refusal names a run in this *project*.
    // That run is worth linking to and is NOT this proposal's execution, so the
    // disposition stays retryable: nothing started here, and the owner may
    // press Execute again once that other run finishes.
    inspectorRunId: existingRunIdFromRefusal(error),
    mayHaveStarted: presentation.mayHaveApplied,
    disposition: presentation.mayHaveApplied ? "unknown" : "retryable",
  };
}

/**
 * A failure nothing typed explains: a dropped socket, a lost response, an
 * unexpected throw out of the RPC layer.
 *
 * STATED AS UNKNOWN, NOT AS "NOTHING HAPPENED". A request that never came back
 * is not a request the server refused: `peerLoop.executeProposal` may have
 * reached the coordinator, started a run and recorded the link while the answer
 * was in flight. Claiming "no run was started" here would be a guess, and the
 * cost of being wrong is a second Reviewer session. So the outcome is reported
 * as unknown, Execute is withheld, nothing is retried, and the owner is sent to
 * the Peer Loop inspector — with no run id to link to, that means its index.
 *
 * Bounded and generic on purpose: whatever a defect or a transport error
 * carried was never meant for a remote client, and none of it is shown.
 */
export const EXECUTION_RESULT_UNKNOWN: NavigatorExecutionFailure = {
  presentation: {
    title: "Execute was sent, and the result is unknown",
    detail:
      "The connection failed before Peer Loop's answer arrived, so T3 Code cannot say whether a " +
      `run started. Check Peer Loop before trying again. ${NEVER_RETRIED}`,
    code: null,
    tone: "warning",
    mayHaveApplied: true,
  },
  inspectorRunId: null,
  mayHaveStarted: true,
  disposition: "unknown",
};

/* --------------------------------------------- answering, when it fails */

/**
 * What an owner is told when answering itself failed.
 *
 * BOUNDED, AND NEVER A RAW SERVER STRING. Peer Loop's own refusals keep their
 * code because a code tells an operator which thing to fix; a coordination
 * refusal gets one fixed sentence per reason; anything else is a connection
 * that did not hold. A stale view is NOT here at all — it is an outcome, and
 * the card re-reads and re-renders instead of showing an alarm.
 */
export interface NavigatorDecisionAnswerFailure {
  readonly title: string;
  readonly detail: string | null;
  readonly code: string | null;
}

const OWNER_DECISION_COORDINATION_DETAILS: Readonly<Record<string, string>> = {
  "run-not-linked-to-thread":
    "This conversation does not have a record of that run, so it cannot answer it.",
  "option-out-of-range": "That option is no longer part of this decision. Re-read the run.",
  "link-unreadable":
    "T3 Code could not read its own record of this conversation's runs. Nothing was sent.",
};

const ANSWER_FAILED_UNKNOWN: NavigatorDecisionAnswerFailure = {
  title: "The answer was not delivered",
  detail: "The connection failed before Peer Loop answered. Nothing else changed; try again.",
  code: null,
};

export function describeOwnerDecisionAnswerFailure(error: unknown): NavigatorDecisionAnswerFailure {
  if (typeof error !== "object" || error === null) return ANSWER_FAILED_UNKNOWN;
  const tagged = error as { readonly _tag?: unknown; readonly reason?: unknown };
  if (tagged._tag === "PeerLoopOwnerDecisionCoordinationError") {
    const reason = typeof tagged.reason === "string" ? tagged.reason : "";
    return {
      title: "Peer Loop would not take that answer",
      // A fixed sentence per reason. Nothing from the server is interpolated.
      detail: OWNER_DECISION_COORDINATION_DETAILS[reason] ?? "Re-read the run and try again.",
      code: null,
    };
  }
  if (typeof tagged._tag === "string" && tagged._tag.startsWith("PeerLoop")) {
    const presented = describeError(error as PeerLoopError);
    return { title: presented.title, detail: presented.detail, code: presented.code };
  }
  return ANSWER_FAILED_UNKNOWN;
}

/* ----------------------------------------------------- inspector target */

/**
 * Where a failure sends the owner to look.
 *
 * A named run wins. Failing that, anything that may have started a run goes to
 * the inspector index — "go and see whether one exists" is the only honest
 * instruction when T3 Code does not know. A failure that provably started
 * nothing sends the owner nowhere; there is nothing to look at.
 */
export type NavigatorInspectorTarget =
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "index" }
  | { readonly kind: "none" };

export function inspectorTargetFor(failure: NavigatorExecutionFailure): NavigatorInspectorTarget {
  if (failure.inspectorRunId !== null) return { kind: "run", runId: failure.inspectorRunId };
  return failure.disposition === "unknown" ? { kind: "index" } : { kind: "none" };
}
