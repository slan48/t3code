import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import { OrchestrationProposedPlanId } from "./orchestration.ts";
import { PeerLoopProposalFingerprint } from "./peerLoopExecution.ts";

/**
 * The closed, trait-only result returned by the Navigator natural-approval
 * classifier. This deliberately contains no execution verdict or action.
 */
export const NavigatorApprovalTraits = Schema.Struct({
  expressesApproval: Schema.Boolean,
  addsCondition: Schema.Boolean,
  requestsModification: Schema.Boolean,
  asksQuestion: Schema.Boolean,
  expressesDoubt: Schema.Boolean,
  isNegation: Schema.Boolean,
  isQuotationOrHypothetical: Schema.Boolean,
  referencesSomethingElse: Schema.Boolean,
  isBareAffirmation: Schema.Boolean,
  confidence: Schema.Literals(["high", "low"]),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

export type NavigatorApprovalTraits = typeof NavigatorApprovalTraits.Type;

/**
 * Hard wire bound for an owner utterance sent to the future classification
 * gate. The deterministic candidate filter is stricter, but the RPC must
 * reject unbounded input before it reaches any server service.
 */
export const NAVIGATOR_APPROVAL_OWNER_UTTERANCE_MAX_CHARS = 8_000;

export const NavigatorApprovalClassificationRpcInput = Schema.Struct({
  threadId: ThreadId,
  proposedPlanId: OrchestrationProposedPlanId,
  proposalFingerprint: PeerLoopProposalFingerprint,
  ownerUtterance: Schema.String.check(
    Schema.isMaxLength(NAVIGATOR_APPROVAL_OWNER_UTTERANCE_MAX_CHARS),
    Schema.makeFilter((value) =>
      value.trim().length > 0 ? undefined : "Owner utterance must not be blank.",
    ),
  ),
  hasAttachments: Schema.Boolean,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type NavigatorApprovalClassificationRpcInput =
  typeof NavigatorApprovalClassificationRpcInput.Type;

/**
 * Classification is deliberately a fail-closed RPC. Preconditions and
 * classifier uncertainty are indistinguishable from an ordinary provider
 * message at this boundary; no execution verdict crosses the wire.
 */
export const NavigatorApprovalClassificationRpcResult = Schema.Union([
  Schema.Struct({
    outcome: Schema.Literal("classified"),
    traits: NavigatorApprovalTraits,
  }).annotate({ parseOptions: { onExcessProperty: "error" } }),
  Schema.Struct({ outcome: Schema.Literal("send-to-provider") }).annotate({
    parseOptions: { onExcessProperty: "error" },
  }),
]);
export type NavigatorApprovalClassificationRpcResult =
  typeof NavigatorApprovalClassificationRpcResult.Type;
