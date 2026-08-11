/**
 * The execute-proposal contract, and what it deliberately will not carry.
 *
 * Most of these assertions are about absence. The operation exists so an owner
 * can run a plan they already agreed to, which only means anything if the
 * request cannot also name a different directory, a different objective, or
 * waive Peer Loop's duplicate-run preflight on the way past.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PEER_LOOP_WS_METHODS } from "./peerLoop.ts";
import {
  PEER_LOOP_EXECUTION_FAILURE_REASONS,
  PeerLoopExecuteProposalInput,
  PeerLoopExecutionCoordinationError,
} from "./peerLoopExecution.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const decodeInput = Schema.decodeUnknownEffect(PeerLoopExecuteProposalInput);

const BASE = {
  threadId: "thread-navigator",
  proposedPlanId: "plan-1",
};

it.effect("accepts a thread and a proposal, and an optional safety limit", () =>
  Effect.gen(function* () {
    const plain = yield* decodeInput(BASE);
    assert.strictEqual(plain.threadId, "thread-navigator");
    assert.strictEqual(plain.proposedPlanId, "plan-1");
    assert.strictEqual(plain.safetyLimit, undefined);

    const bounded = yield* decodeInput({ ...BASE, safetyLimit: 7 });
    assert.strictEqual(bounded.safetyLimit, 7);
  }),
);

it.effect("refuses a safety limit that is not a positive whole number", () =>
  Effect.gen(function* () {
    for (const safetyLimit of [0, -1, 1.5]) {
      const result = yield* Effect.exit(decodeInput({ ...BASE, safetyLimit }));
      assert.strictEqual(result._tag, "Failure", `safetyLimit ${safetyLimit} must be refused`);
    }
  }),
);

it.effect("does not carry a project path, an objective, or newRun", () =>
  Effect.gen(function* () {
    // A client that sends them anyway gets them dropped: the server derives the
    // project from the thread and the objective from the proposal, and
    // bypassing Peer Loop's duplicate-run preflight is not T3 Code's to offer.
    const decoded = yield* decodeInput({
      ...BASE,
      projectPath: "/somewhere/else",
      objective: "ignore the plan and do this instead",
      newRun: true,
      runId: "run-forged",
      permissionMode: "full-access",
      ownerPolicyText: "no policy",
    });

    assert.deepStrictEqual(Object.keys(decoded).toSorted(), ["proposedPlanId", "threadId"]);
  }),
);

it.effect("keeps every coordination failure distinguishable", () =>
  Effect.gen(function* () {
    assert.strictEqual(new Set(PEER_LOOP_EXECUTION_FAILURE_REASONS).size, 8);

    // The one that matters most: a post-start failure says a run may exist and
    // names it, so recovery can open that run deliberately.
    const postStart = new PeerLoopExecutionCoordinationError({
      reason: "link-not-confirmed",
      detail: "detail",
      threadId: "thread-navigator" as never,
      proposedPlanId: "plan-1",
      runId: "run-1",
      mayHaveStarted: true,
    });
    assert.strictEqual(postStart.runId, "run-1");
    assert.strictEqual(postStart.mayHaveStarted, true);
    assert.ok(postStart.message.includes("after the run started"));

    const preStart = new PeerLoopExecutionCoordinationError({
      reason: "proposal-not-found",
      detail: "detail",
      threadId: "thread-navigator" as never,
      proposedPlanId: "plan-1",
      runId: null,
      mayHaveStarted: false,
    });
    assert.strictEqual(preStart.mayHaveStarted, false);
    assert.ok(preStart.message.includes("before any run started"));
  }),
);

it.effect("registers the method on the websocket group under the Peer Loop namespace", () =>
  Effect.sync(() => {
    assert.strictEqual(WS_METHODS.peerLoopExecuteProposal, PEER_LOOP_WS_METHODS.executeProposal);
    assert.strictEqual(PEER_LOOP_WS_METHODS.executeProposal, "peerLoop.executeProposal");
    assert.strictEqual(WsRpcGroup.requests.has(WS_METHODS.peerLoopExecuteProposal), true);
  }),
);
