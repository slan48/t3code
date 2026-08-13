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
import type { PeerLoopSubscriptionEvent } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
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

/**
 * How long an unobserved run subscription lingers. It does not.
 *
 * An open subscription is a live `run.attach` on the machine running Peer Loop,
 * not a cached answer: leaving it up for five minutes after the last viewer
 * closed the page keeps that run's attachment held and its replay coordination
 * occupied for nobody.
 */
export const PEER_LOOP_EVENTS_IDLE_TTL_MS = 0;

/**
 * One subscription event per chunk, on the client side of the socket.
 *
 * THE ATOM ADAPTER KEEPS ONLY THE LAST ITEM OF EACH CHUNK IT PULLS. That is
 * `makeStream` in `effect/unstable/reactivity`: `step(arr)` calls `setSelf` once
 * with `Arr.lastNonEmpty(arr)`, so every earlier element of a multi-element
 * chunk is dropped before any fold can see it.
 *
 * A run's opening burst is exactly that shape. `peerLoop.subscribeEvents`
 * concatenates the transport fact, the `run-attached` snapshot, `run-synced`
 * when the attach was already caught up, and the whole replayed backlog, all
 * available at once. The server rechunks its own egress to singletons, but that
 * guarantee ends at the wire: the RPC client pulls whatever has arrived as one
 * chunk, so the burst reaches the atom as one array and collapses to its final
 * element — no snapshot, no state, no owner question, no controls, and only the
 * last activity item. Rechunking here restores the guarantee at the boundary
 * that actually loses it.
 *
 * Deliberately not applied to every subscription in `runtime.ts`: streams whose
 * meaning IS "the latest value" — resource telemetry, VCS status, terminal
 * metadata — are correct as they are and would only recompute more often. This
 * is for the one stream whose every item is a separate durable fact.
 */
export const rechunkPeerLoopEvents = <E, R>(
  stream: Stream.Stream<PeerLoopSubscriptionEvent, E, R>,
): Stream.Stream<PeerLoopSubscriptionEvent, E, R> => Stream.rechunk(stream, 1);

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
     *
     * DISPOSED THE MOMENT NOTHING IS WATCHING IT. The family's five-minute
     * default is right for a poll whose answer is worth caching; it is wrong
     * for an open `run.attach`, which holds a per-run attachment on the server
     * and keeps replay coordination busy for a run nobody is looking at. It
     * would also hand a returning visitor the last event of a stream they had
     * left, which is not what a fresh visit means. Same reasoning as the other
     * owner-scoped streams in this app.
     */
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:peer-loop:events",
      tag: WS_METHODS.peerLoopSubscribeEvents,
      idleTtlMs: PEER_LOOP_EVENTS_IDLE_TTL_MS,
      // Every item is its own durable fact, so none of them may be coalesced
      // away by the chunk the atom adapter happens to pull. See above.
      transform: rechunkPeerLoopEvents,
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
    /**
     * Execute one agreed Navigator Execution Proposal.
     *
     * Sends a thread and a proposal id and nothing else: the server derives the
     * project and the objective from its own record, so a client cannot aim a
     * run at another directory or substitute a plan that was never reviewed.
     *
     * The reply carries Peer Loop's start result and the recorded link, so the
     * run id is available immediately. There is no UI on this yet.
     */
    executeProposal: createEnvironmentRpcCommand(runtime, {
      label: "peer-loop:execute-proposal",
      tag: WS_METHODS.peerLoopExecuteProposal,
    }),
    /**
     * Answer the question a linked run has stopped to ask.
     *
     * Sends a thread, a run, the fingerprint of the decision the owner was
     * looking at, and which option they picked — never the option's text. The
     * server proves the run belongs to the conversation, re-reads the run, and
     * resolves the text from that reading, so a stale view cannot answer a
     * question the run has already left.
     *
     * The result distinguishes a delivered answer from a view that needs
     * refreshing; neither is an error. There is no UI on this yet.
     */
    answerOwnerDecision: createEnvironmentRpcCommand(runtime, {
      label: "peer-loop:answer-owner-decision",
      tag: WS_METHODS.peerLoopAnswerOwnerDecision,
    }),
  };
}
