/**
 * The gate an answer goes through, and what happens when it comes back.
 *
 * Two things matter here and neither is a string. First, that two copies of one
 * decision cannot both send: the block is rendered in the timeline and in the
 * Plan sidebar, so a hook-local flag would let a fast second click answer a
 * question that was asked once. Second, that BOTH outcomes re-read the run —
 * `answered` because it is about to move, `refresh-required` because this card
 * is demonstrably already behind, and a stale click must produce the current
 * question rather than an error.
 */
import type { PeerLoopAnswerOwnerDecisionResult } from "@t3tools/contracts";
import { PeerLoopCommandRefusedError, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { NavigatorOwnerDecisionAction } from "~/navigatorExecution";
import {
  createNavigatorDecisionAnswerStore,
  navigatorDecisionAnswerStore,
  navigatorDecisionKey,
} from "./navigatorExecutionCommand";

const ENVIRONMENT = "environment-local";
const THREAD_ID = ThreadId.make("thread-navigator-1");
const RUN_ID = "20260812T062443Z-4eb56b42";
const KEY = navigatorDecisionKey({ environmentId: ENVIRONMENT, runId: RUN_ID });

const ACTION: NavigatorOwnerDecisionAction = {
  runId: RUN_ID,
  threadId: THREAD_ID,
  fingerprint: "0123456789abcdef0123456789abcdef",
  options: [
    { index: 0, label: "Publish it yourself." },
    { index: 1, label: "Keep the commit local only." },
  ],
};

const ANSWERED: PeerLoopAnswerOwnerDecisionResult = {
  outcome: "answered",
  delivery: { runId: RUN_ID, queued: false, accepted: true, queuedOwnerMessages: 0 },
  decisionFingerprint: ACTION.fingerprint,
};

const STALE: PeerLoopAnswerOwnerDecisionResult = {
  outcome: "refresh-required",
  reason: "decision-changed",
  currentDecisionFingerprint: "fedcba9876543210fedcba9876543210",
};

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((settle) => {
    resolve = settle;
  });
  return { promise, resolve } as const;
};

