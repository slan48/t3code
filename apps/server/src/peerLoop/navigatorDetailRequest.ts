/**
 * Did the Owner just ask to see what actually happened, step by step?
 *
 * Reading a run's activity is the one Navigator read that is expensive: it
 * opens a replay subscription against the bridge and puts somebody else's
 * prose — Builder reports, Reviewer summaries, notices — in front of a model.
 * Doing it on every turn would be wasteful and, worse, would make an ordinary
 * "how is it going?" carry text nobody asked to be interpreted.
 *
 * So it is gated on the Owner asking, and the gate is deliberately narrow:
 * normalization plus an explicit pattern list. No model, no fuzzy similarity,
 * no sentiment, and no bare `why` — "why did it fail?" is an ordinary question
 * that the structured halt reason already answers.
 *
 * At most one run is read per turn. If the message names a linked run, that is
 * the one; otherwise the newest link. A run id the Owner names that this
 * conversation did not launch is never read at all.
 *
 * @module NavigatorDetailRequest
 */
import type { OrchestrationPeerLoopExecution } from "@t3tools/contracts";

import { selectRecentExecutionLinks } from "./navigatorExecutionContextFormat.ts";

/* -------------------------------------------------------- normalization */

/** Apostrophes a keyboard, a phone or a word processor might produce. */
const APOSTROPHES = /[‘’ʼʹ′＇`´]/gu;
/** Combining marks left by NFD, so `ejecución` reads as `ejecucion`. */
const COMBINING_MARKS = /\p{M}+/gu;
/** Hyphens, so `step-by-step` and `step by step` are the same request. */
const SEPARATORS = /[-–—_/]+/gu;

/**
 * The message, reduced to the form the patterns are written against.
 *
 * Exported because what this produces is most of the recognizer's behaviour,
 * and a string is easier to be sure about than a boolean.
 */
export function normalizeDetailRequestText(text: string): string {
  return text
    .replace(APOSTROPHES, "'")
    .normalize("NFKC")
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(SEPARATORS, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/* ------------------------------------------------------------ patterns */

/**
 * Phrases that are a request for detail on their own.
 *
 * Each one names activity, a transcript, a log, or an explicit walk through
 * what happened. None of them appears in "how is it going?", "what changed?",
 * "is it done?" or ordinary project discussion — that is the property that
 * makes the gate worth having.
 */
const STANDALONE_DETAIL = [
  // English
  /\bstep by step\b/u,
  /\bblow by blow\b/u,
  /\bin detail\b/u,
  /\bdetailed (activity|history|log|logs|transcript|explanation|breakdown|account)\b/u,
  /\b(full|complete|entire|whole) (activity|history|log|logs|transcript|timeline)\b/u,
  /\b(execution|run|event|activity) (activity|log|logs|transcript|timeline|history)\b/u,
  /\bactivity (feed|log|logs|history|timeline)\b/u,
  /\bwalk me through\b/u,
  /\btake me through\b/u,
  // Spanish
  /\bpaso a paso\b/u,
  /\ben detalle\b/u,
  /\b(actividad|historial|transcripcion|registro|bitacora) (de|del) (la )?(ejecucion|run|corrida)\b/u,
  /\b(actividad|historial|transcripcion|registro|bitacora) (completa|completo|detallada|detallado)\b/u,
  /\b(muestrame|muestra|ensename|enseñame|dame|listame|explicame) (la|el|los|las)? ?(actividad|transcripcion|historial|registro|bitacora|eventos)\b/u,
] as const;

/** Verbs that turn a detail noun into a request rather than a mention. */
const ASK_VERB =
  /\b(show|give|list|display|print|dump|share|explain|describe|muestrame|muestra|ensename|dame|lista|listame|explicame|explica|describeme|describe)\b/u;

/** Nouns that name the thing being asked for. */
const DETAIL_NOUN =
  /\b(activity|transcript|timeline|event log|events|history|log|logs|actividad|transcripcion|historial|registro|bitacora|eventos)\b/u;

/**
 * An explicit demand for the *exact* cause of a failure or stop.
 *
 * `exactly` (or `exactamente`) is doing the work. Without it this is "why did
 * it fail?", which the structured halt reason already answers and which must
 * not open a replay.
 */
const EXACT_FAILURE = [
  /\bexactly\b[^.?!]*\b(fail|failed|fails|stop|stopped|break|broke|crash|crashed|wrong|error|errored)\b/u,
  /\b(fail|failed|fails|stopped|broke|crashed|went wrong|error|errored)\b[^.?!]*\bexactly\b/u,
  /\bexactamente\b[^.?!]*\b(fallo|fallar|fallado|fracaso|detuvo|paro|parado|mal|error)\b/u,
  /\b(fallo|fallar|fallado|detuvo|paro|mal|error)\b[^.?!]*\bexactamente\b/u,
] as const;

/**
 * Whether this message explicitly asks for detailed execution history.
 *
 * Whole-message inspection, but not whole-message equality: unlike the
 * confirmation grammar, which authorizes work and therefore has to be exact,
 * this only decides whether to *read* — so it recognizes a request embedded in
 * a longer sentence. The cost of a false positive here is one bounded read.
 */
export function requestsDetailedActivity(text: string): boolean {
  const normalized = normalizeDetailRequestText(text);
  if (normalized.length === 0) return false;
  if (STANDALONE_DETAIL.some((pattern) => pattern.test(normalized))) return true;
  if (EXACT_FAILURE.some((pattern) => pattern.test(normalized))) return true;
  return ASK_VERB.test(normalized) && DETAIL_NOUN.test(normalized);
}

/* -------------------------------------------------------------- target */

export type NavigatorDetailTarget =
  | { readonly kind: "none" }
  | { readonly kind: "run"; readonly runId: string };

const NO_TARGET: NavigatorDetailTarget = { kind: "none" };

/**
 * Which linked run, if any, this turn may read in detail.
 *
 * ONLY EVER A LINKED RUN, AND ONLY EVER ONE. A run id the Owner names that this
 * conversation did not launch is not in `links`, so it is not findable here and
 * cannot be read; the request falls back to this conversation's newest link,
 * which is the run they are almost certainly asking about.
 *
 * The named-id search runs against the raw text, because a run id is an opaque
 * identifier and normalization would fold case out of it.
 */
export function selectDetailTarget(input: {
  readonly text: string;
  readonly links: ReadonlyArray<OrchestrationPeerLoopExecution>;
}): NavigatorDetailTarget {
  if (!requestsDetailedActivity(input.text)) return NO_TARGET;
  // Newest first, so "the newest link" is the head and a named match among
  // several resolves to the newest of them.
  const ordered = selectRecentExecutionLinks(input.links);
  const head = ordered[0];
  if (head === undefined) return NO_TARGET;

  const named = ordered.find((link) => mentionsRunId(input.text, link.runId));
  return { kind: "run", runId: named?.runId ?? head.runId };
}

/**
 * Whether the message names this run id as a token rather than by accident.
 *
 * Bounded on both sides so `run-1` does not match inside `run-12`: an id that
 * is a prefix of another linked id would otherwise pick the wrong run.
 */
function mentionsRunId(text: string, runId: string): boolean {
  const index = text.indexOf(runId);
  if (index < 0) return false;
  const before = text[index - 1];
  const after = text[index + runId.length];
  const isBoundary = (character: string | undefined): boolean =>
    character === undefined || !/[\p{L}\p{N}_-]/u.test(character);
  return isBoundary(before) && isBoundary(after);
}
