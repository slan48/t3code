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
  disposePeerLoopRun,
  forgetPeerLoopRun,
  peerLoopRunKey,
  peerLoopRunStateCount,
  peerLoopRunStore,
  restartPeerLoopObservation,
  type PeerLoopRunSubscriptionState,
} from "./peerLoop";
import { peerLoopFailure } from "./peerLoopCommands";
import { NO_PROJECTS_ATOM, peerLoopProjectsAtomFor } from "../routes/peer-loop.index";
import { describeControls } from "~/peerLoopPresentation";

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

const attached = (eventHighWaterMark = 5, id = runId): PeerLoopSubscriptionEvent => ({
  kind: "run-attached",
  runId: id,
  snapshot: {
    runId: id,
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

const runEvent = (seq: number, replay = true, id = runId): PeerLoopSubscriptionEvent => ({
  kind: "run-event",
  runId: id,
  replay,
  event: {
    runId: id,
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

const ENV_A = "env-a" as never;
const ENV_B = "env-b" as never;
const keyA = { environmentId: ENV_A, runId } as const;
const keyB = { environmentId: ENV_B, runId } as const;

describe("Peer Loop run disposal", () => {
  it("drops the exact environment/run entry, not every run with that id", () => {
    peerLoopRunStore.write(keyA, advancePeerLoopRun(runId, undefined, 0, null));
    peerLoopRunStore.write(keyB, advancePeerLoopRun(runId, undefined, 0, null));
    expect(peerLoopRunStateCount()).toBe(2);

    forgetPeerLoopRun(keyA);
    expect(peerLoopRunStateCount()).toBe(1);
    expect(peerLoopRunStore.read(keyA)).toBe(undefined);
    expect(peerLoopRunStore.read(keyB)).not.toBe(undefined);

    forgetPeerLoopRun(keyB);
    expect(peerLoopRunStateCount()).toBe(0);
  });

  it("is safe to forget a run twice", () => {
    peerLoopRunStore.write(keyA, advancePeerLoopRun(runId, undefined, 0, null));
    forgetPeerLoopRun(keyA);
    forgetPeerLoopRun(keyA);
    expect(peerLoopRunStateCount()).toBe(0);
  });

  it("keys unambiguously, so no environment/run pair can collide with another", () => {
    expect(peerLoopRunKey({ environmentId: "a\u0000b" as never, runId: "c" })).not.toBe(
      peerLoopRunKey({ environmentId: "a" as never, runId: "b\u0000c" }),
    );
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
 * Counting opens and disposals per (environment, run, cursor) is the only way
 * to prove that a restart opens exactly one replacement, at the right cursor,
 * and never reopens the one it left.
 */
function makeFakeEvents() {
  const stats = new Map<string, FakeSubscription>();
  const emitters = new Map<string, (event: PeerLoopSubscriptionEvent) => void>();
  let failing = false;

  const family = Atom.family((key: string) =>
    Atom.make<AsyncResult.AsyncResult<PeerLoopSubscriptionEvent, unknown>>((get) => {
      const current = stats.get(key) ?? { opened: 0, disposed: 0 };
      stats.set(key, { ...current, opened: current.opened + 1 });
      get.addFinalizer(() => {
        const at = stats.get(key) ?? { opened: 0, disposed: 0 };
        stats.set(key, { ...at, disposed: at.disposed + 1 });
        emitters.delete(key);
      });
      if (failing) {
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
    }).pipe(
      // Mirrors the production `idleTtlMs: 0` on `peerLoopEnvironment.events`.
      // A fake that lingered would prove the opposite of what these assert; the
      // production atom's own lifetime is checked in the client-runtime suite.
      Atom.setIdleTTL(0),
      Atom.withLabel(`fake-peer-loop-events:${key}`),
    ),
  );

  const id = (environmentId: unknown, run: string, afterSeq: number) =>
    `${String(environmentId)}|${run}|${afterSeq}`;

  /** Streams opened and not yet finalized. The real resource, counted. */
  const active = (): number =>
    [...stats.values()].reduce((total, entry) => total + entry.opened - entry.disposed, 0);

  return {
    atom: (environmentId: unknown, run: string, afterSeq: number) =>
      family(id(environmentId, run, afterSeq)),
    stats: (environmentId: unknown, run: string, afterSeq: number) =>
      stats.get(id(environmentId, run, afterSeq)) ?? { opened: 0, disposed: 0 },
    emit: (
      environmentId: unknown,
      run: string,
      afterSeq: number,
      event: PeerLoopSubscriptionEvent,
    ) => emitters.get(id(environmentId, run, afterSeq))?.(event),
    active,
    setFailing: (value: boolean) => {
      failing = value;
    },
  } as const;
}

let harnessCount = 0;

/**
 * One harness per test, with its own run id.
 *
 * The cursor atoms are a module-level family, so two tests sharing a run id
 * would share an atom identity across registries and one would see the other's
 * cursor. A fresh id per test keeps each one honest.
 */
const harness = (environmentIdAtom: Atom.Atom<typeof ENV_A | null>) => {
  harnessCount += 1;
  const run = `${runId}-${harnessCount}`;
  const events = makeFakeEvents();
  const atoms = createPeerLoopRunObservationAtoms({
    environmentIdAtom,
    eventsAtom: (environmentId, name, afterSeq) => events.atom(environmentId, name, afterSeq),
  });
  const registry = AtomRegistry.make();
  return {
    events,
    atoms,
    registry,
    run,
    keyA: { environmentId: ENV_A, runId: run } as const,
    keyB: { environmentId: ENV_B, runId: run } as const,
    read: () => registry.get(atoms.observation(run)),
  } as const;
};

const envAtom = () => Atom.make<typeof ENV_A | null>(ENV_A);

describe("Peer Loop observation restart", () => {
  it("switches to the new cursor once, and never reopens the old one", async () => {
    const { events, atoms, registry, run, keyA, read } = harness(envAtom());
    registry.mount(atoms.observation(run));
    read();

    for (const event of [
      attached(5, run),
      runEvent(1, true, run),
      runEvent(5, true, run),
      { kind: "run-resync", runId: run, afterSeq: 5, reason: "could not retain" } as const,
    ]) {
      events.emit(ENV_A, run, 0, event);
      read();
    }

    const before = events.stats(ENV_A, run, 0).opened;
    const outcome = restartPeerLoopObservation(registry, atoms, keyA);
    expect(outcome).toEqual({ cursor: 5, switched: true });
    read();

    await vi.waitFor(() => expect(events.stats(ENV_A, run, 5).opened).toBe(1));
    // The old subscription is disposed, and the pointless second attach at the
    // cursor we just left is never issued.
    await vi.waitFor(() => expect(events.stats(ENV_A, run, 0).disposed).toBe(1));
    expect(events.stats(ENV_A, run, 0).opened).toBe(before);

    registry.dispose();
  });

  it("refreshes the current subscription exactly once when the cursor is unchanged", async () => {
    const { events, atoms, registry, run, keyA, read } = harness(envAtom());
    registry.mount(atoms.observation(run));
    read();

    // Only the snapshot has arrived, so the safe cursor is still 0 — exactly
    // the case where setting the cursor would restart nothing at all.
    events.emit(ENV_A, run, 0, attached(5, run));
    read();

    const outcome = restartPeerLoopObservation(registry, atoms, keyA);
    expect(outcome.switched).toBe(false);
    expect(outcome.cursor).toBe(0);

    await vi.waitFor(() => expect(events.stats(ENV_A, run, 0).opened).toBe(2));
    expect(events.stats(ENV_A, run, 0).disposed).toBe(1);
    registry.dispose();
  });

  it("restarts again at the moved cursor without leaving two subscriptions", async () => {
    const { events, atoms, registry, run, keyA, read } = harness(envAtom());
    registry.mount(atoms.observation(run));
    read();

    for (const event of [
      attached(5, run),
      runEvent(5, true, run),
      { kind: "run-resync", runId: run, afterSeq: 5, reason: "x" } as const,
    ]) {
      events.emit(ENV_A, run, 0, event);
      read();
    }
    restartPeerLoopObservation(registry, atoms, keyA);
    read();
    await vi.waitFor(() => expect(events.stats(ENV_A, run, 5).opened).toBe(1));

    // Reconciling repeatedly after commands stays on cursor 5 and refreshes it,
    // rather than drifting back to an older cursor or stacking subscriptions.
    for (let index = 0; index < 3; index += 1) {
      const outcome = restartPeerLoopObservation(registry, atoms, keyA);
      expect(outcome).toEqual({ cursor: 5, switched: false });
      read();
    }
    await vi.waitFor(() => expect(events.stats(ENV_A, run, 5).opened).toBe(4));
    // The cursor it left is opened once and never again.
    expect(events.stats(ENV_A, run, 0).opened).toBe(1);
    await vi.waitFor(() => expect(events.stats(ENV_A, run, 0).disposed).toBe(1));

    registry.dispose();
  });

  it("keeps needsResync until the replacement emits a valid run-synced", async () => {
    const { events, atoms, registry, run, keyA, read } = harness(envAtom());
    registry.mount(atoms.observation(run));
    read();

    for (const event of [
      attached(5, run),
      runEvent(1, true, run),
      runEvent(2, true, run),
      { kind: "run-resync", runId: run, afterSeq: 1, reason: "could not retain" } as const,
    ]) {
      events.emit(ENV_A, run, 0, event);
      read();
    }
    expect(read().view.needsResync).toBe(true);

    restartPeerLoopObservation(registry, atoms, keyA);
    read();

    for (const event of [attached(5, run), runEvent(2, true, run)]) {
      events.emit(ENV_A, run, 1, event);
      read();
      expect(read().view.needsResync).toBe(true);
    }

    events.emit(ENV_A, run, 1, runEvent(5, true, run));
    read();
    events.emit(ENV_A, run, 1, {
      kind: "run-synced",
      runId: run,
      afterSeq: 5,
      eventHighWaterMark: 5,
    });
    const settled = read();
    expect(settled.view.needsResync).toBe(false);
    const seqs = settled.view.activity.map((entry) => entry.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([1, 2, 5]);

    registry.dispose();
  });

  it("surfaces a subscription failure and is retryable without sending anything", async () => {
    const { events, atoms, registry, run, keyA, read } = harness(envAtom());
    events.setFailing(true);
    registry.mount(atoms.observation(run));

    const failed = read();
    expect(failed.error?.code).toBe("RUN_NOT_FOUND");
    expect(failed.empty).toBe(true);
    expect(failed.observable).toBe(true);

    events.setFailing(false);
    // The retry is exactly the restart the page offers; nothing else happens.
    expect(restartPeerLoopObservation(registry, atoms, keyA).switched).toBe(false);
    await vi.waitFor(() => expect(events.stats(ENV_A, run, 0).opened).toBe(2));

    events.emit(ENV_A, run, 0, attached(5, run));
    const recovered = read();
    expect(recovered.error).toBe(null);
    expect(recovered.view.state).not.toBe(null);

    registry.dispose();
  });

  it("subscribes to nothing and is not observable without a primary environment", () => {
    const { events, registry, run, read } = harness(Atom.make<typeof ENV_A | null>(null));
    const observation = read();
    expect(observation.error?.title).toContain("Not connected");
    expect(observation.observable).toBe(false);
    // No invented environment id was ever used to build a subscription.
    expect(events.stats("", run, 0).opened).toBe(0);
    expect(events.stats("null", run, 0).opened).toBe(0);
    expect(events.stats("undefined", run, 0).opened).toBe(0);
    registry.dispose();
  });
});

describe("Peer Loop environment scoping", () => {
  it("starts a different environment's run from scratch, with none of the first's state", async () => {
    const environmentAtom = Atom.writable(
      () => ENV_A as typeof ENV_A | null,
      (ctx, value: typeof ENV_A | null) => ctx.setSelf(value),
    );
    const { events, atoms, registry, run, keyA, keyB, read } = harness(environmentAtom);
    registry.mount(atoms.observation(run));
    read();

    // Environment A reaches cursor 100 with live control.
    events.emit(ENV_A, run, 0, attached(5, run));
    read();
    events.emit(ENV_A, run, 0, runEvent(100, true, run));
    const onA = read();
    expect(onA.view.afterSeq).toBe(100);
    expect(onA.view.control?.available).toBe(true);

    // The primary environment changes. Same run id, different machine.
    registry.set(environmentAtom, ENV_B);
    const onB = read();

    expect(onB.cursor).toBe(0);
    expect(onB.view.afterSeq).toBe(0);
    expect(onB.view.activity).toEqual([]);
    // No state and no control from A: a command derived from A's snapshot is
    // exactly what must not be possible here.
    expect(onB.view.state).toBe(null);
    expect(onB.view.control).toBe(null);
    expect(describeControls(onB.view)).toMatchObject({
      canSendOwnerMessage: false,
      canPause: false,
      canResume: false,
      canRecover: false,
    });

    // A's retained view is untouched and still its own; B has nothing yet.
    expect(peerLoopRunStore.read(keyA)?.view.afterSeq).toBe(100);
    expect(peerLoopRunStore.read(keyB)).toBe(undefined);
    await vi.waitFor(() => expect(events.stats(ENV_B, run, 0).opened).toBe(1));
    await vi.waitFor(() => expect(events.stats(ENV_A, run, 0).disposed).toBe(1));
    // And A is never reopened by B's observation.
    expect(events.stats(ENV_A, run, 0).opened).toBe(1);

    registry.dispose();
  });
});

describe("Peer Loop observation disposal", () => {
  /**
   * The route's own lifecycle, without React.
   *
   * `observe` is the effect body and the returned function is its cleanup, so a
   * switch is cleanup-then-observe exactly as an effect keyed by the pair runs
   * it. That is what makes "A is disposed when B becomes the observed one"
   * something this can assert rather than assume.
   */
  const mountRoute = (
    harnessed: ReturnType<typeof harness>,
    environmentAtom: Atom.Writable<typeof ENV_A | null, typeof ENV_A | null>,
  ) => {
    const { atoms, registry, run } = harnessed;
    let dispose: (() => void) | null = null;
    const observe = () => {
      const environmentId = registry.get(environmentAtom);
      if (environmentId === null) return;
      const key = { environmentId, runId: run } as const;
      dispose = () => disposePeerLoopRun(registry, atoms, key);
    };
    return {
      observe,
      leave: () => {
        dispose?.();
        dispose = null;
      },
      // React's order: the state changes, then the previous effect's cleanup
      // runs, then the new effect body does.
      switchTo: (next: typeof ENV_A | null) => {
        registry.set(environmentAtom, next);
        dispose?.();
        dispose = null;
        observe();
      },
    } as const;
  };

  const writableEnvironment = () =>
    Atom.writable(
      () => ENV_A as typeof ENV_A | null,
      (ctx, value: typeof ENV_A | null) => ctx.setSelf(value),
    );

  it("disposes A when B becomes the observed pair on one mounted route", async () => {
    const environmentAtom = writableEnvironment();
    const harnessed = harness(environmentAtom);
    const { events, atoms, registry, run, keyA, keyB, read } = harnessed;
    const route = mountRoute(harnessed, environmentAtom);

    registry.mount(atoms.observation(run));
    route.observe();
    read();
    events.emit(ENV_A, run, 0, attached(5, run));
    read();
    events.emit(ENV_A, run, 0, runEvent(100, true, run));
    expect(read().view.afterSeq).toBe(100);
    expect(read().view.control?.available).toBe(true);

    route.switchTo(ENV_B);
    const onB = read();

    // A's stream is gone, A's view is gone, and A's cursor is back to 0 — so a
    // later visit cannot resume from a position whose events were discarded.
    await vi.waitFor(() => expect(events.stats(ENV_A, run, 0).disposed).toBe(1));
    // Promptly, and without disposing the registry to get there.
    expect(events.active()).toBe(1);
    expect(peerLoopRunStore.read(keyA)).toBe(undefined);
    expect(registry.get(atoms.cursor(keyA))).toBe(0);

    // Only B is retained, opened at 0, with nothing of A's on it.
    expect(onB.cursor).toBe(0);
    expect(onB.view.state).toBe(null);
    expect(onB.view.control).toBe(null);
    expect(onB.view.activity).toEqual([]);
    expect(describeControls(onB.view)).toMatchObject({
      canSendOwnerMessage: false,
      canPause: false,
      canResume: false,
      canRecover: false,
    });
    // Nothing is retained for B until it actually produces something, and when
    // it does it is B's own.
    expect(peerLoopRunStateCount()).toBe(0);
    await vi.waitFor(() => expect(events.stats(ENV_B, run, 0).opened).toBe(1));
    events.emit(ENV_B, run, 0, attached(5, run));
    read();
    expect(peerLoopRunStore.read(keyB)?.view.afterSeq).toBe(0);
    expect(peerLoopRunStore.read(keyA)).toBe(undefined);
    expect(peerLoopRunStateCount()).toBe(1);
    expect(events.stats(ENV_A, run, 0).opened).toBe(1);

    registry.dispose();
  });

  it("removes B and resets its cursor on unmount, reopening nothing", async () => {
    const environmentAtom = writableEnvironment();
    const harnessed = harness(environmentAtom);
    const { events, atoms, registry, run, keyB } = harnessed;
    const route = mountRoute(harnessed, environmentAtom);

    const unmount = registry.mount(atoms.observation(run));
    route.observe();
    route.switchTo(ENV_B);
    registry.get(atoms.observation(run));
    events.emit(ENV_B, run, 0, attached(5, run));
    events.emit(ENV_B, run, 0, runEvent(7, true, run));
    expect(registry.get(atoms.observation(run)).view.afterSeq).toBe(7);

    route.leave();
    unmount();

    expect(peerLoopRunStore.read(keyB)).toBe(undefined);
    expect(peerLoopRunStateCount()).toBe(0);
    expect(registry.get(atoms.cursor(keyB))).toBe(0);
    // Disposal reopens nothing: leaving is when the stream stops. And it stops
    // now, not in five minutes — asserted before the registry is torn down, so
    // this cannot pass on registry-wide cleanup.
    expect(events.stats(ENV_B, run, 0).opened).toBe(1);
    await vi.waitFor(() => expect(events.stats(ENV_B, run, 0).disposed).toBe(1));

    registry.dispose();
  });

  it("reopens a disposed pair at afterSeq 0, with none of its old state", async () => {
    const environmentAtom = writableEnvironment();
    const harnessed = harness(environmentAtom);
    const { events, atoms, registry, run, keyA, read } = harnessed;
    const route = mountRoute(harnessed, environmentAtom);

    const unmount = registry.mount(atoms.observation(run));
    route.observe();
    read();
    events.emit(ENV_A, run, 0, attached(5, run));
    read();
    events.emit(ENV_A, run, 0, runEvent(100, true, run));
    expect(read().view.afterSeq).toBe(100);

    route.leave();
    unmount();
    expect(peerLoopRunStore.read(keyA)).toBe(undefined);
    // The stream goes now, not on a five-minute timer and not with the
    // registry: nothing is left holding a `run.attach` for a page that closed.
    await vi.waitFor(() => expect(events.active()).toBe(0));

    // A genuinely fresh visit. Without the cursor reset this would open at 100
    // and silently omit the hundred events the client had just thrown away.
    const remount = registry.mount(atoms.observation(run));
    route.observe();
    // A second, genuinely new stream: opened twice in total, both times at 0,
    // never at the cursor that was discarded.
    expect(registry.get(atoms.cursor(keyA))).toBe(0);
    const reopened = read();
    expect(reopened.cursor).toBe(0);
    expect(events.stats(ENV_A, run, 0).opened).toBe(2);
    expect(events.stats(ENV_A, run, 100).opened).toBe(0);

    // And nothing of the old stream is cached: no snapshot, no event, no
    // control, so nothing a control could be derived from.
    expect(reopened.view.state).toBe(null);
    expect(reopened.view.control).toBe(null);
    expect(reopened.view.activity).toEqual([]);
    expect(reopened.view.afterSeq).toBe(0);
    expect(reopened.empty).toBe(true);
    expect(describeControls(reopened.view)).toMatchObject({
      canSendOwnerMessage: false,
      canPause: false,
      canResume: false,
      canRecover: false,
    });

    remount();
    registry.dispose();
  });

  it("still restarts from a nonzero safe cursor while the pair is retained", async () => {
    const environmentAtom = writableEnvironment();
    const harnessed = harness(environmentAtom);
    const { events, atoms, registry, run, keyA, read } = harnessed;
    const route = mountRoute(harnessed, environmentAtom);

    registry.mount(atoms.observation(run));
    route.observe();
    read();
    for (const event of [
      attached(5, run),
      runEvent(1, true, run),
      runEvent(2, true, run),
      { kind: "run-resync", runId: run, afterSeq: 1, reason: "could not retain" } as const,
    ]) {
      events.emit(ENV_A, run, 0, event);
      read();
    }
    expect(read().view.needsResync).toBe(true);

    // Disposal is not involved: this is the ordinary in-route reattachment.
    expect(restartPeerLoopObservation(registry, atoms, keyA)).toEqual({
      cursor: 1,
      switched: true,
    });
    read();
    await vi.waitFor(() => expect(events.stats(ENV_A, run, 1).opened).toBe(1));

    events.emit(ENV_A, run, 1, attached(5, run));
    read();
    expect(read().view.needsResync).toBe(true);
    expect(read().view.activity.map((entry) => entry.seq)).toEqual([1]);

    events.emit(ENV_A, run, 1, runEvent(5, true, run));
    read();
    events.emit(ENV_A, run, 1, {
      kind: "run-synced",
      runId: run,
      afterSeq: 5,
      eventHighWaterMark: 5,
    });
    expect(read().view.needsResync).toBe(false);

    registry.dispose();
  });

  it("leaves nothing retained after repeated mount, switch and unmount cycles", async () => {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const environmentAtom = writableEnvironment();
      const harnessed = harness(environmentAtom);
      const { events, atoms, registry, run } = harnessed;
      const route = mountRoute(harnessed, environmentAtom);

      const unmount = registry.mount(atoms.observation(run));
      route.observe();
      registry.get(atoms.observation(run));
      events.emit(ENV_A, run, 0, attached(5, run));
      registry.get(atoms.observation(run));

      route.switchTo(ENV_B);
      registry.get(atoms.observation(run));
      route.leave();
      unmount();

      expect(peerLoopRunStateCount()).toBe(0);
      // Both streams are gone before the registry is touched: A the moment B
      // became the observed pair, B the moment the route left.
      await vi.waitFor(() => expect(events.stats(ENV_A, run, 0).disposed).toBe(1));
      await vi.waitFor(() => expect(events.stats(ENV_B, run, 0).disposed).toBe(1));
      expect(events.active()).toBe(0);
      registry.dispose();
    }
  });
});

describe("Peer Loop index while disconnected", () => {
  it("reads projects from a local empty atom, never from an invented environment", () => {
    const registry = AtomRegistry.make();
    // The index selects this when there is no primary environment. It is a
    // plain local value: no environment id, and so no environment RPC — asking
    // for `""` would query a machine that does not exist.
    expect(registry.get(NO_PROJECTS_ATOM)).toEqual([]);
    registry.dispose();
  });

  it("selects the local empty atom rather than a project query", () => {
    // Identity, not shape: the point is that no environment-scoped project
    // atom is constructed at all while disconnected.
    expect(peerLoopProjectsAtomFor(null)).toBe(NO_PROJECTS_ATOM);
    expect(peerLoopProjectsAtomFor(ENV_A)).not.toBe(NO_PROJECTS_ATOM);
  });
});
