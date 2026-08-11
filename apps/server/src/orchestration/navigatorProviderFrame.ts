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
 * The role frame itself is deliberately constant: no repository transcript, no
 * secrets, nothing that varies with external state. A frame that drifted would
 * be an uncontrolled channel into every provider request.
 *
 * One clearly delimited section may follow it, and only one: a bounded,
 * already-sanitized summary of the Peer Loop runs this conversation itself
 * launched. It arrives as a finished string from `NavigatorExecutionContext`,
 * which narrows Peer Loop's structured records down to the facts a model may
 * see. This module does not read Peer Loop, and does not decide what is in that
 * block — it decides where it goes and that a conversation without one is
 * framed exactly as it was before the block existed.
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

/** What separates the frame, the optional context, and the owner's words. */
const SECTION_SEPARATOR = "\n\n---\n\n";

/**
 * The text this turn should send to the provider.
 *
 * Coding threads get the owner's message byte for byte — the same string the
 * adapter has always received — so nothing about an ordinary turn changes. A
 * Navigator thread with no execution context is framed exactly as it was
 * before this parameter existed, which is what keeps a conversation that has
 * launched nothing free of an empty section it would have to interpret.
 *
 * The owner's text is always last, so the thing the model is answering is the
 * thing closest to it.
 */
export function providerMessageTextForThread(
  purpose: ThreadPurpose | undefined,
  ownerMessageText: string,
  /** Already bounded and sanitized by `NavigatorExecutionContext`, or null. */
  executionContext?: string | null,
): string {
  if (purpose !== "navigator") {
    return ownerMessageText;
  }
  const sections =
    executionContext === undefined || executionContext === null || executionContext.length === 0
      ? [NAVIGATOR_PROVIDER_FRAME, ownerMessageText]
      : [NAVIGATOR_PROVIDER_FRAME, executionContext, ownerMessageText];
  return sections.join(SECTION_SEPARATOR);
}
