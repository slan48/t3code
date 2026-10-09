import { describe, expect, it } from "vite-plus/test";

import {
  PEER_LOOP_PROPOSAL_FINGERPRINT_CHARS,
  PEER_LOOP_PROPOSAL_FINGERPRINT_PATTERN,
  peerLoopProposalFingerprint,
} from "./peerLoopProposalFingerprint.ts";

describe("peerLoopProposalFingerprint", () => {
  it("is deterministic for the same exact markdown", () => {
    const markdown = "# Ship it\n\n- Keep the newline.";
    const fingerprint = peerLoopProposalFingerprint(markdown);

    expect(peerLoopProposalFingerprint(markdown)).toBe(fingerprint);
    expect(fingerprint).toHaveLength(PEER_LOOP_PROPOSAL_FINGERPRINT_CHARS);
    expect(fingerprint).toMatch(PEER_LOOP_PROPOSAL_FINGERPRINT_PATTERN);
  });

  it("changes when any markdown content changes, including whitespace", () => {
    const markdown = "# Ship it\n\n- Keep the newline.";

    expect(peerLoopProposalFingerprint(`${markdown} `)).not.toBe(
      peerLoopProposalFingerprint(markdown),
    );
    expect(peerLoopProposalFingerprint(markdown.replace("newline", "line break"))).not.toBe(
      peerLoopProposalFingerprint(markdown),
    );
  });
});
