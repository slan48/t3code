/**
 * How the web app folds one Peer Loop subscription into one run's view.
 *
 * The fold is the part with real behaviour in it — response before backlog, a
 * duplicate dropped, a resync rewinding, a catch-up fact clearing the flag —
 * and none of it needs a connection or a browser to check.
 */
import type {
  PeerLoopEvent,
  PeerLoopRunStateFile,
  PeerLoopSubscriptionEvent,
} from "@t3tools/contracts";
import { PeerLoopCommandRefusedError } from "@t3tools/contracts";
import { peerLoopResumeCursor } from "@t3tools/client-runtime/state/peer-loop-reducer";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  advancePeerLoopRun,
  forgetPeerLoopRun,
  peerLoopRunStateCount,
  peerLoopRunStore,
  type PeerLoopRunSubscriptionState,
} from "./peerLoop";
import { peerLoopFailure } from "./peerLoopCommands";

const runId = "run-1";

const adapters = {
  reviewer: "codex",
  reviewerVersion: null,
  builder: "claude-code",
  builderVersion: null,
} as const;

const runState = (overrides: Partial<PeerLoopRunStateFile> = {}): PeerLoopRunStateFile =>
  ({
    schemaVersion: 1,
    runId,
    projectPath: "/repos/demo",
    state: "builder_working",
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
    haltReason: null,
    stopRequested: false,
    adapters,
    safetyLimit: null,
    lastSequence: 5,
    ...overrides,
  }) as PeerLoopRunStateFile;

const attached = (eventHighWaterMark = 5): PeerLoopSubscriptionEvent => ({
  kind: "run-attached",
  runId,
  snapshot: {
    runId,
    state: runState(),
    control: {
      available: true,
      reason: "live_in_this_bridge",
      liveWriter: null,
      resumable: false,
    },
    eventHighWaterMark,
    replayFromSeq: 0,
    live: true,
  },
});

const runEvent = (seq: number, replay = true): PeerLoopSubscriptionEvent => ({
  kind: "run-event",
  runId,
  replay,
  event: {
    runId,
    seq,
    ts: `2026-08-09T00:00:0${seq % 10}.000Z`,
    type: "notice",
    actor: "system",
    iteration: 1,
    payload: { kind: "notice", message: `event ${seq}` },
  } as PeerLoopEvent,
});

const fold = (
  cursor: number,
  events: readonly PeerLoopSubscriptionEvent[],
  start?: PeerLoopRunSubscriptionState,
): PeerLoopRunSubscriptionState =>
  events.reduce<PeerLoopRunSubscriptionState>(
    (state, event) => advancePeerLoopRun(runId, state, cursor, event),
    start ?? advancePeerLoopRun(runId, undefined, cursor, null),
  );

beforeEach(() => {
  peerLoopRunStore.clear();
});

