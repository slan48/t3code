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
  peerLoopResumeCursor,
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

  it("treats a skipped sequence as data, not as loss", () => {
    // Peer Loop numbers an event before recording it, so a number can be spent
    // and never appear. Inferring loss here would cry wolf on a healthy run.
    const view = applyAll(emptyPeerLoopRunView(runId), [runEvent(1), runEvent(4)]);

    expect(view.needsResync).toBe(false);
    expect(view.afterSeq).toBe(4);
    expect(view.activity.map((entry) => entry.seq)).toEqual([1, 4]);
  });

  it("rewinds to the safe cursor and trims past it when told to resync", () => {
    const view = applyAll(emptyPeerLoopRunView(runId), [
      runEvent(1),
      runEvent(2),
      runEvent(3),
      { kind: "run-resync", runId, afterSeq: 1, reason: "server could not keep up" },
    ]);

    expect(view.needsResync).toBe(true);
    expect(view.afterSeq).toBe(1);
    expect(peerLoopResumeCursor(view)).toBe(1);
    // Anything past the safe cursor is dropped: the replay that follows will
    // send it again, and keeping it would show the same event twice.
    expect(view.activity.map((entry) => entry.seq)).toEqual([1]);
  });

  it("replays after a resync without duplicating or going backwards", () => {
    const resynced = applyAll(emptyPeerLoopRunView(runId), [
      runEvent(1),
      runEvent(2),
      runEvent(3),
      { kind: "run-resync", runId, afterSeq: 2, reason: "re-subscribe" },
    ]);

    const replayed = applyAll(resynced, [runEvent(3, true), runEvent(5, true), runEvent(6)]);

    expect(replayed.activity.map((entry) => entry.seq)).toEqual([1, 2, 3, 5, 6]);
    expect(replayed.afterSeq).toBe(6);
    const seqs = replayed.activity.map((entry) => entry.seq);
    expect([...new Set(seqs)]).toEqual(seqs);
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
  });

  it("never advances across a range it was told is missing", () => {
    const view = applyAll(emptyPeerLoopRunView(runId), [
      runEvent(1),
      runEvent(2),
      { kind: "run-resync", runId, afterSeq: 1, reason: "overflow" },
    ]);

    // The client resumes from 1; anything it had past that is gone and will
    // arrive again from the durable log.
    expect(view.afterSeq).toBe(1);
    expect(view.activity.some((entry) => entry.seq > 1)).toBe(false);
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

const attached = (
  overrides: {
    readonly available?: boolean;
    readonly resumable?: boolean;
    readonly eventHighWaterMark?: number;
    readonly live?: boolean;
    readonly haltKind?: PeerLoopHaltKind | null;
  } = {},
): PeerLoopSubscriptionEvent => ({
  kind: "run-attached",
  runId,
  snapshot: {
    runId,
    state: runState(overrides.haltKind ?? null),
    control: {
      available: overrides.available ?? true,
      reason: (overrides.available ?? true) ? "live_in_this_bridge" : "held_by_other_process",
      liveWriter: null,
      resumable: overrides.resumable ?? false,
    },
    eventHighWaterMark: overrides.eventHighWaterMark ?? 5,
    replayFromSeq: 0,
    live: overrides.live ?? true,
  },
});

describe("Peer Loop attach snapshot", () => {
  it("seeds authoritative state and control without touching the cursor", () => {
    const view = applyAll(emptyPeerLoopRunView(runId, 3), [attached({ resumable: true })]);

    expect(view.state?.state).toBe("builder_working");
    expect(view.control?.available).toBe(true);
    expect(view.control?.resumable).toBe(true);
    expect(view.eventHighWaterMark).toBe(5);
    expect(view.live).toBe(true);
    // An attach says what the run looks like, never what this client has seen.
    expect(view.afterSeq).toBe(3);
    expect(view.outcome).toBe(null);
    expect(view.finished).toBe(false);
  });

  it("does not clear a resync or discard what was already rendered", () => {
    const resynced = applyAll(emptyPeerLoopRunView(runId), [
      runEvent(1),
      runEvent(2),
      { kind: "run-resync", runId, afterSeq: 2, reason: "overflow" },
    ]);

    const reattached = applyAll(resynced, [attached()]);
    // Only run-synced clears the flag: an attach proves a replay started.
    expect(reattached.needsResync).toBe(true);
    expect(reattached.afterSeq).toBe(2);
    expect(reattached.activity.map((entry) => entry.seq)).toEqual([1, 2]);
  });

  it("ignores a snapshot for another run", () => {
    const view = applyAll(emptyPeerLoopRunView(runId), [runEvent(1)]);
    const other = applyPeerLoopSubscriptionEvent(view, {
      ...(attached() as Extract<PeerLoopSubscriptionEvent, { kind: "run-attached" }>),
      runId: "other",
    });
    expect(other).toBe(view);
  });
});

const synced = (afterSeq: number, eventHighWaterMark: number): PeerLoopSubscriptionEvent => ({
  kind: "run-synced",
  runId,
  afterSeq,
  eventHighWaterMark,
});

describe("Peer Loop catch-up", () => {
  it("clears nothing on a fresh view: there was nothing to clear", () => {
    const view = applyAll(emptyPeerLoopRunView(runId), [synced(0, 0)]);
    expect(view.needsResync).toBe(false);
    expect(view.afterSeq).toBe(0);
  });

  it("clears the flag when a reattachment had nothing to replay", () => {
    const resynced = applyAll(emptyPeerLoopRunView(runId), [
      runEvent(1),
      runEvent(2),
      { kind: "run-resync", runId, afterSeq: 2, reason: "overflow" },
    ]);
    expect(resynced.needsResync).toBe(true);

    // Reattached at 2 with the boundary already at 2. Nothing arrives, and the
    // client must not be left believing its view is incomplete for ever.
    const caughtUp = applyAll(resynced, [synced(2, 2)]);
    expect(caughtUp.needsResync).toBe(false);
    expect(caughtUp.afterSeq).toBe(2);
  });

  it("keeps the flag set throughout a partial replay", () => {
    const resynced = applyAll(emptyPeerLoopRunView(runId), [
      runEvent(1),
      runEvent(2),
      runEvent(3),
      { kind: "run-resync", runId, afterSeq: 1, reason: "server could not keep up" },
    ]);

    // Events arriving is not the same as the replay having finished, and the
    // first replayed event proves nothing at all about the rest.
    const partway = applyAll(resynced, [runEvent(2, true), runEvent(3, true)]);
    expect(partway.needsResync).toBe(true);
    expect(partway.afterSeq).toBe(3);

    const finished = applyAll(partway, [runEvent(5, true), synced(5, 5)]);
    expect(finished.needsResync).toBe(false);
    expect(finished.afterSeq).toBe(5);
    expect(finished.activity.map((entry) => entry.seq)).toEqual([1, 2, 3, 5]);
  });

  it("ignores a premature or overreaching catch-up fact", () => {
    const partway = applyAll(emptyPeerLoopRunView(runId), [
      runEvent(1),
      runEvent(2),
      { kind: "run-resync", runId, afterSeq: 2, reason: "overflow" },
      runEvent(3, true),
    ]);
    expect(partway.needsResync).toBe(true);

    // The boundary is at 9 and this client has delivered 3. Believing it would
    // clear the one flag telling the owner the view is incomplete.
    expect(applyAll(partway, [synced(3, 9)]).needsResync).toBe(true);
    // And a fact claiming a cursor this client never reached is not evidence
    // about this client at all.
    expect(applyAll(partway, [synced(9, 3)]).needsResync).toBe(true);
    // Neither may move the cursor.
    expect(applyAll(partway, [synced(3, 9), synced(9, 3)]).afterSeq).toBe(3);
  });

  it("ignores a catch-up fact for another run", () => {
    const resynced = applyAll(emptyPeerLoopRunView(runId), [
      runEvent(1),
      { kind: "run-resync", runId, afterSeq: 1, reason: "overflow" },
    ]);
    const other = applyPeerLoopSubscriptionEvent(resynced, {
      kind: "run-synced",
      runId: "other",
      afterSeq: 1,
      eventHighWaterMark: 1,
    });
    expect(other).toBe(resynced);
  });

  it("sets the flag again on a later resync, and trims to the new safe cursor", () => {
    const caughtUp = applyAll(emptyPeerLoopRunView(runId), [
      runEvent(1),
      runEvent(2),
      { kind: "run-resync", runId, afterSeq: 2, reason: "first" },
      runEvent(4, true),
      runEvent(6, true),
      synced(6, 6),
    ]);
    expect(caughtUp.needsResync).toBe(false);
    expect(caughtUp.afterSeq).toBe(6);

    const again = applyAll(caughtUp, [
      { kind: "run-resync", runId, afterSeq: 4, reason: "second" },
    ]);
    expect(again.needsResync).toBe(true);
    expect(again.afterSeq).toBe(4);
    expect(peerLoopResumeCursor(again)).toBe(4);
    expect(again.activity.map((entry) => entry.seq)).toEqual([1, 2, 4]);

    // And it stays set until the next replay actually reaches its boundary.
    expect(applyAll(again, [runEvent(6, true)]).needsResync).toBe(true);
    expect(applyAll(again, [runEvent(6, true), synced(6, 6)]).needsResync).toBe(false);
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
