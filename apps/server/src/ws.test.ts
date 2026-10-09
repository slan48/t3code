import { NavigatorApprovalClassificationRpcResult, ThreadId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import * as NavigatorApprovalClassificationCoordinator from "./navigatorApproval/ClassificationCoordinator.ts";
import { makeNavigatorApprovalClassificationRpcHandler } from "./ws.ts";

it.effect("navigator classification WS adapter delegates the typed request", () =>
  Effect.gen(function* () {
    const calls: unknown[] = [];
    const result: NavigatorApprovalClassificationRpcResult = {
      outcome: "send-to-provider",
    };
    const coordinator = {
      classifyProposalApproval: (input: unknown) => {
        calls.push(input);
        return Effect.succeed(result);
      },
    } as NavigatorApprovalClassificationCoordinator.NavigatorApprovalClassificationCoordinator["Service"];
    const request = {
      threadId: ThreadId.make("thread-navigator"),
      proposedPlanId: "proposal-1",
      proposalFingerprint: "a".repeat(32),
      ownerUtterance: "Perfecto, me parece bien. Puedes empezar.",
      hasAttachments: false,
    };

    const response = yield* makeNavigatorApprovalClassificationRpcHandler(coordinator)(request);

    expect(response).toBe(result);
    expect(calls).toEqual([request]);
  }),
);
