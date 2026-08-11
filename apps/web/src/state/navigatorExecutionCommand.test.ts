/**
 * The Execute gate: one intent, one run.
 *
 * The gate is deliberately free of React so this can drive it directly. What
 * matters here is that a proposal cannot be executed twice — not by a double
 * press, not by the two places the action is rendered — and that no failure is
 * ever retried, because Peer Loop may have started a run after T3 Code stopped
 * waiting.
 */
import type {
  OrchestrationPeerLoopExecution,
  PeerLoopExecuteProposalResult,
} from "@t3tools/contracts";
import {
  PeerLoopCommandRefusedError,
  PeerLoopExecutionCoordinationError,
  PeerLoopTimeoutError,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createNavigatorExecutionStore,
  describeExecutionResultFailure,
  navigatorExecutionKey,
} from "./navigatorExecutionCommand";

const THREAD_ID = ThreadId.make("thread-navigator-1");
const PLAN_ID = "plan-1";
const KEY = navigatorExecutionKey({ threadId: THREAD_ID, proposedPlanId: PLAN_ID });

const EXECUTION: OrchestrationPeerLoopExecution = {
  runId: "run-77",
  proposedPlanId: PLAN_ID as OrchestrationPeerLoopExecution["proposedPlanId"],
  createdAt: "2026-03-01T10:00:00.000Z",
};

const RESULT = {
  run: { runId: "run-77", awaitingOwnerObjective: false },
  execution: EXECUTION,
} as unknown as PeerLoopExecuteProposalResult;

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((settle) => {
    resolve = settle;
  });
  return { promise, resolve } as const;
};

const failWith = (
  error: unknown,
): AsyncResult.AsyncResult<PeerLoopExecuteProposalResult, unknown> =>
  AsyncResult.failure(Cause.fail(error));

