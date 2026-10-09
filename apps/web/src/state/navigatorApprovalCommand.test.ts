import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import {
  buildNavigatorApprovalClassificationRequest,
  navigatorApprovalClassificationFromCommandResult,
} from "./navigatorApprovalCommand";

const ENVIRONMENT = "environment-a" as EnvironmentId;
const INPUT = {
  threadId: ThreadId.make("thread-a"),
  proposedPlanId: "proposal-a",
  proposalFingerprint: "0123456789abcdef0123456789abcdef",
  ownerUtterance: "  Sí, procede con el plan.  ",
  hasAttachments: false,
} as const;

describe("navigator approval classification command", () => {
  it("builds only the environment wrapper and the approved classifier input", () => {
    expect(
      buildNavigatorApprovalClassificationRequest({
        environmentId: ENVIRONMENT,
        input: INPUT,
      }),
    ).toEqual({ environmentId: ENVIRONMENT, input: INPUT });
  });

  it("fails closed for command failure, interruption, malformed output, and non-success results", () => {
    const failed = AsyncResult.failure(Cause.die(new Error("provider details")));
    expect(navigatorApprovalClassificationFromCommandResult(failed)).toEqual({
      outcome: "send-to-provider",
    });
    expect(
      navigatorApprovalClassificationFromCommandResult(AsyncResult.failure(Cause.interrupt())),
    ).toEqual({ outcome: "send-to-provider" });
    expect(
      navigatorApprovalClassificationFromCommandResult(
        AsyncResult.success({ outcome: "classified", traits: { expressesApproval: true } }),
      ),
    ).toEqual({ outcome: "send-to-provider" });
    expect(
      navigatorApprovalClassificationFromCommandResult(AsyncResult.success({ outcome: "unknown" })),
    ).toEqual({ outcome: "send-to-provider" });
  });

  it("preserves a valid trait-only classification", () => {
    const traits = {
      expressesApproval: true,
      addsCondition: false,
      requestsModification: false,
      asksQuestion: false,
      expressesDoubt: false,
      isNegation: false,
      isQuotationOrHypothetical: false,
      referencesSomethingElse: false,
      isBareAffirmation: false,
      confidence: "high",
    } as const;
    expect(
      navigatorApprovalClassificationFromCommandResult(
        AsyncResult.success({
          outcome: "classified",
          traits,
        }),
      ),
    ).toEqual({ outcome: "classified", traits });
  });
});
