import { describe, expect, it } from "vite-plus/test";

import type {
  PeerLoopEvent,
  PeerLoopHaltKind,
  PeerLoopRunStateFile,
  PeerLoopSubscriptionEvent,
} from "@t3tools/contracts";

import {
  applyPeerLoopSubscriptionEvent,
  emptyPeerLoopRunView,
  peerLoopAttention,
  peerLoopRunSnapshot,
  type PeerLoopRunView,
} from "./peerLoopReducer.ts";

const runId = "run-1";

const event = (seq: number, type = "notice"): PeerLoopEvent =>
  ({
    runId,
    seq,
    ts: `2026-08-09T00:00:0${seq % 10}.000Z`,
    type,
    actor: "system",
    iteration: 1,
    payload: { kind: type },
  }) as PeerLoopEvent;

const runEvent = (seq: number, replay = false): PeerLoopSubscriptionEvent => ({
  kind: "run-event",
  runId,
  event: event(seq),
  replay,
});

const runState = (haltKind: PeerLoopHaltKind | null): PeerLoopRunStateFile =>
  ({
    schemaVersion: 1,
    runId,
    projectPath: "/repos/demo",
    state: haltKind === null ? "builder_working" : "paused",
    iteration: 3,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:05:00.000Z",
    ownerPolicyText: "OWNER POLICY",
    builderSessionId: null,
    reviewerThreadId: null,
    repo: null,
    lastBuilderTask: "Write NOTES.md. Then STOP.",
    lastBuilderReport: null,
    lastReviewerDecision: null,
    queuedOwnerMessages: [],
    inFlight: null,
    haltReason: haltKind === null ? null : { kind: haltKind, message: `halted: ${haltKind}` },
    stopRequested: false,
    adapters: {
      reviewer: "codex",
      reviewerVersion: null,
      builder: "claude-code",
      builderVersion: null,
    },
    safetyLimit: null,
    lastSequence: 5,
  }) as PeerLoopRunStateFile;

const applyAll = (
  view: PeerLoopRunView,
  events: readonly PeerLoopSubscriptionEvent[],
  limit?: number,
): PeerLoopRunView =>
  events.reduce((next, event) => applyPeerLoopSubscriptionEvent(next, event, limit), view);

