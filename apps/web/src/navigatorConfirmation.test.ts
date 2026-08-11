/**
 * What counts as an owner confirming, and — much more importantly — what does not.
 *
 * The false positive here is a Peer Loop run against a repository the owner was
 * still thinking about, so the rejections are the substance of this file. Every
 * "no" below is a sentence somebody will plausibly type into a Navigator
 * conversation while discussing whether to execute.
 */
import type { OrchestrationProposedPlanId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  composerSubmitBlocked,
  consumeNavigatorConfirmation,
  providerBlocksComposerSubmit,
  isNavigatorExecutionConfirmation,
  NAVIGATOR_CONFIRMATION_PHRASES,
  normalizeConfirmationText,
  routeNavigatorSend,
} from "./navigatorConfirmation";
import { executeProposalAvailability } from "./navigatorExecution";

const PLAN_ID = "plan-1" as OrchestrationProposedPlanId;
const proposal = {
  id: PLAN_ID,
  implementedAt: null,
  implementationThreadId: null,
} as const;

const eligibleAvailability = executeProposalAvailability({
  purpose: "navigator",
  isDurableThread: true,
  latestTurnSettled: true,
  proposal,
  executionCount: 0,
  executing: false,
  lastAttemptDisposition: null,
});

const route = (
  overrides: Partial<Parameters<typeof routeNavigatorSend>[0]> = {},
): ReturnType<typeof routeNavigatorSend> =>
  routeNavigatorSend({
    text: "let's do it",
    hasAttachments: false,
    purpose: "navigator",
    isDurableThread: true,
    proposal,
    availability: eligibleAvailability,
    ...overrides,
  });

/* ---------------------------------------------------------- recognition */

describe("the phrases an owner can confirm with", () => {
  it("is a short, closed, enumerable list", () => {
    // Written out here so growing it is a decision somebody makes on purpose:
    // each entry is a sentence that silently starts a Peer Loop run.
    expect(NAVIGATOR_CONFIRMATION_PHRASES).toEqual([
      "ejecuta la propuesta",
      "execute the proposal",
      "hagamos eso",
      "let's do it",
      "lets do it",
    ]);
  });

  it("recognizes the owner's own English and Spanish examples", () => {
    expect(isNavigatorExecutionConfirmation("let's do it")).toBe(true);
    expect(isNavigatorExecutionConfirmation("hagamos eso")).toBe(true);
  });

  it("recognizes a typographic apostrophe, which is what a phone produces", () => {
    for (const apostrophe of ["’", "ʼ", "‘", "´", "`"]) {
      expect(isNavigatorExecutionConfirmation(`let${apostrophe}s do it`), apostrophe).toBe(true);
    }
    // And no apostrophe at all: orthography, not a different sentence.
    expect(isNavigatorExecutionConfirmation("lets do it")).toBe(true);
  });

  it("ignores case, surrounding and repeated whitespace", () => {
    expect(isNavigatorExecutionConfirmation("  LET'S   DO   IT  ")).toBe(true);
    expect(isNavigatorExecutionConfirmation("\n Hagamos\tEso \n")).toBe(true);
  });

  it("ignores harmless terminal punctuation", () => {
    expect(isNavigatorExecutionConfirmation("Let's do it.")).toBe(true);
    expect(isNavigatorExecutionConfirmation("let's do it!!")).toBe(true);
    expect(isNavigatorExecutionConfirmation("¡Hagamos eso!")).toBe(true);
  });

  it("folds accents rather than refusing a correctly typed Spanish verb", () => {
    expect(isNavigatorExecutionConfirmation("ejecutá la propuesta")).toBe(true);
    expect(normalizeConfirmationText("Ejecutá La Propuesta.")).toBe("ejecuta la propuesta");
  });

  it("recognizes the two explicit alternatives", () => {
    expect(isNavigatorExecutionConfirmation("Execute the proposal")).toBe(true);
    expect(isNavigatorExecutionConfirmation("ejecuta la propuesta")).toBe(true);
  });
});

