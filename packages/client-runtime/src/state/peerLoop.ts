/**
 * Peer Loop atoms for web and mobile.
 *
 * Everything goes through the environment's authenticated RPC session, so a
 * phone on the tailnet drives the same environment-local Peer Loop as the
 * machine's own browser. No client ever talks to the bridge subprocess.
 *
 * Status and run lists are polled; activity is streamed. That split follows the
 * data: a run list changes at agent boundaries, while the event stream is the
 * thing an operator is actually watching.
 *
 * @module PeerLoopAtoms
 */
import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * How often the status and run list are re-read.
 *
 * Peer Loop moves at agent speed — a Builder turn is minutes — so seconds are
 * the right unit, and the event subscription carries anything that needs to be
 * immediate.
 */
export const PEER_LOOP_STATUS_POLL_MS = 5_000;
export const PEER_LOOP_RUNS_POLL_MS = 5_000;

export function createPeerLoopEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    status: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:peer-loop:status",
      tag: WS_METHODS.peerLoopStatus,
      staleTimeMs: PEER_LOOP_STATUS_POLL_MS - 500,
      refreshIntervalMs: PEER_LOOP_STATUS_POLL_MS,
    }),
    runs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:peer-loop:runs",
      tag: WS_METHODS.peerLoopListRuns,
      staleTimeMs: PEER_LOOP_RUNS_POLL_MS - 500,
      refreshIntervalMs: PEER_LOOP_RUNS_POLL_MS,
    }),
    /** A run's durable snapshot, on demand. Read-only. */
    attach: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:peer-loop:attach",
      tag: WS_METHODS.peerLoopAttachRun,
    }),
    /**
     * The activity stream for one run, from the caller's own `afterSeq`.
     *
     * Re-subscribing with a newer cursor is how a reconnecting client catches
     * up; the server replays the durable backlog and then continues live.
     */
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:peer-loop:events",
      tag: WS_METHODS.peerLoopSubscribeEvents,
    }),
  };
}

/**
 * The owner controls.
 *
 * Each one is a distinct typed command rather than a generic "send this to the
 * bridge", so the server can authorize them separately and a client cannot
 * invent a method. Recovery has no default here for the same reason it has none
 * in Peer Loop: replaying an interrupted Builder task is an owner's decision.
 */
export function createPeerLoopEnvironmentCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    startRun: createEnvironmentRpcCommand(runtime, {
      label: "peer-loop:start-run",
      tag: WS_METHODS.peerLoopStartRun,
    }),
    resumeRun: createEnvironmentRpcCommand(runtime, {
      label: "peer-loop:resume-run",
      tag: WS_METHODS.peerLoopResumeRun,
    }),
    sendOwnerMessage: createEnvironmentRpcCommand(runtime, {
      label: "peer-loop:send-owner-message",
      tag: WS_METHODS.peerLoopSendOwnerMessage,
    }),
    pauseRun: createEnvironmentRpcCommand(runtime, {
      label: "peer-loop:pause-run",
      tag: WS_METHODS.peerLoopPauseRun,
    }),
    recoverRun: createEnvironmentRpcCommand(runtime, {
      label: "peer-loop:recover-run",
      tag: WS_METHODS.peerLoopRecoverRun,
    }),
  };
}