describe("Peer Loop activity", () => {
  it("keeps events in order and advances the cursor", () => {
    const view = applyAll(emptyPeerLoopRunView(runId), [runEvent(1), runEvent(2), runEvent(3)]);

    expect(view.activity.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    expect(view.afterSeq).toBe(3);
    expect(view.needsResync).toBe(false);
  });

  it("ignores a sequence it has already rendered", () => {
    const first = applyAll(emptyPeerLoopRunView(runId), [runEvent(1), runEvent(2)]);
    // A second client attaching from scratch makes Peer Loop replay the backlog
    // onto the shared feed. This client has already seen it.
    const after = applyAll(first, [runEvent(1, true), runEvent(2, true)]);

    expect(after).toBe(first);
    expect(after.activity.map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it("resumes from afterSeq without re-rendering what it already had", () => {
    const before = applyAll(emptyPeerLoopRunView(runId), [runEvent(1), runEvent(2), runEvent(3)]);

    // Reconnect: the client re-subscribes with its own cursor and the server
    // replays strictly after it.
    const reconnected = applyAll({ ...before, transport: null }, [
      { kind: "transport", transport: connected("2026-08-09T00:01:00.000Z") },
      runEvent(4, true),
      runEvent(5, false),
    ]);

    expect(reconnected.activity.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(reconnected.afterSeq).toBe(5);
    expect(reconnected.needsResync).toBe(false);
  });

  it("flags a gap instead of rendering a feed with a hole in it", () => {
    const view = applyAll(emptyPeerLoopRunView(runId), [runEvent(1), runEvent(4)]);

    expect(view.needsResync).toBe(true);
    expect(view.afterSeq).toBe(4);
  });

  it("rewinds the cursor when the server asks for a resync", () => {
    const view = applyAll(emptyPeerLoopRunView(runId), [
      runEvent(1),
      runEvent(2),
      { kind: "run-resync", runId, afterSeq: 1, reason: "server could not keep up" },
    ]);

    expect(view.needsResync).toBe(true);
    expect(view.afterSeq).toBe(1);
    // Nothing is thrown away: Peer Loop's log still has everything.
    expect(view.activity.map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it("keeps retained activity bounded", () => {
    const view = applyAll(
      emptyPeerLoopRunView(runId),
      Array.from({ length: 12 }, (_, index) => runEvent(index + 1)),
      5,
    );

    expect(view.activity.map((entry) => entry.seq)).toEqual([8, 9, 10, 11, 12]);
    // The cursor is the real position, not "how much we kept".
    expect(view.afterSeq).toBe(12);
  });

  it("ignores events for another run", () => {
    const view = applyAll(emptyPeerLoopRunView(runId), [
      { kind: "run-event", runId: "other", event: event(9), replay: false },
    ]);
    expect(view.activity).toEqual([]);
    expect(view.afterSeq).toBe(0);
  });
});

const connected = (changedAt: string) =>
  ({ state: "connected", changedAt, detail: null, protocolVersion: 1 }) as const;

describe("Peer Loop transport", () => {
  it("records an interruption without touching the run's activity or cursor", () => {
    const running = applyAll(emptyPeerLoopRunView(runId), [
      { kind: "transport", transport: connected("2026-08-09T00:00:00.000Z") },
      runEvent(1),
      runEvent(2),
    ]);

    const interrupted = applyPeerLoopSubscriptionEvent(running, {
      kind: "transport",
      transport: {
        state: "interrupted",
        changedAt: "2026-08-09T00:02:00.000Z",
        detail: "the Peer Loop bridge exited with code 1",
        protocolVersion: null,
      },
    });

    expect(interrupted.transport?.state).toBe("interrupted");
    // The bridge dying says nothing about the run: Peer Loop's durable state is
    // untouched, so neither is ours, and nothing here resumes anything.
    expect(interrupted.afterSeq).toBe(2);
    expect(interrupted.activity.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(interrupted.finished).toBe(false);
    expect(interrupted.needsResync).toBe(false);
  });
});

describe("Peer Loop projections", () => {
  const withState = (haltKind: PeerLoopHaltKind | null): PeerLoopRunView =>
    applyPeerLoopSubscriptionEvent(emptyPeerLoopRunView(runId), {
      kind: "run-outcome",
      runId,
      outcome: { kind: "paused", reason: { kind: haltKind ?? "OWNER_PAUSED", message: "x" } },
      state: runState(haltKind),
    });

  it("distinguishes an owner decision from an environment condition", () => {
    expect(peerLoopAttention(withState("OWNER_REQUIRED"))).toMatchObject({
      kind: "owner-decision",
      actionable: true,
      haltKind: "OWNER_REQUIRED",
    });
    expect(peerLoopAttention(withState("CAPACITY_EXHAUSTED"))).toMatchObject({
      kind: "capacity-exhausted",
      actionable: true,
      haltKind: "CAPACITY_EXHAUSTED",
    });
    expect(peerLoopAttention(withState("AUTH_REQUIRED"))).toMatchObject({
      kind: "auth-required",
      actionable: true,
      haltKind: "AUTH_REQUIRED",
    });
    expect(peerLoopAttention(withState("TRANSPORT_INTERRUPTED"))).toMatchObject({
      kind: "transport-interrupted",
      actionable: true,
      haltKind: "TRANSPORT_INTERRUPTED",
    });
    expect(peerLoopAttention(withState("AMBIGUOUS_INTERRUPTED_TURN"))).toMatchObject({
      kind: "recovery-required",
      actionable: true,
    });
    expect(peerLoopAttention(withState("OWNER_OBJECTIVE_REQUIRED"))).toMatchObject({
      kind: "needs-objective",
      actionable: true,
    });
  });

  it("does not ask for attention on an ordinary pause", () => {
    expect(peerLoopAttention(withState("OWNER_PAUSED"))).toMatchObject({
      kind: "paused",
      actionable: false,
    });
  });

  it("projects DONE over whatever the run last halted on", () => {
    const finished = applyPeerLoopSubscriptionEvent(withState("OWNER_PAUSED"), {
      kind: "run-finished",
      runId,
      outcome: { kind: "done", finalState: "NOTES.md exists", summary: "verified directly" },
      state: runState("OWNER_PAUSED"),
      reason: "terminal",
    });

    expect(finished.finished).toBe(true);
    expect(peerLoopAttention(finished)).toMatchObject({
      kind: "done",
      actionable: false,
      message: "verified directly",
    });
  });

  it("keeps the current task and decision separate from the trimmed feed", () => {
    const view = applyAll(
      withState(null),
      Array.from({ length: 20 }, (_, index) => runEvent(index + 1)),
      3,
    );

    expect(view.activity).toHaveLength(3);
    expect(peerLoopRunSnapshot(view)).toMatchObject({
      state: "builder_working",
      iteration: 3,
      currentTask: "Write NOTES.md. Then STOP.",
      queuedOwnerMessages: 0,
    });
  });
});
