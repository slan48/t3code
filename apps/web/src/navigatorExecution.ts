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
  PeerLoopRunSummary,
  ThreadId,
  ThreadPurpose,
} from "@t3tools/contracts";

import {
  describeError,
  describeRunAttention,
  existingRunIdFromRefusal,
  type PeerLoopAttentionPresentation,
  type PeerLoopErrorPresentation,
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
  | "executing";

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
  /** False while the turn that produced the proposal is still running. */
  readonly latestTurnSettled: boolean;
  readonly proposal: ExecutableProposal | null;
  /** Links already recorded for this proposal, durable or just returned. */
  readonly executionCount: number;
  /** True while this client's own Execute request is outstanding. */
  readonly executing: boolean;
}): ExecuteProposalAvailability {
  if (input.purpose !== "navigator") return blocked("not-a-navigator-thread");
  if (!input.isDurableThread) return blocked("draft-conversation");
  if (input.proposal === null) return blocked("no-proposal");
  if (!input.latestTurnSettled) return blocked("proposal-not-settled");
  if (input.executionCount > 0) return blocked("already-executed");
  if (input.proposal.implementedAt !== null || input.proposal.implementationThreadId !== null) {
    return blocked("already-implemented");
  }
  if (input.executing) return blocked("executing");
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

/* -------------------------------------------------------- child cards */

export type NavigatorExecutionStatus =
  | {
      readonly kind: "summary";
      readonly attention: PeerLoopAttentionPresentation;
      readonly iteration: number;
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
        updatedAt: summary.updatedAt,
        queuedOwnerMessages: summary.queuedOwnerMessages,
      },
    };
  }
  if (input.unreadable.includes(input.link.runId))
    return { ...base, status: { kind: "unreadable" } };
  return { ...base, status: { kind: "unavailable" } };
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
  /** True when a Peer Loop run may exist despite the failure. Never retried. */
  readonly mayHaveStarted: boolean;
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
  };
}

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
    inspectorRunId: existingRunIdFromRefusal(error),
    mayHaveStarted: presentation.mayHaveApplied,
  };
}

/** The connection failed before Peer Loop was involved. Nothing was started. */
export const EXECUTION_SEND_FAILED: NavigatorExecutionFailure = {
  presentation: {
    title: "Execute could not be sent",
    detail: `The connection to this environment failed, so no run was started. ${NEVER_RETRIED}`,
    code: null,
    tone: "warning",
    mayHaveApplied: false,
  },
  inspectorRunId: null,
  mayHaveStarted: false,
};

/**
 * An unexpected throw out of the RPC layer.
 *
 * Bounded and generic: whatever a defect carries was never meant for a remote
 * client. It is stated as possibly-started because this path cannot prove
 * otherwise, and it is still never retried.
 */
export const EXECUTION_SEND_FAILED_UNEXPECTEDLY: NavigatorExecutionFailure = {
  presentation: {
    title: "Execute could not be sent",
    detail:
      "Something went wrong sending this. Check Peer Loop before trying again — a run may exist. " +
      NEVER_RETRIED,
    code: null,
    tone: "warning",
    mayHaveApplied: true,
  },
  inspectorRunId: null,
  mayHaveStarted: true,
};