describe("what is discussion, not authorization", () => {
  const rejected = [
    // Qualifications. The owner is still deciding.
    "let's do it after changing the database",
    "hagamos eso pero primero revisa el esquema",
    "ok let's do it",
    "let's do it, but split step 2 first",
    // Questions.
    "let's do it?",
    "should we let's do it",
    "¿hagamos eso?",
    // Negations.
    "let's not do it",
    "no hagamos eso",
    "don't execute the proposal",
    // Quoting the phrase rather than saying it.
    `"let's do it"`,
    "“hagamos eso”",
    "the confirmation phrase is: let's do it",
    // The phrase as a substring of something longer.
    "when you are happy, let's do it together",
    "ejecuta la propuesta de la semana pasada",
    // Slash commands are the composer's own syntax.
    "/plan",
    "/let's do it",
    "  /execute the proposal",
    // Ordinary conversation.
    "what would step 3 involve?",
    "",
    "   ",
    "do it",
    "execute",
    "hagamos",
  ];

  it("recognizes none of it", () => {
    for (const text of rejected) {
      expect(isNavigatorExecutionConfirmation(text), JSON.stringify(text)).toBe(false);
    }
  });
});

/* -------------------------------------------------------------- routing */

describe("routing a send", () => {
  it("executes for a recognized phrase on an eligible Navigator proposal", () => {
    expect(route()).toEqual({ kind: "execute", proposal });
  });

  it("sends ordinary Navigator conversation down the existing path", () => {
    expect(route({ text: "let's do it after changing the database" })).toEqual({ kind: "send" });
    expect(route({ text: "what about step 3?" })).toEqual({ kind: "send" });
  });

  it("treats the same words on a coding thread as an ordinary message", () => {
    expect(route({ purpose: "coding" })).toEqual({ kind: "send" });
    expect(route({ purpose: undefined })).toEqual({ kind: "send" });
  });

  it("treats them as conversation in a draft, which has nothing to execute", () => {
    expect(route({ isDurableThread: false })).toEqual({ kind: "send" });
  });

  it("never invents an objective when there is no settled proposal", () => {
    // THE ONE THAT MATTERS MOST. With no proposal the owner's words are the
    // only candidate objective, and using them is exactly what must not happen.
    expect(route({ proposal: null })).toEqual({ kind: "send" });
  });

  it("does not override a proposal that cannot be executed", () => {
    for (const disposition of ["unknown", "inspect-existing"] as const) {
      expect(
        route({
          availability: executeProposalAvailability({
            purpose: "navigator",
            isDurableThread: true,
            latestTurnSettled: true,
            proposal,
            executionCount: 0,
            executing: false,
            lastAttemptDisposition: disposition,
          }),
        }),
        disposition,
      ).toEqual({ kind: "send" });
    }
    expect(
      route({
        availability: executeProposalAvailability({
          purpose: "navigator",
          isDurableThread: true,
          latestTurnSettled: true,
          proposal,
          executionCount: 1,
          executing: false,
          lastAttemptDisposition: null,
        }),
      }),
    ).toEqual({ kind: "send" });
  });

  it("sends anything carrying an attachment", () => {
    // An image, a terminal excerpt, a review comment or a preview annotation
    // means the owner was composing for Navigator, not confirming.
    expect(route({ hasAttachments: true })).toEqual({ kind: "send" });
  });
});

/* ------------------------------------------------------------ typing */

describe("the routing contract", () => {
  it("carries the proposal, and never the owner's text", () => {
    const decision = route();
    expect(decision.kind).toBe("execute");
    if (decision.kind !== "execute") return;
    // The objective is the server-derived proposal. The words that triggered
    // this are not part of the decision and cannot reach the wire.
    expect(Object.keys(decision).toSorted()).toEqual(["kind", "proposal"]);
    expect(JSON.stringify(decision)).not.toContain("let");
  });
});

/* ------------------------------------------------------------ consuming */

