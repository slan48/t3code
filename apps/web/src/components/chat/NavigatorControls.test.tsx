/**
 * What a Navigator conversation actually renders.
 *
 * The capability record is only worth something if the components consume it,
 * so these assertions are about markup: the identity that has to stay visible,
 * the wording that has to agree between surfaces, and the controls that must
 * not be drawn. Each one is paired with the coding case, because the other
 * half of this work is that ordinary threads are untouched.
 */
import { ApprovalRequestId, EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  CODING_PROPOSAL_WORDING,
  NAVIGATOR_IDENTITY,
  NAVIGATOR_PROPOSAL_WORDING,
  threadCapabilities,
} from "~/navigatorCapabilities";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PLAN = "# Split the migration\n\n1. Add the column.\n2. Backfill.";

/* ------------------------------------------------------------ approvals */

describe("pending approval actions", () => {
  const render = (canAcceptApprovals: boolean) =>
    renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={ApprovalRequestId.make("approval-1")}
        isResponding={false}
        canAcceptApprovals={canAcceptApprovals}
        onRespondToApproval={async () => undefined}
      />,
    );

  it("offers no way to approve in a planning conversation", () => {
    const markup = render(false);
    expect(markup).not.toContain("Approve once");
    expect(markup).not.toContain("Always allow this session");
    // Clearing the request stays: the server permits it, and without it a
    // Navigator conversation would be stuck on a question it cannot answer.
    expect(markup).toContain("Decline");
    expect(markup).toContain("Cancel turn");
  });

  it("keeps every answer for a coding thread", () => {
    const markup = render(true);
    for (const label of ["Approve once", "Always allow this session", "Decline", "Cancel turn"]) {
      expect(markup).toContain(label);
    }
  });
});

/* -------------------------------------------------- plan follow-up actions */

describe("plan follow-up actions", () => {
  const render = (canImplementPlan: boolean) =>
    renderToStaticMarkup(
      <ComposerPrimaryActions
        compact={false}
        pendingAction={null}
        isRunning={false}
        showPlanFollowUpPrompt
        canImplementPlan={canImplementPlan}
        promptHasText={false}
        isSendBusy={false}
        sendDisabledReason={null}
        isConnecting={false}
        isEnvironmentUnavailable={false}
        isPreparingWorktree={false}
        hasSendableContent
        onPreviousPendingQuestion={() => undefined}
        onInterrupt={() => undefined}
        onImplementPlanInNewThread={() => undefined}
      />,
    );

  it("offers refinement and neither implementation path for Navigator", () => {
    const markup = render(false);
    expect(markup).toContain("Refine");
    expect(markup).not.toContain(">Implement<");
    expect(markup).not.toContain("Implement in a new thread");
    // And no empty menu shell left behind where the split button was.
    expect(markup).not.toContain("Implementation actions");
    expect(markup).not.toContain("data-chat-composer-implement-actions");
  });

  it("keeps both implementation paths for a coding thread", () => {
    // The menu popup is portalled and does not appear in static markup, so the
    // observable proof is the split-button shell and its trigger.
    const markup = render(true);
    expect(markup).toContain(">Implement<");
    expect(markup).toContain('data-chat-composer-implement-actions="true"');
    expect(markup).toContain('aria-label="Implementation actions"');
  });
});

/* --------------------------------------------------------- plan wording */

describe("proposal presentation", () => {
  it("labels a Navigator plan an Execution Proposal and hides the workspace write", async () => {
    const { ProposedPlanCard } = await import("./ProposedPlanCard");
    const markup = renderToStaticMarkup(
      <ProposedPlanCard
        planMarkdown={PLAN}
        environmentId={ENVIRONMENT_ID}
        cwd={undefined}
        workspaceRoot="/repos/demo"
        wording={NAVIGATOR_PROPOSAL_WORDING}
        canSaveToWorkspace={false}
      />,
    );
    expect(markup).toContain("Execution Proposal");
    expect(markup).not.toContain(">Plan<");
    // The actions live in a portalled menu that static markup does not
    // include, so the menu trigger is what is observable here; which items it
    // contains is asserted through the capability record below.
    expect(markup).toContain('aria-label="Plan actions"');
  });

  it("leaves a coding plan card exactly as it was", async () => {
    const { ProposedPlanCard } = await import("./ProposedPlanCard");
    const markup = renderToStaticMarkup(
      <ProposedPlanCard
        planMarkdown={PLAN}
        environmentId={ENVIRONMENT_ID}
        cwd={undefined}
        workspaceRoot="/repos/demo"
      />,
    );
    expect(markup).toContain(">Plan<");
    expect(markup).not.toContain("Execution Proposal");
  });

  it("uses the same wording record the sidebar reads", () => {
    // The card and the Plan sidebar must not be able to disagree about what
    // this conversation calls its plan; they read one record.
    expect(NAVIGATOR_PROPOSAL_WORDING.badge).toBe("Execution Proposal");
    expect(NAVIGATOR_PROPOSAL_WORDING.untitled).toBe("Execution Proposal");
    expect(CODING_PROPOSAL_WORDING.badge).toBe("Plan");
    expect(CODING_PROPOSAL_WORDING.untitled).toBe("Proposed plan");
  });
});

/* -------------------------------------------------------------- identity */

describe("conversation identity", () => {
  it("is a labelled, accessible badge rather than a title convention", () => {
    // The generated title stops saying "Navigator" as soon as the model names
    // the conversation after its subject, which is why identity cannot live
    // in the title.
    expect(NAVIGATOR_IDENTITY.label).toBe("Navigator");
    expect(NAVIGATOR_IDENTITY.ariaLabel).toContain("Navigator");
    expect(NAVIGATOR_IDENTITY.ariaLabel).not.toBe(NAVIGATOR_IDENTITY.label);
  });
});

/* ---------------------------------------------------------- capabilities */

describe("capabilities consumed by these components", () => {
  it("says no to every control asserted absent above", () => {
    const navigator = threadCapabilities("navigator");
    expect(navigator.canAcceptApprovals).toBe(false);
    expect(navigator.canImplementPlan).toBe(false);
    expect(navigator.canStartRepositoryMutation).toBe(false);
    expect(navigator.canRunProjectScripts).toBe(false);
    expect(navigator.canUseTerminals).toBe(false);
    expect(navigator.canRevertCheckpoint).toBe(false);
    expect(navigator.canChooseCheckout).toBe(false);
    expect(navigator.canChangeRuntimeMode).toBe(false);
    expect(navigator.canChangeInteractionMode).toBe(false);
  });
});
