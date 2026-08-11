/**
 * What a conversation of a given purpose is allowed to do.
 *
 * ONE DERIVATION, NOT A STRING COMPARISON PER COMPONENT. Scattering
 * `purpose === "navigator"` through the chat surface is how a control gets
 * missed: the next person adds a menu item and there is nothing to remind them
 * the question exists. A single record of capabilities makes the list
 * enumerable, reviewable and testable, and adding a field to it forces every
 * consumer to decide.
 *
 * This is presentation and dispatch hygiene, not security. The server's
 * orchestration invariants are what actually refuse a forbidden command; this
 * exists so T3 Code does not routinely send commands it knows will be refused,
 * and so the UI does not advertise actions a Navigator conversation cannot
 * perform.
 *
 * @module NavigatorCapabilities
 */
import type { ThreadPurpose } from "@t3tools/contracts";

export interface ThreadCapabilities {
  /** Change the provider permission mode (`thread.runtime-mode.set`). */
  readonly canChangeRuntimeMode: boolean;
  /** Leave plan mode for the implementing mode (`thread.interaction-mode.set`). */
  readonly canChangeInteractionMode: boolean;
  /** Pick a branch, worktree, or environment checkout for this thread. */
  readonly canChooseCheckout: boolean;
  /** Turn a proposed plan into work — in this thread or a new one. */
  readonly canImplementPlan: boolean;
  /** Open or create a terminal from the chat surface. */
  readonly canUseTerminals: boolean;
  /** Rewind the thread's worktree to an earlier checkpoint. */
  readonly canRevertCheckpoint: boolean;
  /** Diff/review actions that start a repository mutation. */
  readonly canStartRepositoryMutation: boolean;
  /** Answer a provider approval with `accept` / `acceptForSession`. */
  readonly canAcceptApprovals: boolean;
  /**
   * Answer a provider approval with `decline` / `cancel`.
   *
   * True for Navigator on purpose. The server explicitly permits clearing a
   * pending request, and blocking it would strand a Navigator conversation
   * with a question it could never answer.
   */
  readonly canDeclineApprovals: boolean;
  /** Ordinary conversation and plan refinement. Always true. */
  readonly canConverse: boolean;
}

const CODING_CAPABILITIES: ThreadCapabilities = {
  canChangeRuntimeMode: true,
  canChangeInteractionMode: true,
  canChooseCheckout: true,
  canImplementPlan: true,
  canUseTerminals: true,
  canRevertCheckpoint: true,
  canStartRepositoryMutation: true,
  canAcceptApprovals: true,
  canDeclineApprovals: true,
  canConverse: true,
};

/**
 * Navigator: talk, compare approaches, refine the Execution Proposal.
 *
 * Everything that would change the repository, the checkout, the permission
 * posture, or the conversation's own mode is off. Reading, navigating,
 * copying and conversing stay on — a planning conversation that could not
 * read anything would be useless, and none of it mutates.
 */
const NAVIGATOR_CAPABILITIES: ThreadCapabilities = {
  canChangeRuntimeMode: false,
  canChangeInteractionMode: false,
  canChooseCheckout: false,
  canImplementPlan: false,
  canUseTerminals: false,
  canRevertCheckpoint: false,
  canStartRepositoryMutation: false,
  canAcceptApprovals: false,
  canDeclineApprovals: true,
  canConverse: true,
};

export function threadCapabilities(purpose: ThreadPurpose | undefined): ThreadCapabilities {
  // Unknown means coding: an older shell without `purpose` is an ordinary
  // thread, and stripping its controls would be a regression, not caution.
  return purpose === "navigator" ? NAVIGATOR_CAPABILITIES : CODING_CAPABILITIES;
}

/* ------------------------------------------------------------- wording */

/**
 * What this conversation calls the plan the provider is maintaining.
 *
 * A Navigator plan is the thing an owner will later hand to Peer Loop, so it
 * reads as an Execution Proposal. A coding thread's plan keeps the wording it
 * has always had — renaming it would churn a surface this work does not own.
 */
export interface ProposalWording {
  /** Short badge text on the timeline card and the Plan sidebar. */
  readonly badge: string;
  /** Fallback title when the plan markdown has no heading. */
  readonly untitled: string;
}

export const CODING_PROPOSAL_WORDING: ProposalWording = {
  badge: "Plan",
  untitled: "Proposed plan",
};

export const NAVIGATOR_PROPOSAL_WORDING: ProposalWording = {
  badge: "Execution Proposal",
  untitled: "Execution Proposal",
};

export function proposalWording(purpose: ThreadPurpose | undefined): ProposalWording {
  return purpose === "navigator" ? NAVIGATOR_PROPOSAL_WORDING : CODING_PROPOSAL_WORDING;
}
