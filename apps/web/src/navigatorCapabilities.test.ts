/**
 * The capability list, enumerated.
 *
 * Written against the record rather than against components on purpose: the
 * failure this guards is someone adding a coding-only capability and forgetting
 * that Navigator exists. Asserting the whole Navigator record — every key, by
 * name — means a new field cannot be added without a test author deciding what
 * it means here.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  CODING_PROPOSAL_WORDING,
  NAVIGATOR_PROPOSAL_WORDING,
  proposalWording,
  rightPanelVisible,
  terminalDrawerVisible,
  threadCapabilities,
  visibleRightPanelSurfaces,
} from "./navigatorCapabilities";

describe("navigator capabilities", () => {
  it("switches off every coding-only entry point and nothing else", () => {
    expect(threadCapabilities("navigator")).toEqual({
      canChangeRuntimeMode: false,
      canChangeInteractionMode: false,
      canChooseCheckout: false,
      canImplementPlan: false,
      canUseTerminals: false,
      canRunProjectScripts: false,
      canRevertCheckpoint: false,
      canStartRepositoryMutation: false,
      // Clearing a pending request is explicitly allowed by the server, and
      // blocking it would strand a conversation with an unanswerable question.
      canAcceptApprovals: false,
      canDeclineApprovals: true,
      canConverse: true,
    });
  });

  it("leaves coding threads with everything they have today", () => {
    const coding = threadCapabilities("coding");
    for (const [name, allowed] of Object.entries(coding)) {
      expect(allowed, `coding threads must retain ${name}`).toBe(true);
    }
  });

  it("treats a thread with no purpose as coding", () => {
    // An older shell carries no purpose. Stripping its controls would be a
    // regression dressed up as caution.
    expect(threadCapabilities(undefined)).toEqual(threadCapabilities("coding"));
  });
});

describe("proposal wording", () => {
  it("calls a Navigator plan an Execution Proposal", () => {
    expect(proposalWording("navigator")).toEqual(NAVIGATOR_PROPOSAL_WORDING);
    expect(proposalWording("navigator").badge).toBe("Execution Proposal");
  });

  it("leaves coding plans worded exactly as they are today", () => {
    expect(proposalWording("coding")).toEqual(CODING_PROPOSAL_WORDING);
    expect(proposalWording("coding").badge).toBe("Plan");
    expect(proposalWording("coding").untitled).toBe("Proposed plan");
    expect(proposalWording(undefined)).toEqual(CODING_PROPOSAL_WORDING);
  });
});

describe("retained terminal and panel state", () => {
  const navigator = threadCapabilities("navigator");
  const coding = threadCapabilities("coding");

  it("keeps a drawer left open by earlier state closed", () => {
    // The realistic failure: a thread whose terminal UI state was written
    // before this rule existed, or by a build without it. Reading the stored
    // value straight through would reopen the drawer on the next visit.
    expect(terminalDrawerVisible(navigator, true)).toBe(false);
    expect(terminalDrawerVisible(navigator, false)).toBe(false);
    expect(terminalDrawerVisible(coding, true)).toBe(true);
    expect(terminalDrawerVisible(coding, false)).toBe(false);
  });

  it("drops a retained terminal surface and keeps the read-only ones", () => {
    const surfaces = [
      { id: "diff", kind: "diff" },
      { id: "terminal:1", kind: "terminal" },
      { id: "plan", kind: "plan" },
      { id: "files", kind: "files" },
    ] as const;
    expect(visibleRightPanelSurfaces(navigator, surfaces).map((surface) => surface.id)).toEqual([
      "diff",
      "plan",
      "files",
    ]);
    // Reading, diffing and inspecting are the point of a planning
    // conversation; only the shell goes.
    expect(visibleRightPanelSurfaces(coding, surfaces)).toEqual(surfaces);
  });

  it("does not open a panel whose only surface was the hidden terminal", () => {
    expect(rightPanelVisible(navigator, true, 0)).toBe(false);
    expect(rightPanelVisible(navigator, true, 1)).toBe(true);
    expect(rightPanelVisible(navigator, false, 3)).toBe(false);
    // A coding thread's panel is unchanged, including the transient moment
    // where it is open with nothing in it yet.
    expect(rightPanelVisible(coding, true, 0)).toBe(true);
    expect(rightPanelVisible(coding, false, 2)).toBe(false);
  });
});
