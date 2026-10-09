/**
 * Naming the exact markdown an owner approved for a Navigator Execution
 * Proposal.
 *
 * The browser computes this from the proposal it displays and the server
 * recomputes it from the fresh T3 projection it reads before starting Peer
 * Loop. The input is hashed as-is: no trimming, parsing or normalization is
 * allowed to make two different proposals look alike.
 *
 * @module PeerLoopProposalFingerprint
 */
import { sha256 } from "@noble/hashes/sha2";

/** The bounded number of lowercase hexadecimal characters sent over the wire. */
export const PEER_LOOP_PROPOSAL_FINGERPRINT_CHARS = 32;

/** The exact opaque shape accepted by the Peer Loop execution contract. */
export const PEER_LOOP_PROPOSAL_FINGERPRINT_PATTERN = /^[0-9a-f]{32}$/u;

const encoder = new TextEncoder();

/**
 * Fingerprint one proposal's exact markdown bytes.
 *
 * `TextEncoder` is the shared UTF-8 encoding in browsers and servers, and
 * `@noble/hashes` keeps the operation independent of Node's crypto APIs.
 */
export function peerLoopProposalFingerprint(planMarkdown: string): string {
  const digest = sha256(encoder.encode(planMarkdown));
  let hex = "";
  for (let index = 0; index < digest.length; index += 1) {
    hex += (digest[index] ?? 0).toString(16).padStart(2, "0");
  }
  return hex.slice(0, PEER_LOOP_PROPOSAL_FINGERPRINT_CHARS);
}