describe("the per-proposal gate", () => {
  it("sends one request for two synchronous presses of the same button", () => {
    const store = createNavigatorExecutionStore();
    const gate = deferred<AsyncResult.AsyncResult<PeerLoopExecuteProposalResult, unknown>>();
    const run = vi.fn(() => gate.promise);

    // Both in the same tick, which is exactly the case a `setState` flag misses.
    void store.execute(KEY, { run });
    void store.execute(KEY, { run });

    expect(run).toHaveBeenCalledTimes(1);
    expect(store.isBusy(KEY)).toBe(true);
    gate.resolve(AsyncResult.success(RESULT));
  });

  it("sends one request when both rendered locations press at once", async () => {
    // The timeline card and the Plan sidebar are separate components with
    // separate `run` closures. They are the same control because they resolve
    // to the same key.
    const store = createNavigatorExecutionStore();
    const gate = deferred<AsyncResult.AsyncResult<PeerLoopExecuteProposalResult, unknown>>();
    const fromTimeline = vi.fn(() => gate.promise);
    const fromSidebar = vi.fn(() => gate.promise);

    const timelineKey = navigatorExecutionKey({ threadId: THREAD_ID, proposedPlanId: PLAN_ID });
    const sidebarKey = navigatorExecutionKey({ threadId: THREAD_ID, proposedPlanId: PLAN_ID });
    expect(sidebarKey).toBe(timelineKey);

    const first = store.execute(timelineKey, { run: fromTimeline });
    const second = store.execute(sidebarKey, { run: fromSidebar });

    expect(fromTimeline).toHaveBeenCalledTimes(1);
    expect(fromSidebar).not.toHaveBeenCalled();
    gate.resolve(AsyncResult.success(RESULT));
    expect(await first).toBe(RESULT);
    // The refused press returns null rather than a second run.
    expect(await second).toBeNull();
  });

  it("keeps two different proposals independent", () => {
    const store = createNavigatorExecutionStore();
    const otherKey = navigatorExecutionKey({ threadId: THREAD_ID, proposedPlanId: "plan-2" });
    const gate = deferred<AsyncResult.AsyncResult<PeerLoopExecuteProposalResult, unknown>>();
    const first = vi.fn(() => gate.promise);
    const second = vi.fn(() => gate.promise);

    void store.execute(KEY, { run: first });
    void store.execute(otherKey, { run: second });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    // A pending execution is scoped to its own proposal: nothing else in the
    // conversation is put into a pending or blocked state by it.
    expect(store.read(KEY).pending).toBe(true);
    expect(
      store.read(navigatorExecutionKey({ threadId: THREAD_ID, proposedPlanId: "plan-3" })),
    ).toEqual({ pending: false, failure: null, link: null });
    gate.resolve(AsyncResult.success(RESULT));
  });

  it("keeps the structured link the moment it is returned", async () => {
    const store = createNavigatorExecutionStore();
    const result = await store.execute(KEY, {
      run: async () => AsyncResult.success(RESULT),
    });
    // The run id is available before the synchronized read model has anything.
    expect(result?.run.runId).toBe("run-77");
    expect(store.read(KEY).link).toEqual(EXECUTION);
    expect(store.read(KEY).pending).toBe(false);
    expect(store.read(KEY).failure).toBeNull();
  });

  it("drops the retained link once the read model carries it", async () => {
    const store = createNavigatorExecutionStore();
    await store.execute(KEY, { run: async () => AsyncResult.success(RESULT) });
    store.releaseLink(KEY);
    // Nothing is kept twice: the durable record is the only copy left.
    expect(store.read(KEY).link).toBeNull();
  });

  it("releases the gate after a failure and never repeats the request", async () => {
    const store = createNavigatorExecutionStore();
    const run = vi.fn(async () =>
      failWith(
        new PeerLoopTimeoutError({
          method: "peer-loop/execute-proposal",
          timeoutMs: 30_000,
          mayHaveApplied: true,
        }),
      ),
    );
    await store.execute(KEY, { run });

    // ONE ATTEMPT. A timeout means Peer Loop may have started a run and
    // finished after T3 Code stopped waiting; a retry would fork the session.
    expect(run).toHaveBeenCalledTimes(1);
    const state = store.read(KEY);
    expect(state.pending).toBe(false);
    expect(state.failure?.mayHaveStarted).toBe(true);
    expect(state.failure?.presentation.mayHaveApplied).toBe(true);
    // The gate is released so the owner can decide to press again — the code
    // never decides that for them.
    expect(store.isBusy(KEY)).toBe(false);
  });

  it("settles a defect instead of staying pending for ever", async () => {
    const store = createNavigatorExecutionStore();
    const run = vi.fn(async () => {
      throw new Error("socket exploded");
    });
    await store.execute(KEY, { run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(store.read(KEY).pending).toBe(false);
    expect(store.read(KEY).failure?.presentation.title).toBe("Execute could not be sent");
    expect(store.isBusy(KEY)).toBe(false);
  });

  it("notifies subscribers on every settled transition", async () => {
    const store = createNavigatorExecutionStore();
    const seen: number[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.version()));
    await store.execute(KEY, { run: async () => AsyncResult.success(RESULT) });
    unsubscribe();
    // Pending, then settled: both copies of the action see the same two.
    expect(seen).toHaveLength(2);
  });
});

describe("which failure this was", () => {
  it("recognises a coordination failure without going through PeerLoopError", () => {
    const failure = describeExecutionResultFailure(
      failWith(
        new PeerLoopExecutionCoordinationError({
          reason: "link-not-confirmed",
          detail: "internal",
          threadId: THREAD_ID,
          proposedPlanId: PLAN_ID as OrchestrationPeerLoopExecution["proposedPlanId"],
          runId: "run-77",
          mayHaveStarted: true,
        }),
      ),
    );
    expect(failure.inspectorRunId).toBe("run-77");
    expect(failure.mayHaveStarted).toBe(true);
    expect(failure.presentation.title).toBe("The run started, but the link was not recorded");
  });

  it("recognises a Peer Loop refusal and keeps its code", () => {
    const failure = describeExecutionResultFailure(
      failWith(
        new PeerLoopCommandRefusedError({
          code: "PROJECT_HAS_UNFINISHED_RUN",
          detail: "run-5 is still going",
          data: { runId: "run-5" },
        }),
      ),
    );
    expect(failure.presentation.code).toBe("PROJECT_HAS_UNFINISHED_RUN");
    expect(failure.inspectorRunId).toBe("run-5");
  });

  it("does not dress a dropped connection as a Peer Loop refusal", () => {
    const failure = describeExecutionResultFailure(failWith(new Error("socket closed")));
    expect(failure.presentation.code).toBeNull();
    expect(failure.mayHaveStarted).toBe(false);
    expect(failure.presentation.detail).toContain("no run was started");
  });
});
