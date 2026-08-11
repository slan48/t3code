/**
 * The provider-visible Navigator role frame.
 *
 * A Navigator thread runs on the same adapters as every coding thread. What
 * makes it Navigator, from the model's point of view, is this frame — one
 * bounded, constant preamble wrapped around the owner's message at the shared
 * provider-command boundary, so Codex, Claude, Cursor, Grok and OpenCode all
 * receive the same role without a single adapter knowing Navigator exists.
 *
 * TWO THINGS THIS IS NOT.
 *
 * It is not the persisted message. The owner's text is stored, replayed, shown
 * in the timeline and used for title generation exactly as typed; the frame is
 * added only to what goes out to the provider on this turn. Persisting the
 * wrapper would put words in the owner's mouth in their own transcript.
 *
 * It is not enforcement. A model can be asked not to edit files; it cannot be
 * *prevented* from trying by a sentence. The actual boundary is elsewhere and
 * is not made of prose: a navigator thread is pinned to `approval-required`
 * and `plan` mode, owns no worktree, and the orchestration invariants refuse
 * every command that would change any of that. The frame shapes behaviour so
 * the conversation is useful; the server is what makes it safe.
 *
 * Deliberately constant: no repository transcript, no Peer Loop run state, no
 * secrets, no mutable execution summary. A frame that varied with external
 * state would be a channel for that state into every provider request.
 *
 * @module NavigatorProviderFrame
 */
import type { ThreadPurpose } from "@t3tools/contracts";

/**
 * The frame, verbatim.
 *
 * Exported so a test can assert the provider request contains exactly this and
 * the persisted message does not.
 */
export const NAVIGATOR_PROVIDER_FRAME = [
  "You are Navigator, the Owner's planning partner in T3 Code.",
  "",
  "Your job in this conversation:",
  "- discuss ideas, compare approaches, and weigh trade-offs with the Owner;",
  "- ask clarifying questions when the requirements are ambiguous;",
  "- maintain and refine one lightweight Execution Proposal using your existing",
  "  plan mechanism, updating it as the discussion changes it.",
  "",
  "What you do not do:",
  "- you do not implement anything, edit files, or run implementation commands;",
  "- you do not claim that any work has been executed;",
  "- you are not the Reviewer, and you do not approve, recover, or decide Peer",
  "  Loop owner decisions.",
  "",
  "Discussing or agreeing with an approach is not authorization to execute it.",
  "Executing a proposal is a separate, explicit action the Owner takes.",
].join("\n");

/**
 * The text this turn should send to the provider.
 *
 * Coding threads get the owner's message byte for byte — the same string the
 * adapter has always received — so nothing about an ordinary turn changes.
 */
export function providerMessageTextForThread(
  purpose: ThreadPurpose | undefined,
  ownerMessageText: string,
): string {
  if (purpose !== "navigator") {
    return ownerMessageText;
  }
  return `${NAVIGATOR_PROVIDER_FRAME}\n\n---\n\n${ownerMessageText}`;
}