describe("the per-run answer gate", () => {
  it("sends one request for two clicks in the same tick", () => {
    const store = createNavigatorDecisionAnswerStore();
    const gate = deferred<AsyncResult.AsyncResult<PeerLoopAnswerOwnerDecisionResult, unknown>>();
    const run = vi.fn(() => gate.promise);

    // Two options of one question are still one answer. The second click is
    // refused before any RPC is created.
    void store.answer(KEY, run);
    void store.answer(KEY, run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(store.isBusy(KEY)).toBe(true);
    expect(store.read(KEY).pending).toBe(true);
    gate.resolve(AsyncResult.success(ANSWERED));
  });

  it("refuses the sidebar's click while the timeline's is outstanding", async () => {
    // Separate components, separate callbacks, one key: they are the same
    // control, and the refused caller learns it sent nothing.
    const store = createNavigatorDecisionAnswerStore();
    const gate = deferred<AsyncResult.AsyncResult<PeerLoopAnswerOwnerDecisionResult, unknown>>();
    const fromTimeline = vi.fn(() => gate.promise);
    const fromSidebar = vi.fn(() => gate.promise);

    const first = store.answer(KEY, fromTimeline);
    const second = store.answer(KEY, fromSidebar);

    expect(fromTimeline).toHaveBeenCalledTimes(1);
    expect(fromSidebar).not.toHaveBeenCalled();
    gate.resolve(AsyncResult.success(ANSWERED));
    expect(await first).toEqual(ANSWERED);
    expect(await second).toBeNull();
  });

  it("keeps two runs independent", () => {
    const store = createNavigatorDecisionAnswerStore();
    const other = navigatorDecisionKey({ environmentId: ENVIRONMENT, runId: "run-other" });
    const gate = deferred<AsyncResult.AsyncResult<PeerLoopAnswerOwnerDecisionResult, unknown>>();
    void store.answer(KEY, () => gate.promise);
    void store.answer(other, () => gate.promise);
    expect(store.isBusy(KEY)).toBe(true);
    expect(store.isBusy(other)).toBe(true);
    gate.resolve(AsyncResult.success(ANSWERED));
  });

  it("keeps the same run on two machines apart", () => {
    // Peer Loop run ids are per-machine. A pending answer on one must not
    // disable the control on the other.
    const cloud = navigatorDecisionKey({ environmentId: "environment-cloud", runId: RUN_ID });
    expect(cloud).not.toBe(KEY);
  });

  it("releases the gate and reports a bounded failure that can be retried", async () => {
    const store = createNavigatorDecisionAnswerStore();
    const refused = await store.answer(KEY, async () =>
      AsyncResult.failure(
        Cause.fail(
          new PeerLoopCommandRefusedError({
            code: "INVALID_RUN_STATE",
            detail: "the run stopped accepting owner messages",
            data: null,
          }),
        ),
      ),
    );
    expect(refused).toBeNull();
    const state = store.read(KEY);
    expect(state.pending).toBe(false);
    expect(state.failure?.code).toBe("INVALID_RUN_STATE");
    // Retryable: the gate is open and the next click sends.
    expect(store.isBusy(KEY)).toBe(false);
    const retried = vi.fn(async () => AsyncResult.success(ANSWERED));
    expect(await store.answer(KEY, retried)).toEqual(ANSWERED);
    expect(retried).toHaveBeenCalledTimes(1);
  });

  it("settles a defect rather than leaving every copy disabled", async () => {
    const store = createNavigatorDecisionAnswerStore();
    await store.answer(KEY, async () => {
      throw new Error("socket exploded");
    });
    const state = store.read(KEY);
    expect(state.pending).toBe(false);
    expect(state.failure?.detail).not.toContain("socket exploded");
    expect(store.isBusy(KEY)).toBe(false);
  });

  it("keeps nothing once an answer lands or a failure is dismissed", async () => {
    const store = createNavigatorDecisionAnswerStore();
    await store.answer(KEY, async () => AsyncResult.success(ANSWERED));
    // A delivered answer leaves no entry: the card's next state comes from the
    // re-read, not from anything remembered here.
    expect(store.size()).toBe(0);

    await store.answer(KEY, async () => AsyncResult.failure(Cause.fail(new Error("nope"))));
    expect(store.size()).toBe(1);
    store.dismissFailure(KEY);
    expect(store.size()).toBe(0);
  });

  it("does not grow as runs come and go", async () => {
    const store = createNavigatorDecisionAnswerStore();
    for (let index = 0; index < 50; index += 1) {
      const key = navigatorDecisionKey({ environmentId: ENVIRONMENT, runId: `run-${index}` });
      await store.answer(key, async () => AsyncResult.success(ANSWERED));
    }
    expect(store.size()).toBe(0);
  });

  it("notifies every subscriber on each settled transition", async () => {
    const store = createNavigatorDecisionAnswerStore();
    const seen: Array<number> = [];
    const unsubscribe = store.subscribe(() => seen.push(store.version()));
    await store.answer(KEY, async () => AsyncResult.success(ANSWERED));
    unsubscribe();
    // Pending, then settled: both mounted copies re-render for both.
    expect(seen).toHaveLength(2);
  });
});

/* ------------------------------------------------- what the outcome does */

/**
 * The hook's own body, without React.
 *
 * `useNavigatorOwnerDecisionAnswer` is four lines of callback around the store
 * plus the two refreshes; this drives exactly that sequence so the rule — both
 * outcomes re-read, a refused click re-reads nothing — is asserted rather than
 * assumed.
 */
const answerAndRefresh = async (input: {
  readonly result: () => Promise<
    AsyncResult.AsyncResult<PeerLoopAnswerOwnerDecisionResult, unknown>
  >;
  readonly refreshRuns: () => void;
  readonly refreshSnapshot: () => void;
}) => {
  const result = await navigatorDecisionAnswerStore.answer(KEY, input.result);
  if (result === null) return;
  input.refreshRuns();
  input.refreshSnapshot();
};

describe("what happens when the answer comes back", () => {
  beforeEach(() => {
    navigatorDecisionAnswerStore.reset();
  });

  it("re-reads the run list and the attached snapshot once answered", async () => {
    const refreshRuns = vi.fn();
    const refreshSnapshot = vi.fn();
    await answerAndRefresh({
      result: async () => AsyncResult.success(ANSWERED),
      refreshRuns,
      refreshSnapshot,
    });
    // Without waiting for a poll or a provider turn: the run is moving now.
    expect(refreshRuns).toHaveBeenCalledTimes(1);
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
  });

  it("re-reads both for a stale answer, and shows no error", async () => {
    // THE CASE A GENERIC ERROR WOULD RUIN. The click was aimed at a question
    // the run has left; the honest response is the current one, which needs a
    // snapshot read — the run-list revision may not have moved at all.
    const refreshRuns = vi.fn();
    const refreshSnapshot = vi.fn();
    await answerAndRefresh({
      result: async () => AsyncResult.success(STALE),
      refreshRuns,
      refreshSnapshot,
    });
    expect(refreshRuns).toHaveBeenCalledTimes(1);
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
    expect(navigatorDecisionAnswerStore.read(KEY).failure).toBeNull();
    expect(navigatorDecisionAnswerStore.read(KEY).pending).toBe(false);
  });

  it("re-reads both for every refresh reason, including a queued response", async () => {
    for (const reason of [
      "not-owner-required",
      "owner-response-queued",
      "decision-changed",
    ] as const) {
      navigatorDecisionAnswerStore.reset();
      const refreshRuns = vi.fn();
      const refreshSnapshot = vi.fn();
      await answerAndRefresh({
        result: async () =>
          AsyncResult.success({
            outcome: "refresh-required",
            reason,
            currentDecisionFingerprint: null,
          }),
        refreshRuns,
        refreshSnapshot,
      });
      expect(refreshSnapshot, reason).toHaveBeenCalledTimes(1);
      expect(navigatorDecisionAnswerStore.read(KEY).failure, reason).toBeNull();
    }
  });

  it("re-reads nothing for a click the gate refused", async () => {
    // The first click's own completion does the re-reading. A refused second
    // click must not issue a second answer or a second pair of reads.
    const gate = deferred<AsyncResult.AsyncResult<PeerLoopAnswerOwnerDecisionResult, unknown>>();
    const refreshRuns = vi.fn();
    const refreshSnapshot = vi.fn();
    const first = answerAndRefresh({
      result: () => gate.promise,
      refreshRuns,
      refreshSnapshot,
    });
    await answerAndRefresh({
      result: async () => AsyncResult.success(ANSWERED),
      refreshRuns,
      refreshSnapshot,
    });
    expect(refreshRuns).not.toHaveBeenCalled();

    gate.resolve(AsyncResult.success(ANSWERED));
    await first;
    expect(refreshRuns).toHaveBeenCalledTimes(1);
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
  });

  it("re-reads nothing when the answer failed", async () => {
    // A failure is inline and retryable; nothing about the run changed, so
    // nothing is re-read behind the owner's back.
    const refreshRuns = vi.fn();
    const refreshSnapshot = vi.fn();
    await answerAndRefresh({
      result: async () => AsyncResult.failure(Cause.fail(new Error("socket closed"))),
      refreshRuns,
      refreshSnapshot,
    });
    expect(refreshRuns).not.toHaveBeenCalled();
    expect(refreshSnapshot).not.toHaveBeenCalled();
    expect(navigatorDecisionAnswerStore.read(KEY).failure).not.toBeNull();
    navigatorDecisionAnswerStore.reset();
  });
});
