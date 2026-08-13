/**
 * Naming the exact owner decision a surface was looking at.
 *
 * A Peer Loop run that stops for its owner does not label the question it is
 * asking. It stops again later, with a different question, and nothing in the
 * run state distinguishes the two but the iteration they belong to and the
 * words themselves. So an owner who is answering "which database?" and an owner
 * who has been shown "wait for the replica?" while their client caught up are
 * indistinguishable to any surface that only knows "this run wants an answer" —
 * and answering the wrong question is a Builder acting on an instruction nobody
 * gave.
 *
 * This turns the decision a client is showing into a short opaque value the
 * server can recompute from Peer Loop's own fresh state. Equal fingerprints
 * mean the two sides are looking at the same question; different ones mean the
 * client's view is stale and its answer must not be sent.
 *
 * WHAT IT IS NOT: a way to move the question around. The fingerprint carries no
 * recoverable text, and nothing in the system accepts it in place of the
 * decision — the option an owner picks is always resolved from the state the
 * server just read, never from what a client sends.
 *
 * NOTHING IS ADDED TO PEER LOOP. There is no id to ask for and none is
 * invented: this is derived entirely from the fields Peer Loop already writes.
 * A real run bears out that those fields separate consecutive decisions — run
 * `20260812T062443Z-4eb56b42` asked at iteration 2 and again at iteration 3,
 * with a different question, a different reason and different options each
 * time.
 *
 * @module PeerLoopDecisionFingerprint
 */
import { sha256 } from "@noble/hashes/sha2";

/** Exactly what identifies one owner decision. Nothing mutable, nothing else. */
export interface PeerLoopOwnerDecisionIdentity {
  readonly ownerQuestion: string;
  readonly whyOwnerIsRequired: string;
  /** In Peer Loop's own order, which is the order the owner is shown. */
  readonly options: ReadonlyArray<string>;
  /** The Reviewer turn the decision belongs to. Peer Loop's own counter. */
  readonly iteration: number;
}

/**
 * How much of the digest travels. Short enough to log, long enough that two
 * decisions colliding is not a thing that happens.
 */
export const PEER_LOOP_DECISION_FINGERPRINT_CHARS = 32;

/** The shape a fingerprint always has, for a contract to check cheaply. */
export const PEER_LOOP_DECISION_FINGERPRINT_PATTERN = /^[0-9a-f]{32}$/u;

const encoder = new TextEncoder();

/**
 * Length-prefixed, not delimiter-joined.
 *
 * A separator can appear inside a question, a reason or an option — Peer Loop's
 * own text is prose written by a model, and prose contains everything. Joining
 * with any character at all means two different decisions can produce one
 * encoding, and a collision here is an owner's answer applied to a question
 * they never saw. Every field is preceded by its length in bytes, so the
 * decoding is unambiguous no matter what the text contains.
 *
 * The option COUNT is prefixed too, so a decision with options ["a", "b"] and
 * one with the single option "a…b" cannot line up whatever the separator.
 */
function canonicalBytes(identity: PeerLoopOwnerDecisionIdentity): Uint8Array {
  const parts: Array<Uint8Array> = [];
  let length = 0;
  const push = (bytes: Uint8Array): void => {
    parts.push(bytes);
    length += bytes.length;
  };

  // A field is `<byte length>:<bytes>`; a number is its decimal form, prefixed
  // the same way, so it cannot be confused with text that looks like a number.
  const field = (value: string): void => {
    const bytes = encoder.encode(value);
    push(encoder.encode(`${bytes.length}:`));
    push(bytes);
  };

  field("t3code/peer-loop/owner-decision/1");
  field(String(identity.iteration));
  field(identity.ownerQuestion);
  field(identity.whyOwnerIsRequired);
  field(String(identity.options.length));
  for (const option of identity.options) field(option);

  const canonical = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    canonical.set(part, offset);
    offset += part.length;
  }
  return canonical;
}

/**
 * The fingerprint of one owner decision.
 *
 * Deterministic, and the same on both sides: the browser computes it from what
 * it rendered and the server recomputes it from what Peer Loop just told it.
 * Any difference in the question, the reason, an option, the ORDER of the
 * options, or the iteration produces a different value.
 */
export function peerLoopDecisionFingerprint(identity: PeerLoopOwnerDecisionIdentity): string {
  const digest = sha256(canonicalBytes(identity));
  let hex = "";
  for (let index = 0; index < digest.length; index += 1) {
    hex += (digest[index] ?? 0).toString(16).padStart(2, "0");
  }
  return hex.slice(0, PEER_LOOP_DECISION_FINGERPRINT_CHARS);
}

/**
 * A reviewer decision as either side already holds it.
 *
 * Deliberately structural rather than imported: this package does not depend on
 * the Peer Loop contract, and Peer Loop writes more fields than a fingerprint
 * reads. The extras are carried in the index signature and ignored.
 */
export interface PeerLoopReviewerDecisionRecord {
  readonly decision?: string | undefined;
  readonly ownerQuestion?: string | null | undefined;
  readonly whyOwnerIsRequired?: string | null | undefined;
  readonly options?: ReadonlyArray<string> | null | undefined;
  readonly [extra: string]: unknown;
}

/**
 * The fingerprint of a decision record, when that record is an owner question.
 *
 * Null for anything else — a CONTINUE or a DONE is not a decision an owner can
 * answer, and giving it a fingerprint would let one be answered as though it
 * were.
 */
export function peerLoopOwnerDecisionFingerprint(input: {
  readonly decision: PeerLoopReviewerDecisionRecord | null;
  readonly iteration: number;
}): string | null {
  const decision = input.decision;
  if (decision === null || decision === undefined) return null;
  if (decision.decision !== "OWNER_REQUIRED") return null;
  const ownerQuestion = decision.ownerQuestion;
  if (typeof ownerQuestion !== "string" || ownerQuestion.length === 0) return null;
  return peerLoopDecisionFingerprint({
    ownerQuestion,
    whyOwnerIsRequired: decision.whyOwnerIsRequired ?? "",
    options: decision.options ?? [],
    iteration: input.iteration,
  });
}
