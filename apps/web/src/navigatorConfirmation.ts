/**
 * Recognizing an owner's confirmation to execute the current proposal.
 *
 * DELIBERATELY NARROW, DETERMINISTIC, AND WHOLE-UTTERANCE. There is no model
 * here, no fuzzy match, no substring search and no sentiment. The composer text
 * is normalized and compared against a short closed list; anything that is not
 * exactly one of those phrases is ordinary conversation and goes to the
 * provider like every other message.
 *
 * That narrowness is the safety property. "let's do it after we change the
 * database" is a discussion, not an authorization, and the difference between
 * the two is a Peer Loop run against a repository. A recognizer that tried to
 * be helpful about qualifications would be a recognizer that occasionally
 * launches work the owner was still thinking about.
 *
 * WHAT THIS IS NOT: a second way to start a run. A recognized phrase is routed
 * into exactly the same `peerLoop.executeProposal` gate the Execute buttons
 * use, with exactly the same request. The objective is still the settled
 * proposal the server derives; the owner's words are never sent as one.
 *
 * @module NavigatorConfirmation
 */
import type { ThreadPurpose } from "@t3tools/contracts";

import type { ExecutableProposal, ExecuteProposalAvailability } from "./navigatorExecution";

/**
 * The exact phrases, already normalized.
 *
 * Two the owner named, and two that say the same thing with no room left for a
 * second reading. Everything about growing this list is a risk decision: each
 * new entry is a new sentence that silently starts a run, so anything that
 * could be part of a longer thought does not belong here.
 */
const CONFIRMATION_PHRASES: ReadonlySet<string> = new Set([
  // English
  "let's do it",
  // The same words without the apostrophe. Orthography, not a new meaning.
  "lets do it",
  "execute the proposal",
  // Spanish
  "hagamos eso",
  "ejecuta la propuesta",
]);

/**
 * Apostrophes a keyboard, a phone or a word processor might produce.
 *
 * A phone that turned `let's` into `let’s` has not changed what the owner said,
 * and refusing that would make the feature feel broken on the device most
 * likely to use it.
 */
