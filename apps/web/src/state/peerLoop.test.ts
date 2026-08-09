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
import { AtomRegistry, Atom } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  advancePeerLoopRun,
  createPeerLoopRunObservationAtoms,
  forgetPeerLoopRun,
  peerLoopRunCursorAtom,
  peerLoopRunStateCount,
  peerLoopRunStore,
  rewindPeerLoopRun,
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

    // A new subscription from the safe cursor keeps the view it was trimmed to.
    // Neither the snapshot nor a partial replay clears the flag: only reaching
    // the boundary does.
    const partway = fold(1, [attached(), runEvent(2)], resynced);
    expect(partway.cursor).toBe(1);
    expect(partway.view.needsResync).toBe(true);
    expect(partway.view.activity.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(partway.view.state).not.toBe(null);

    const caughtUp = fold(
      1,
      [runEvent(5), { kind: "run-synced", runId, afterSeq: 5, eventHighWaterMark: 5 }],
      partway,
    );
    expect(caughtUp.view.needsResync).toBe(false);
    expect(caughtUp.view.afterSeq).toBe(5);
    // Duplicate-free across the reattachment.
    const seqs = caughtUp.view.activity.map((entry) => entry.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([1, 2, 5]);
  });

  it("keeps the view when the new cursor is the one it was trimmed to", () => {
    const before = fold(0, [attached(), runEvent(1), runEvent(2)]);
    const after = advancePeerLoopRun(runId, before, 2, null);
    expect(after.cursor).toBe(2);
    // A reattachment, not a different subscription: the snapshot and the
    // activity at or below the safe cursor are exactly what the client can
    // still vouch for.
    expect(after.view.afterSeq).toBe(2);
    expect(after.view.activity.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(after.view.state).not.toBe(null);
  });

  it("starts from nothing when the cursor is not the view's own position", () => {
    const before = fold(0, [attached(), runEvent(1), runEvent(2)]);
    // Not a reattachment of this view: a different subscription entirely.
    const after = advancePeerLoopRun(runId, before, 7, null);
    expect(after.view.afterSeq).toBe(7);
    expect(after.view.activity).toEqual([]);
    expect(after.view.state).toBe(null);
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

/* ------------------------------------------------ registry-driven behaviour */

interface FakeSubscription {
  readonly opened: number;
  readonly disposed: number;
}

/**
 * A subscription source the test owns.
 *
 * Counting opens and disposals is the only way to prove that restarting
 * observation genuinely tears one stream down and starts one replacement,
 * rather than reusing a cached value or leaving the old listener attached.
 */
function makeFakeEvents() {
  const stats = new Map<string, FakeSubscription>();
  const emitters = new Map<string, (event: PeerLoopSubscriptionEvent) => void>();
  let failNext = false;

  const family = Atom.family((key: string) =>
    Atom.make<AsyncResult.AsyncResult<PeerLoopSubscriptionEvent, unknown>>((get) => {
      const current = stats.get(key) ?? { opened: 0, disposed: 0 };
      stats.set(key, { ...current, opened: current.opened + 1 });
      get.addFinalizer(() => {
        const at = stats.get(key) ?? { opened: 0, disposed: 0 };
        stats.set(key, { ...at, disposed: at.disposed + 1 });
        emitters.delete(key);
      });
      if (failNext) {
        return AsyncResult.failure(
          Cause.fail(
            new PeerLoopCommandRefusedError({
              code: "RUN_NOT_FOUND",
              detail: "Peer Loop has no run with that id.",
              data: null,
            }),
          ),
        );
      }
      emitters.set(key, (event) => get.setSelf(AsyncResult.success(event)));
      return AsyncResult.initial<PeerLoopSubscriptionEvent, unknown>(true);
    }).pipe(Atom.withLabel(`fake-peer-loop-events:${key}`)),
  );

  return {
    atom: (environmentId: string, run: string, afterSeq: number) =>
      family(`${environmentId}|${run}|${afterSeq}`),
    stats: (environmentId: string, run: string, afterSeq: number) =>
      stats.get(`${environmentId}|${run}|${afterSeq}`) ?? { opened: 0, disposed: 0 },
    emit: (
      environmentId: string,
      run: string,
      afterSeq: number,
      event: PeerLoopSubscriptionEvent,
    ) => emitters.get(`${environmentId}|${run}|${afterSeq}`)?.(event),
    setFailing: (value: boolean) => {
      failNext = value;
    },
  } as const;
}

const ENVIRONMENT = "env-1" as never;
/** Typed once, so each harness gets the same shape the real atom has. */
const environmentAtom = Atom.make<typeof ENVIRONMENT | null>(ENVIRONMENT);
const disconnectedAtom = Atom.make<typeof ENVIRONMENT | null>(null);

describe("Peer Loop run observation", () => {
  it("restarts the stream at the same cursor and disposes the old one", async () => {
    const events = makeFakeEvents();
    const atoms = createPeerLoopRunObservationAtoms({
      environmentIdAtom: environmentAtom,
      eventsAtom: (environmentId, run, afterSeq) =>
        events.atom(String(environmentId), run, afterSeq),
    });
    const registry = AtomRegistry.make();
    const unmount = registry.mount(atoms.observation(runId));

    registry.get(atoms.observation(runId));
    expect(events.stats("env-1", runId, 0).opened).toBe(1);

    // The same afterSeq. Setting the cursor atom would change nothing at all;
    // refreshing the subscription is what opens a replacement.
    registry.refresh(events.atom("env-1", runId, 0));
    await vi.waitFor(() => expect(events.stats("env-1", runId, 0).opened).toBe(2));
    expect(events.stats("env-1", runId, 0).disposed).toBe(1);

    unmount();
    await vi.waitFor(() => expect(events.stats("env-1", runId, 0).disposed).toBe(2));
    registry.dispose();
  });

  it("keeps needsResync through the snapshot and a partial replay of a restart", async () => {
    const events = makeFakeEvents();
    const atoms = createPeerLoopRunObservationAtoms({
      environmentIdAtom: environmentAtom,
      eventsAtom: (environmentId, run, afterSeq) =>
        events.atom(String(environmentId), run, afterSeq),
    });
    const registry = AtomRegistry.make();
    registry.mount(atoms.observation(runId));
    registry.get(atoms.observation(runId));

    for (const event of [
      attached(),
      runEvent(1),
      runEvent(2),
      { kind: "run-resync", runId, afterSeq: 1, reason: "could not retain" } as const,
    ]) {
      events.emit("env-1", runId, 0, event);
      registry.get(atoms.observation(runId));
    }
    expect(registry.get(atoms.observation(runId)).view.needsResync).toBe(true);

    // Reattach: rewind to the safe cursor, then restart the stream there.
    const cursor = rewindPeerLoopRun(runId);
    expect(cursor).toBe(1);
    registry.set(peerLoopRunCursorAtom(runId), cursor);
    registry.get(atoms.observation(runId));

    events.emit("env-1", runId, 1, attached());
    registry.get(atoms.observation(runId));
    expect(registry.get(atoms.observation(runId)).view.needsResync).toBe(true);
    expect(registry.get(atoms.observation(runId)).view.state).not.toBe(null);

    events.emit("env-1", runId, 1, runEvent(2));
    registry.get(atoms.observation(runId));
    expect(registry.get(atoms.observation(runId)).view.needsResync).toBe(true);

    events.emit("env-1", runId, 1, runEvent(5));
    registry.get(atoms.observation(runId));
    events.emit("env-1", runId, 1, {
      kind: "run-synced",
      runId,
      afterSeq: 5,
      eventHighWaterMark: 5,
    });
    const settled = registry.get(atoms.observation(runId));
    expect(settled.view.needsResync).toBe(false);

    // Retained activity is duplicate-free across the reattachment.
    const seqs = settled.view.activity.map((entry) => entry.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([1, 2, 5]);

    registry.dispose();
  });

  it("surfaces a subscription failure and is retryable without sending anything", async () => {
    const events = makeFakeEvents();
    events.setFailing(true);
    const atoms = createPeerLoopRunObservationAtoms({
      environmentIdAtom: environmentAtom,
      eventsAtom: (environmentId, run, afterSeq) =>
        events.atom(String(environmentId), run, afterSeq),
    });
    const registry = AtomRegistry.make();
    registry.mount(atoms.observation(runId));

    const failed = registry.get(atoms.observation(runId));
    expect(failed.error?.code).toBe("RUN_NOT_FOUND");
    expect(failed.empty).toBe(true);

    // The retry is a refresh of the same subscription. It is the only thing the
    // page does: no command of any kind is available from this state.
    events.setFailing(false);
    registry.refresh(events.atom("env-1", runId, 0));
    await vi.waitFor(() => expect(events.stats("env-1", runId, 0).opened).toBe(2));

    events.emit("env-1", runId, 0, attached());
    const recovered = registry.get(atoms.observation(runId));
    expect(recovered.error).toBe(null);
    expect(recovered.view.state).not.toBe(null);

    registry.dispose();
  });

  it("says it is not connected rather than pretending the run is empty", () => {
    const events = makeFakeEvents();
    const atoms = createPeerLoopRunObservationAtoms({
      environmentIdAtom: disconnectedAtom,
      eventsAtom: (environmentId, run, afterSeq) =>
        events.atom(String(environmentId), run, afterSeq),
    });
    const registry = AtomRegistry.make();
    const observation = registry.get(atoms.observation(runId));
    expect(observation.error?.title).toContain("Not connected");
    expect(events.stats("", runId, 0).opened).toBe(0);
    registry.dispose();
  });
});
