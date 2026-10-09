/**
 * What counts as an owner confirming, and — much more importantly — what does not.
 *
 * The false positive here is a Peer Loop run against a repository the owner was
 * still thinking about, so the rejections are the substance of this file. Every
 * "no" below is a sentence somebody will plausibly type into a Navigator
 * conversation while discussing whether to execute.
 */
import type { EnvironmentId, OrchestrationProposedPlanId } from "@t3tools/contracts";
import { PeerLoopCommandRefusedError, ThreadId, TurnId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
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
import { executeProposalAvailability, type NavigatorExecutionFacts } from "./navigatorExecution";
import {
  navigatorExecutionAvailability,
  navigatorExecutionKey,
  navigatorExecutionStore,
} from "./state/navigatorExecutionCommand";

const PLAN_ID = "plan-1" as OrchestrationProposedPlanId;
const PLAN_TURN_ID = TurnId.make("turn-that-produced-the-plan");
const PLAN_MARKDOWN = "# Split the migration";
const proposal = {
  id: PLAN_ID,
  planMarkdown: PLAN_MARKDOWN,
  implementedAt: null,
  implementationThreadId: null,
  turnId: PLAN_TURN_ID,
} as const;

const eligibleAvailability = executeProposalAvailability({
  purpose: "navigator",
  isDurableThread: true,
  proposalSettled: true,
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
    expect(route()).toEqual({
      kind: "execute",
      proposal,
      ownerApprovalText: "let's do it",
    });
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
            proposalSettled: true,
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
          proposalSettled: true,
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
  it("carries the proposal and exact owner approval text", () => {
    const decision = route();
    expect(decision.kind).toBe("execute");
    if (decision.kind !== "execute") return;
    // The objective remains the server-derived proposal. The exact words are
    // carried only as the approval record payload; the server validates and
    // persists them atomically with the execution link.
    expect(Object.keys(decision).toSorted()).toEqual(["kind", "ownerApprovalText", "proposal"]);
    expect(decision.ownerApprovalText).toBe("let's do it");
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
    // The proposal remains server-derived, while the exact consumed utterance
    // is carried separately for atomic durable recording.
    expect(execute).toHaveBeenCalledWith(proposal, "let's do it");
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

/* ----------------------------------- confirming right after a mount */

/**
 * The first `hagamos eso` on a freshly mounted proposal whose last attempt was
 * refused.
 *
 * The availability here is not hand-built: it comes from
 * `navigatorExecutionAvailability`, the same resolver the Execute buttons use,
 * reading the same per-proposal gate. That is the point of the test — the
 * phrase must be judged by the answer the owner can see on the card, on the
 * first submission, with no provider turn and no refresh in between.
 */
describe("a confirmation on a proposal whose last attempt was refused", () => {
  const ENVIRONMENT = "environment-local" as EnvironmentId;
  const THREAD = ThreadId.make("thread-navigator-confirm");
  const CONFIRM_PLAN = "plan-confirm" as OrchestrationProposedPlanId;
  const historical = {
    id: CONFIRM_PLAN,
    planMarkdown: PLAN_MARKDOWN,
    implementedAt: null,
    implementationThreadId: null,
    turnId: TurnId.make("turn-that-produced-the-plan"),
  } as const;

  const facts: NavigatorExecutionFacts = {
    environmentId: ENVIRONMENT,
    threadId: THREAD,
    purpose: "navigator",
    // A conversation loaded from the server: nothing in flight.
    unsettledTurnId: null,
    executionsByProposal: new Map(),
  };

  const seed = async (error: unknown) => {
    navigatorExecutionStore.reset();
    await navigatorExecutionStore.execute(
      navigatorExecutionKey({
        environmentId: ENVIRONMENT,
        threadId: THREAD,
        proposedPlanId: CONFIRM_PLAN,
      }),
      { run: async () => AsyncResult.failure(Cause.fail(error)) },
    );
  };

  /** Exactly what the composer resolves on submit. */
  const submit = (text: string) =>
    routeNavigatorSend({
      text,
      hasAttachments: false,
      purpose: facts.purpose,
      isDurableThread: facts.threadId !== null,
      proposal: historical,
      availability: navigatorExecutionAvailability({ facts, proposal: historical }),
    });

  const refused = (code: string) =>
    new PeerLoopCommandRefusedError({ code, detail: "peer loop said no", data: null });

  it("executes on the first submission after a retryable refusal", async () => {
    for (const code of ["CONTROL_UNAVAILABLE", "PROJECT_HAS_UNFINISHED_RUN"]) {
      await seed(refused(code));
      const execute = vi.fn(async () => null);
      const clearComposer = vi.fn();
      const consumed = await consumeNavigatorConfirmation({
        route: submit("hagamos eso"),
        clearComposer,
        execute,
      });
      // One request, on the first attempt, and the send path stops here.
      expect(consumed, code).toBe(true);
      expect(execute, code).toHaveBeenCalledTimes(1);
      expect(execute, code).toHaveBeenCalledWith(historical, "hagamos eso");
    }
    navigatorExecutionStore.reset();
  });

  it("sends an unknown outcome's confirmation as an ordinary message", async () => {
    // Fail closed. The words are not an override for "a run may already exist".
    await seed(new Error("socket closed"));
    const execute = vi.fn(async () => null);
    const clearComposer = vi.fn();
    const consumed = await consumeNavigatorConfirmation({
      route: submit("hagamos eso"),
      clearComposer,
      execute,
    });
    expect(consumed).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    expect(clearComposer).not.toHaveBeenCalled();
    navigatorExecutionStore.reset();
  });

  it("lets the same confirmation submit with no provider configured", async () => {
    // Executing calls Peer Loop's own operation. A retryable refusal does not
    // change that, and the control must not be drawn disabled for it either.
    await seed(refused("CONTROL_UNAVAILABLE"));
    expect(
      providerBlocksComposerSubmit({
        noProviderAvailable: true,
        allowsSubmitWithoutProvider: submit("hagamos eso").kind === "execute",
      }),
    ).toBe(false);

    await seed(new Error("socket closed"));
    expect(
      providerBlocksComposerSubmit({
        noProviderAvailable: true,
        allowsSubmitWithoutProvider: submit("hagamos eso").kind === "execute",
      }),
    ).toBe(true);
    navigatorExecutionStore.reset();
  });

  it("still refuses everything that is not this exact confirmation", async () => {
    await seed(refused("CONTROL_UNAVAILABLE"));
    for (const text of [
      "hagamos eso pero primero revisemos",
      "¿hagamos eso?",
      "/hagamos eso",
      "what about step 3?",
    ]) {
      expect(submit(text), text).toEqual({ kind: "send" });
    }
    navigatorExecutionStore.reset();
  });
});

/* -------------------------------------- what a phrase still cannot do */

describe("phrases and owner decisions", () => {
  it("routes every confirmation phrase to execution, never to an answer", () => {
    /*
     * THE BOUNDARY THAT MUST NOT MOVE. A linked run stopping to ask its owner
     * a question is answered by pressing one of the options Peer Loop
     * recorded — by index, against a fingerprint of that exact question. A
     * phrase names no run, no decision and no option, so `hagamos eso` cannot
     * mean "pick something" for a run: the only thing it can ever produce is
     * an execution of the proposal in front of the owner.
     */
    for (const phrase of NAVIGATOR_CONFIRMATION_PHRASES) {
      const routed = route({ text: phrase });
      expect(routed.kind, phrase).toBe("execute");
      if (routed.kind === "execute") {
        expect(routed.ownerApprovalText, phrase).toBe(phrase);
        // A proposal, and nothing that could name a run or an option.
        expect(Object.keys(routed.proposal).toSorted(), phrase).toEqual([
          "id",
          "implementationThreadId",
          "implementedAt",
          "planMarkdown",
          "turnId",
        ]);
      }
    }
  });

  it("has no route that could answer a decision at all", () => {
    // The whole vocabulary is two kinds. Adding an answer to it would be a
    // phrase that releases a Builder, which is exactly what is refused here.
    const kinds = new Set(
      [...NAVIGATOR_CONFIRMATION_PHRASES, "what about step 3?", "hagamos eso pero primero…"].map(
        (text) => route({ text }).kind,
      ),
    );
    expect([...kinds].toSorted()).toEqual(["execute", "send"]);
  });
});