const APOSTROPHES = /[‘’ʼʹ′＇`´]/gu;

/** Combining marks left behind by NFD. Removed so `ejecutá` reads as `ejecuta`. */
const COMBINING_MARKS = /\p{M}+/gu;

/**
 * Sentence-final punctuation that changes nothing about the utterance.
 *
 * `?` AND `¿` ARE ABSENT ON PURPOSE. "let's do it?" is a question about doing
 * it, not an instruction to do it, and stripping the mark would turn one into
 * the other.
 */
const TRAILING_PUNCTUATION = /[.!¡…\s]+$/u;
const LEADING_PUNCTUATION = /^[¡\s]+/u;

/**
 * The composer text, reduced to the form the phrase list is written in.
 *
 * Exported for tests: what this produces is the whole of the recognizer's
 * behaviour, and it is easier to be sure about as a string than as a boolean.
 */
export function normalizeConfirmationText(text: string): string {
  return (
    text
      // BEFORE the compatibility normalization, not after: NFKC decomposes a
      // standalone acute accent into a space and a combining mark, which would
      // turn `let´s` into `let s` and quietly stop matching.
      .replace(APOSTROPHES, "'")
      .normalize("NFKC")
      .replace(APOSTROPHES, "'")
      .normalize("NFD")
      .replace(COMBINING_MARKS, "")
      .toLowerCase()
      .replace(LEADING_PUNCTUATION, "")
      .replace(TRAILING_PUNCTUATION, "")
      .trim()
      .replace(/\s+/gu, " ")
  );
}

/**
 * Whether this composer text is a standalone confirmation and nothing else.
 *
 * Whole-utterance only. A recognized phrase inside a longer sentence, in
 * quotation marks, as a question, or negated is not a match, because the
 * normalized string it produces is not in the list.
 */
export function isNavigatorExecutionConfirmation(text: string): boolean {
  // A slash command is the composer's own syntax and is never a confirmation,
  // whatever follows the slash.
  if (text.trimStart().startsWith("/")) return false;
  return CONFIRMATION_PHRASES.has(normalizeConfirmationText(text));
}

/** The phrase list, for documentation and tests. Sorted, so it reads stably. */
export const NAVIGATOR_CONFIRMATION_PHRASES: ReadonlyArray<string> = [
  ...CONFIRMATION_PHRASES,
].toSorted();

/* ------------------------------------------------------------- routing */

/**
 * What a send should do.
 *
 * `send` is the existing path, unchanged, and is the answer to every question
 * this module is not certain about.
 */
export type NavigatorSendRoute =
  | { readonly kind: "send" }
  | { readonly kind: "execute"; readonly proposal: ExecutableProposal };

/** The existing path. Exported so a caller can return it without rebuilding it. */
export const NAVIGATOR_SEND_ROUTE: NavigatorSendRoute = { kind: "send" };

const SEND = NAVIGATOR_SEND_ROUTE;

/**
 * Whether this send is a confirmation of the current proposal.
 *
 * Every condition has to hold, and each one is a different way the same
 * sentence could mean something else:
 *
 *   - a coding thread's owner saying "let's do it" is talking to their agent;
 *   - a draft conversation has no durable thread to execute against;
 *   - with no settled actionable proposal there is nothing to confirm, and
 *     inventing an objective from the words is exactly what must never happen;
 *   - if the proposal cannot be executed — already linked, already implemented,
 *     an unknown outcome outstanding — the phrase is not an override;
 *   - anything attached to the message means the owner was composing, not
 *     confirming. An image, a terminal excerpt, a review comment or a preview
 *     annotation is content for Navigator to read.
 */
export function routeNavigatorSend(input: {
  readonly text: string;
  /** True if the composer carries anything besides the text. */
  readonly hasAttachments: boolean;
  readonly purpose: ThreadPurpose | undefined;
  readonly isDurableThread: boolean;
  /** The thread's own latest settled actionable proposal, or null. */
  readonly proposal: ExecutableProposal | null;
  readonly availability: ExecuteProposalAvailability;
}): NavigatorSendRoute {
  if (input.purpose !== "navigator") return SEND;
  if (!input.isDurableThread) return SEND;
  if (input.proposal === null) return SEND;
  if (!input.availability.canExecute) return SEND;
  if (input.hasAttachments) return SEND;
  if (!isNavigatorExecutionConfirmation(input.text)) return SEND;
  return { kind: "execute", proposal: input.proposal };
}

/**
 * Consume a routed send, if it was a confirmation.
 *
 * Returns true when the send has been handled as an action and the caller must
 * stop — no provider turn, no optimistic owner message, no mode change, no
 * navigation. Returns false for every other route, and touches nothing, so the
 * existing send path continues exactly as it did.
 *
 * The composer is cleared BEFORE the request, so the phrase is consumed as an
 * action rather than left sitting in the box where a second Enter would look
 * like a second confirmation. There is no fabricated provider message standing
 * in for it: the durable record of this action is the immutable proposal/run
 * link the server writes, and the child card that renders it.
 */
export async function consumeNavigatorConfirmation(input: {
  readonly route: NavigatorSendRoute;
  readonly clearComposer: () => void;
  readonly execute: (proposal: ExecutableProposal) => Promise<unknown>;
}): Promise<boolean> {
  if (input.route.kind !== "execute") return false;
  input.clearComposer();
  await input.execute(input.route.proposal);
  return true;
}

/* -------------------------------------------------- composer submission */

/**
 * Whether a missing provider is blocking this composer right now.
 *
 * ONE ANSWER, USED EVERYWHERE. The bug this replaces was a composer whose
 * submit callback allowed an eligible confirmation through while every visible
 * control still read `noProviderAvailable` directly — so the button that would
 * have worked was drawn disabled. A single derived value, consulted by the
 * callback and by each layout's disabled calculation, is what keeps those from
 * disagreeing again.
 *
 * Narrow on purpose: `allowsSubmitWithoutProvider` is true only for an exact,
 * eligible Navigator execution confirmation, which calls Peer Loop's own
 * operation and never needs this conversation's provider.
 */
export function providerBlocksComposerSubmit(input: {
  readonly noProviderAvailable: boolean;
  readonly allowsSubmitWithoutProvider: boolean;
}): boolean {
  return input.noProviderAvailable && !input.allowsSubmitWithoutProvider;
}

/**
 * Whether the composer must refuse this submission outright.
 *
 * `isSendDisabled` still wins: that is the composer's own reason — messages
 * loading, an image still compressing — and it is not about the provider, so a
 * confirmation does not get to skip it.
 */
export function composerSubmitBlocked(input: {
  readonly providerBlocksSubmit: boolean;
  readonly isSendDisabled: boolean;
}): boolean {
  return input.isSendDisabled || input.providerBlocksSubmit;
}