describe("Peer Loop run subscription fold", () => {
  it("seeds the view from the snapshot the subscription already carried", () => {
    const state = fold(0, [
      {
        kind: "transport",
        transport: { state: "connected", changedAt: "", detail: null, protocolVersion: 1 },
      },
      attached(),
    ]);

    expect(state.view.state?.state).toBe("builder_working");
    expect(state.view.control?.available).toBe(true);
    expect(state.view.eventHighWaterMark).toBe(5);
    // The snapshot is not activity: it moves no cursor and adds no event.
    expect(state.view.afterSeq).toBe(0);
    expect(state.view.activity).toEqual([]);
  });

  it("takes the snapshot before the backlog, in the order the server sent it", () => {
    const state = fold(0, [attached(), runEvent(1), runEvent(2)]);
    expect(state.view.state).not.toBe(null);
    expect(state.view.activity.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(state.view.afterSeq).toBe(2);
  });

  it("drops an event it has already rendered", () => {
    const first = fold(0, [attached(), runEvent(1), runEvent(2)]);
    // Another client attaching makes Peer Loop replay for it; this view has it.
    const after = fold(0, [runEvent(1), runEvent(2)], first);
    expect(after.view.activity.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(after.view.afterSeq).toBe(2);
  });

  it("keeps needsResync set until the catch-up fact arrives", () => {
    const resynced = fold(0, [
      attached(),
      runEvent(1),
      runEvent(2),
      { kind: "run-resync", runId, afterSeq: 1, reason: "this server could not retain the stream" },
    ]);
    expect(resynced.view.needsResync).toBe(true);
    expect(peerLoopResumeCursor(resynced.view)).toBe(1);
    expect(resynced.view.activity.map((entry) => entry.seq)).toEqual([1]);

    // A new subscription from the safe cursor. The replay alone does not clear
    // the flag — only reaching the boundary does.
    const partway = fold(1, [attached(), runEvent(2)], resynced);
    expect(partway.cursor).toBe(1);
    expect(partway.view.needsResync).toBe(false);

    const caughtUp = fold(
      1,
      [
        attached(),
        runEvent(2),
        runEvent(5),
        { kind: "run-synced", runId, afterSeq: 5, eventHighWaterMark: 5 },
      ],
      { cursor: 1, view: { ...resynced.view, afterSeq: 1 } },
    );
    expect(caughtUp.view.needsResync).toBe(false);
    expect(caughtUp.view.afterSeq).toBe(5);
  });

  it("restarts the fold when the cursor changes, which is what a reattach is", () => {
    const before = fold(0, [attached(), runEvent(1), runEvent(2)]);
    const after = advancePeerLoopRun(runId, before, 2, null);
    expect(after.cursor).toBe(2);
    // A new subscription starts from the safe cursor with nothing retained: the
    // replay that follows is what fills it, and keeping the old slice would
    // show the same events twice.
    expect(after.view.afterSeq).toBe(2);
    expect(after.view.activity).toEqual([]);
  });

  it("keeps retained activity bounded however long the run is watched", () => {
    const state = fold(0, [
      attached(),
      ...Array.from({ length: 900 }, (_, index) => runEvent(index + 1)),
    ]);
    expect(state.view.activity.length).toBeLessThanOrEqual(400);
    expect(state.view.afterSeq).toBe(900);
  });

  it("treats a skipped sequence as data rather than inferring a gap", () => {
    const state = fold(0, [attached(), runEvent(1), runEvent(4)]);
    expect(state.view.needsResync).toBe(false);
    expect(state.view.activity.map((entry) => entry.seq)).toEqual([1, 4]);
  });
});

describe("Peer Loop run disposal", () => {
  it("drops a run's view when nothing is watching it", () => {
    peerLoopRunStore.write("a", advancePeerLoopRun("a", undefined, 0, null));
    peerLoopRunStore.write("b", advancePeerLoopRun("b", undefined, 0, null));
    expect(peerLoopRunStateCount()).toBe(2);

    forgetPeerLoopRun("a");
    expect(peerLoopRunStateCount()).toBe(1);
    expect(peerLoopRunStore.read("a")).toBe(undefined);

    forgetPeerLoopRun("b");
    expect(peerLoopRunStateCount()).toBe(0);
  });

  it("is safe to forget a run twice", () => {
    peerLoopRunStore.write("a", advancePeerLoopRun("a", undefined, 0, null));
    forgetPeerLoopRun("a");
    forgetPeerLoopRun("a");
    expect(peerLoopRunStateCount()).toBe(0);
  });
});

describe("Peer Loop command failures", () => {
  it("unwraps a typed refusal so its code survives to the surface", () => {
    const refusal = new PeerLoopCommandRefusedError({
      code: "PROJECT_HAS_UNFINISHED_RUN",
      detail: "This project already has an unfinished run.",
      data: { runId: "run-9" },
    });
    const failure = peerLoopFailure(AsyncResult.failure(Cause.fail(refusal)));
    expect(failure?._tag).toBe("PeerLoopCommandRefusedError");
    if (failure === null || failure._tag !== "PeerLoopCommandRefusedError") {
      throw new Error("unreachable");
    }
    expect(failure.code).toBe("PROJECT_HAS_UNFINISHED_RUN");
    expect(failure.data).toEqual({ runId: "run-9" });
  });

  it("does not dress a connection failure as a Peer Loop refusal", () => {
    expect(peerLoopFailure(AsyncResult.failure(Cause.fail(new Error("socket closed"))))).toBe(null);
  });

  it("has nothing to unwrap from a success", () => {
    expect(peerLoopFailure(AsyncResult.success(1))).toBe(null);
  });
});
