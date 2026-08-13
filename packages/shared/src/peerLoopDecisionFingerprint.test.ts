/**
 * Whether two surfaces are looking at the same owner decision.
 *
 * The failure this guards against is an owner's answer being applied to a
 * question they never saw, so the interesting cases are the ones where two
 * different decisions could be made to produce one value: text that contains
 * the separators an encoder might use, options that regroup, and a question
 * asked twice in the same run.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  PEER_LOOP_DECISION_FINGERPRINT_CHARS,
  PEER_LOOP_DECISION_FINGERPRINT_PATTERN,
  peerLoopDecisionFingerprint,
  peerLoopOwnerDecisionFingerprint,
  type PeerLoopOwnerDecisionIdentity,
} from "./peerLoopDecisionFingerprint.ts";

/**
 * The real decision this feature exists for.
 *
 * Run `20260812T062443Z-4eb56b42`, iteration 2, event sequence 85 — copied from
 * the durable event log rather than invented, because the fields it separates
 * have to be the fields Peer Loop actually writes.
 */
const ITERATION_2: PeerLoopOwnerDecisionIdentity = {
  ownerQuestion: "What should happen next with the verified local commit?",
  whyOwnerIsRequired:
    "Publishing would require adding or using a remote and pushing, while the owner policy reserves that for the owner.",
  options: [
    "Option A — Publish/push it yourself (recommended default).",
    "Option B — In a future instruction, explicitly authorize the assistant to publish and specify the remote/repository details and visibility.",
    "Option C — Do not publish; keep the commit local only.",
  ],
  iteration: 2,
};

/** The same run, iteration 3, event sequence 112. A different question. */
const ITERATION_3: PeerLoopOwnerDecisionIdentity = {
  ownerQuestion: "What should happen next with the verified local marker commit?",
  whyOwnerIsRequired:
    "Any assistant publishing action would require configuring or using a remote, which the owner policy reserves.",
  options: [
    "Keep the commit local only and do not publish.",
    "Publish/push it yourself.",
    "Explicitly authorize assistant publishing in a future instruction, including the remote/repository and visibility details.",
  ],
  iteration: 3,
};

describe("one decision, one fingerprint", () => {
  it("is stable, bounded and opaque", () => {
    const fingerprint = peerLoopDecisionFingerprint(ITERATION_2);
    expect(fingerprint).toBe(peerLoopDecisionFingerprint({ ...ITERATION_2 }));
    expect(fingerprint).toHaveLength(PEER_LOOP_DECISION_FINGERPRINT_CHARS);
    expect(fingerprint).toMatch(PEER_LOOP_DECISION_FINGERPRINT_PATTERN);
    // Nothing of the question travels in it. It names a decision; it does not
    // carry one.
    for (const word of ["commit", "publish", "Option", "owner"]) {
      expect(fingerprint).not.toContain(word);
    }
  });

  it("separates the two decisions one real run actually produced", () => {
    // Iteration 2 and iteration 3 of `20260812T062443Z-4eb56b42`. If these
    // collided, an owner answering the second would be answering the first.
    expect(peerLoopDecisionFingerprint(ITERATION_2)).not.toBe(
      peerLoopDecisionFingerprint(ITERATION_3),
    );
  });

  it("changes when any single field changes", () => {
    const base = peerLoopDecisionFingerprint(ITERATION_2);
    const variants: ReadonlyArray<readonly [string, PeerLoopOwnerDecisionIdentity]> = [
      ["question", { ...ITERATION_2, ownerQuestion: `${ITERATION_2.ownerQuestion} ` }],
      ["why", { ...ITERATION_2, whyOwnerIsRequired: "Something else entirely." }],
      [
        "an option",
        {
          ...ITERATION_2,
          options: [
            ITERATION_2.options[0] ?? "",
            "Option B — a different option.",
            ITERATION_2.options[2] ?? "",
          ],
        },
      ],
      ["a dropped option", { ...ITERATION_2, options: ITERATION_2.options.slice(0, 2) }],
      ["an added option", { ...ITERATION_2, options: [...ITERATION_2.options, "Option D"] }],
      ["iteration", { ...ITERATION_2, iteration: 3 }],
    ];
    for (const [label, variant] of variants) {
      expect(peerLoopDecisionFingerprint(variant), label).not.toBe(base);
    }
  });

  it("changes when the options are reordered", () => {
    // The owner answers by index. Two decisions with the same options in a
    // different order are different decisions, and treating them as one would
    // send the wrong option's text.
    const reversed = { ...ITERATION_2, options: [...ITERATION_2.options].toReversed() };
    expect(peerLoopDecisionFingerprint(reversed)).not.toBe(
      peerLoopDecisionFingerprint(ITERATION_2),
    );
  });

  it("treats the same iteration number as itself, not as its text", () => {
    expect(peerLoopDecisionFingerprint({ ...ITERATION_2, iteration: 0 })).not.toBe(
      peerLoopDecisionFingerprint({ ...ITERATION_2, iteration: 10 }),
    );
  });
});

