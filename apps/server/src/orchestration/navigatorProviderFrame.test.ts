/**
 * The Navigator role frame, and the line between what is stored and what is sent.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  NAVIGATOR_PROVIDER_FRAME,
  providerMessageTextForThread,
} from "./navigatorProviderFrame.ts";

const OWNER_TEXT = "Can we split the migration into two passes?";

describe("coding turns", () => {
  it("send the owner's text byte for byte", () => {
    // Not "equivalent", not "trimmed" — identical. An ordinary turn must reach
    // the adapter exactly as it always has.
    expect(providerMessageTextForThread("coding", OWNER_TEXT)).toBe(OWNER_TEXT);
    expect(providerMessageTextForThread(undefined, OWNER_TEXT)).toBe(OWNER_TEXT);
    // Including the awkward ones.
    for (const text of ["", "   ", "line\n\nline", NAVIGATOR_PROVIDER_FRAME]) {
      expect(providerMessageTextForThread("coding", text)).toBe(text);
    }
  });
});

describe("navigator turns", () => {
  const framed = providerMessageTextForThread("navigator", OWNER_TEXT);

  it("carry the role frame and then the owner's text, unaltered", () => {
    expect(framed.startsWith(NAVIGATOR_PROVIDER_FRAME)).toBe(true);
    expect(framed.endsWith(OWNER_TEXT)).toBe(true);
    // The owner's words are present exactly once and exactly as typed.
    expect(framed.split(OWNER_TEXT)).toHaveLength(2);
  });

  it("say what Navigator is and what it does not do", () => {
    expect(framed).toContain("You are Navigator");
    expect(framed).toContain("Execution Proposal");
    expect(framed).toContain("clarifying questions");
    expect(framed).toContain("do not implement");
    expect(framed).toContain("do not claim that any work has been executed");
    expect(framed).toContain("not the Reviewer");
    // The sentence that matters most: conversation is not consent.
    expect(framed).toContain("is not authorization to execute");
  });

  it("is bounded and constant", () => {
    // Same frame every turn, regardless of anything outside this module.
    expect(providerMessageTextForThread("navigator", "a")).toContain(NAVIGATOR_PROVIDER_FRAME);
    expect(providerMessageTextForThread("navigator", "b")).toContain(NAVIGATOR_PROVIDER_FRAME);
    expect(NAVIGATOR_PROVIDER_FRAME.length).toBeLessThan(1_200);
  });

  it("carries no run state, transcript, path or secret", () => {
    // A frame that varied with external state would be a channel for that
    // state into every provider request. This one has nothing to vary with.
    for (const forbidden of ["runId", "run-", "peer-loop", "/Users/", "workspaceRoot", "token"]) {
      expect(NAVIGATOR_PROVIDER_FRAME.includes(forbidden)).toBe(false);
    }
  });
});

describe("navigator turns with execution context", () => {
  const CONTEXT = "Linked Peer Loop executions (structured, read-only context)\n\n1. run run-77";
  const framed = providerMessageTextForThread("navigator", OWNER_TEXT, CONTEXT);

  it("puts the role frame first, the context next, and the owner's text last", () => {
    expect(framed.startsWith(NAVIGATOR_PROVIDER_FRAME)).toBe(true);
    expect(framed.endsWith(OWNER_TEXT)).toBe(true);
    expect(framed.indexOf(CONTEXT)).toBeGreaterThan(NAVIGATOR_PROVIDER_FRAME.length - 1);
    expect(framed.indexOf(CONTEXT)).toBeLessThan(framed.indexOf(OWNER_TEXT));
    // Each part appears exactly once. A context inserted twice would read to a
    // model as two different observations of the same run.
    expect(framed.split(CONTEXT)).toHaveLength(2);
    expect(framed.split(OWNER_TEXT)).toHaveLength(2);
  });

  it("is byte for byte the old framing when there is no context", () => {
    // THE COMPATIBILITY BOUNDARY. A conversation that has launched nothing must
    // not gain an empty section it would have to interpret.
    const bare = providerMessageTextForThread("navigator", OWNER_TEXT);
    expect(providerMessageTextForThread("navigator", OWNER_TEXT, null)).toBe(bare);
    expect(providerMessageTextForThread("navigator", OWNER_TEXT, undefined)).toBe(bare);
    expect(providerMessageTextForThread("navigator", OWNER_TEXT, "")).toBe(bare);
  });

  it("still sends a coding turn's text byte for byte, context or not", () => {
    expect(providerMessageTextForThread("coding", OWNER_TEXT, CONTEXT)).toBe(OWNER_TEXT);
    expect(providerMessageTextForThread(undefined, OWNER_TEXT, CONTEXT)).toBe(OWNER_TEXT);
  });
});