describe("consuming a routed send", () => {
  const spies = () => ({
    clearComposer: vi.fn(),
    execute: vi.fn(async () => null),
  });

  it("clears the composer, executes exactly once, and stops the send", async () => {
    const { clearComposer, execute } = spies();
    const consumed = await consumeNavigatorConfirmation({ route: route(), clearComposer, execute });

    // True is what makes the caller `return` before any provider dispatch.
    expect(consumed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    // The proposal, not the owner's words. The objective stays server-derived.
    expect(execute).toHaveBeenCalledWith(proposal);
    expect(clearComposer).toHaveBeenCalledTimes(1);
  });

  it("touches nothing at all for an ordinary send", async () => {
    const { clearComposer, execute } = spies();
    const consumed = await consumeNavigatorConfirmation({
      route: route({ text: "let's do it after changing the database" }),
      clearComposer,
      execute,
    });

    // False means the existing send path runs exactly as it did — and no Peer
    // Loop method was called on the way past.
    expect(consumed).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(clearComposer).not.toHaveBeenCalled();
  });

  it("calls no Peer Loop method for any conversation that is not eligible", async () => {
    for (const overrides of [
      { purpose: "coding" as const },
      { isDurableThread: false },
      { proposal: null },
      { hasAttachments: true },
      { text: "¿hagamos eso?" },
      { text: "/execute the proposal" },
    ]) {
      const { clearComposer, execute } = spies();
      const consumed = await consumeNavigatorConfirmation({
        route: route(overrides),
        clearComposer,
        execute,
      });
      expect(consumed, JSON.stringify(overrides)).toBe(false);
      expect(execute, JSON.stringify(overrides)).not.toHaveBeenCalled();
      expect(clearComposer, JSON.stringify(overrides)).not.toHaveBeenCalled();
    }
  });
});

/* ------------------------------------------------- submitting with no provider */

describe("submitting when no provider is configured", () => {
  const providerBlocks = (overrides: Partial<Parameters<typeof routeNavigatorSend>[0]> = {}) =>
    providerBlocksComposerSubmit({
      noProviderAvailable: true,
      allowsSubmitWithoutProvider: route(overrides).kind === "execute",
    });

  it("does not block an exact eligible confirmation", () => {
    // Executing calls Peer Loop's own operation. Refusing it because the
    // *conversation's* provider is missing refuses the one action that would
    // still have worked — and, before this, drew its button disabled too.
    expect(providerBlocks()).toBe(false);
  });

  it("still blocks ordinary conversation with nowhere to send it", () => {
    for (const overrides of [
      { text: "let's do it after changing the database" },
      { text: "what about step 3?" },
      { text: "¿hagamos eso?" },
      { text: "/execute the proposal" },
      { purpose: "coding" as const },
      { isDurableThread: false },
      { proposal: null },
      { hasAttachments: true },
    ]) {
      expect(providerBlocks(overrides), JSON.stringify(overrides)).toBe(true);
    }
  });

  it("blocks nothing at all when a provider is available", () => {
    expect(
      providerBlocksComposerSubmit({
        noProviderAvailable: false,
        allowsSubmitWithoutProvider: false,
      }),
    ).toBe(false);
    expect(
      providerBlocksComposerSubmit({
        noProviderAvailable: false,
        allowsSubmitWithoutProvider: true,
      }),
    ).toBe(false);
  });

  it("never overrides the composer's own reason for refusing", () => {
    // Messages still loading, an image still compressing: not about providers,
    // and a confirmation does not get to skip them.
    expect(composerSubmitBlocked({ providerBlocksSubmit: false, isSendDisabled: true })).toBe(true);
    expect(composerSubmitBlocked({ providerBlocksSubmit: true, isSendDisabled: true })).toBe(true);
  });

  it("is the same value the submit callback and the controls both read", () => {
    /*
     * THE DEFECT THIS CLOSES. The callback allowed an eligible confirmation
     * while every visible control consulted `noProviderAvailable` directly, so
     * the press that would have worked was drawn disabled. One derived value,
     * one answer.
     */
    const eligible = providerBlocks();
    expect(composerSubmitBlocked({ providerBlocksSubmit: eligible, isSendDisabled: false })).toBe(
      false,
    );
    const ordinary = providerBlocks({ text: "what about step 3?" });
    expect(composerSubmitBlocked({ providerBlocksSubmit: ordinary, isSendDisabled: false })).toBe(
      true,
    );
  });
});