describe("content that could forge a collision", () => {
  const base = {
    ownerQuestion: "q",
    whyOwnerIsRequired: "w",
    options: ["a", "b"],
    iteration: 1,
  } as const;

  it("cannot be regrouped across the field boundary", () => {
    // Every separator a naive encoder might pick, placed exactly where it
    // would have to land to move text from one field into the next.
    for (const separator of ["\u0000", "\n", "|", ":", "\u001f", " ", "§"]) {
      const shifted = peerLoopDecisionFingerprint({
        ...base,
        ownerQuestion: `q${separator}w`,
        whyOwnerIsRequired: "",
      });
      expect(shifted, separator).not.toBe(peerLoopDecisionFingerprint(base));
    }
  });

  it("cannot regroup one option into two, or two into one", () => {
    for (const separator of ["\u0000", "\n", "|", ":", "\u001f"]) {
      expect(
        peerLoopDecisionFingerprint({ ...base, options: [`a${separator}b`] }),
        separator,
      ).not.toBe(peerLoopDecisionFingerprint(base));
    }
    // An empty option is a real option, and dropping it is a different decision.
    expect(peerLoopDecisionFingerprint({ ...base, options: ["a", "b", ""] })).not.toBe(
      peerLoopDecisionFingerprint(base),
    );
    expect(peerLoopDecisionFingerprint({ ...base, options: [] })).not.toBe(
      peerLoopDecisionFingerprint({ ...base, options: [""] }),
    );
  });

  it("counts bytes rather than code units, so the prefix cannot be gamed", () => {
    // Astral characters are two UTF-16 code units and four UTF-8 bytes. A
    // length prefix measured in the wrong unit is a length prefix that lies.
    const emoji = peerLoopDecisionFingerprint({ ...base, ownerQuestion: "🙂" });
    const twoChars = peerLoopDecisionFingerprint({ ...base, ownerQuestion: "ab" });
    expect(emoji).not.toBe(twoChars);
    expect(emoji).toMatch(PEER_LOOP_DECISION_FINGERPRINT_PATTERN);
  });

  it("does not fold visually equivalent but distinct text together", () => {
    // Composed U+00E9 against decomposed e + U+0301. They render identically
    // and are different strings, so they are different decisions — Peer Loop's
    // text is passed through, not normalized, and neither side may fold it.
    expect(peerLoopDecisionFingerprint({ ...base, ownerQuestion: "é" })).not.toBe(
      peerLoopDecisionFingerprint({ ...base, ownerQuestion: "é" }),
    );
  });
});

describe("fingerprinting a decision record", () => {
  const record = {
    decision: "OWNER_REQUIRED",
    summary: "Blocked on a choice.",
    ownerQuestion: ITERATION_2.ownerQuestion,
    whyOwnerIsRequired: ITERATION_2.whyOwnerIsRequired,
    options: ITERATION_2.options,
  };

  it("matches the identity the two sides each build", () => {
    expect(peerLoopOwnerDecisionFingerprint({ decision: record, iteration: 2 })).toBe(
      peerLoopDecisionFingerprint(ITERATION_2),
    );
  });

  it("refuses to name anything that is not an owner question", () => {
    // A CONTINUE or a DONE is not answerable, and giving it a fingerprint is
    // how one would get answered as though it were.
    expect(peerLoopOwnerDecisionFingerprint({ decision: null, iteration: 2 })).toBeNull();
    expect(
      peerLoopOwnerDecisionFingerprint({
        decision: { decision: "CONTINUE", summary: "s" },
        iteration: 2,
      }),
    ).toBeNull();
    expect(
      peerLoopOwnerDecisionFingerprint({
        decision: { decision: "DONE", summary: "s" },
        iteration: 2,
      }),
    ).toBeNull();
    // OWNER_REQUIRED with no question recorded is not a question either.
    expect(
      peerLoopOwnerDecisionFingerprint({
        decision: { decision: "OWNER_REQUIRED", ownerQuestion: "" },
        iteration: 2,
      }),
    ).toBeNull();
  });

  it("fills the fields Peer Loop left out rather than failing", () => {
    // A question with no recorded reason and no options is still a question.
    const sparse = peerLoopOwnerDecisionFingerprint({
      decision: { decision: "OWNER_REQUIRED", ownerQuestion: "Which database?" },
      iteration: 4,
    });
    expect(sparse).toBe(
      peerLoopDecisionFingerprint({
        ownerQuestion: "Which database?",
        whyOwnerIsRequired: "",
        options: [],
        iteration: 4,
      }),
    );
  });
});
