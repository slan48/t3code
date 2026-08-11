import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  PEER_LOOP_WS_METHODS,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { RPC_REQUIRED_SCOPES, requiredScopeForRpcMethod } from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("authorizes background policy reporting and observation deliberately", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportClientActivity)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverReportHostPowerState)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.subscribeBackgroundPolicy)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("allows relay status reads without granting relay installation access", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudGetRelayClientStatus)).toBe(
      AuthRelayReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudInstallRelayClient)).toBe(AuthRelayWriteScope);
  });

  it("separates Peer Loop observation from Peer Loop control", () => {
    for (const method of [
      WS_METHODS.peerLoopStatus,
      WS_METHODS.peerLoopListRuns,
      WS_METHODS.peerLoopAttachRun,
      WS_METHODS.peerLoopSubscribeEvents,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    }

    // Anything that makes an agent act, spends subscription capacity, or
    // resolves an interrupted turn needs operate — recovery most of all, since
    // one of its choices replays a Builder task that may already have run.
    for (const method of [
      WS_METHODS.peerLoopStartRun,
      WS_METHODS.peerLoopResumeRun,
      WS_METHODS.peerLoopSendOwnerMessage,
      WS_METHODS.peerLoopPauseRun,
      WS_METHODS.peerLoopRecoverRun,
      // Executing a proposal calls `startRun` underneath: same agents, same
      // subscription capacity, same scope.
      WS_METHODS.peerLoopExecuteProposal,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("declares a scope for every Peer Loop method the group registers", () => {
    // Coupled to the method table rather than a hand-kept list, so a new Peer
    // Loop RPC cannot reach production unauthorized.
    for (const method of Object.values(PEER_LOOP_WS_METHODS)) {
      expect(() => requiredScopeForRpcMethod(method)).not.toThrow();
    }
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});
