import type {
  EnvironmentId,
  NavigatorApprovalClassificationRpcInput,
  NavigatorApprovalClassificationRpcResult,
} from "@t3tools/contracts";
import {
  NavigatorApprovalClassificationRpcResult as NavigatorApprovalClassificationRpcResultSchema,
  WS_METHODS,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";

import { connectionAtomRuntime } from "../connection/runtime";

/** The only request shape the composer is allowed to send to classification. */
export interface NavigatorApprovalClassificationRequest {
  readonly environmentId: EnvironmentId;
  readonly input: NavigatorApprovalClassificationRpcInput;
}

export function buildNavigatorApprovalClassificationRequest(
  input: NavigatorApprovalClassificationRequest,
): NavigatorApprovalClassificationRequest {
  return {
    environmentId: input.environmentId,
    input: {
      threadId: input.input.threadId,
      proposedPlanId: input.input.proposedPlanId,
      proposalFingerprint: input.input.proposalFingerprint,
      ownerUtterance: input.input.ownerUtterance,
      hasAttachments: input.input.hasAttachments,
    },
  };
}

/** Convert every transport/decoding uncertainty to the ordinary provider path. */
export function navigatorApprovalClassificationFromCommandResult(
  result: AtomCommandResult<unknown, unknown>,
): NavigatorApprovalClassificationRpcResult {
  if (result._tag !== "Success") return { outcome: "send-to-provider" };
  return Schema.is(NavigatorApprovalClassificationRpcResultSchema)(result.value)
    ? result.value
    : { outcome: "send-to-provider" };
}

export const navigatorApprovalCommands = {
  classifyProposalApproval: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "navigator:classify-proposal-approval",
    tag: WS_METHODS.navigatorClassifyProposalApproval,
  }),
};
