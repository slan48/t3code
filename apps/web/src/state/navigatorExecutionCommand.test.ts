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
  PeerLoopExecutionFailureReason,
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
  createSnapshotRefreshLedger,
  describeExecutionResultFailure,
  navigatorExecutionKey,
  navigatorSnapshotKey,
} from "./navigatorExecutionCommand";

const ENVIRONMENT_ID = "environment-local";
const THREAD_ID = ThreadId.make("thread-navigator-1");
const PLAN_ID = "plan-1";
const KEY = navigatorExecutionKey({
  environmentId: ENVIRONMENT_ID,
  threadId: THREAD_ID,
  proposedPlanId: PLAN_ID,
});

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

    const timelineKey = navigatorExecutionKey({
      environmentId: ENVIRONMENT_ID,
      threadId: THREAD_ID,
      proposedPlanId: PLAN_ID,
    });
    const sidebarKey = navigatorExecutionKey({
      environmentId: ENVIRONMENT_ID,
      threadId: THREAD_ID,
      proposedPlanId: PLAN_ID,
    });
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

  it("sends one request for a button press and a confirmation phrase at once", async () => {
    // The Execute button and a recognized phrase submitted in the composer are
    // two inputs to one operation. They resolve to the same
    // environment/thread/proposal key, so the gate sees one intent.
    const store = createNavigatorExecutionStore();
    const gate = deferred<AsyncResult.AsyncResult<PeerLoopExecuteProposalResult, unknown>>();
    const fromButton = vi.fn(() => gate.promise);
    const fromPhrase = vi.fn(() => gate.promise);

    const buttonKey = navigatorExecutionKey({
      environmentId: ENVIRONMENT_ID,
      threadId: THREAD_ID,
      proposedPlanId: PLAN_ID,
    });
    const phraseKey = navigatorExecutionKey({
      environmentId: ENVIRONMENT_ID,
      threadId: THREAD_ID,
      proposedPlanId: PLAN_ID,
    });
    expect(phraseKey).toBe(buttonKey);

    const pressed = store.execute(buttonKey, { run: fromButton });
    const confirmed = store.execute(phraseKey, { run: fromPhrase });

    expect(fromButton).toHaveBeenCalledTimes(1);
    expect(fromPhrase).not.toHaveBeenCalled();
    gate.resolve(AsyncResult.success(RESULT));
    // One RPC, one run, and the phrase's caller learns it did not start one.
    expect(await pressed).toBe(RESULT);
    expect(await confirmed).toBeNull();
    // The same retained link either input would have produced.
    expect(store.read(buttonKey).link).toEqual(EXECUTION);
  });

  it("keeps two different proposals independent", () => {
    const store = createNavigatorExecutionStore();
    const otherKey = navigatorExecutionKey({
      environmentId: ENVIRONMENT_ID,
      threadId: THREAD_ID,
      proposedPlanId: "plan-2",
    });
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
      store.read(
        navigatorExecutionKey({
          environmentId: ENVIRONMENT_ID,
          threadId: THREAD_ID,
          proposedPlanId: "plan-3",
        }),
      ),
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

  it("settles a defect as an unknown outcome rather than staying pending", async () => {
    const store = createNavigatorExecutionStore();
    const run = vi.fn(async () => {
      throw new Error("socket exploded");
    });
    await store.execute(KEY, { run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(store.read(KEY).pending).toBe(false);
    // A throw out of the RPC layer proves nothing about the server. The failure
    // says the result is unknown, and the exception text is never shown.
    expect(store.read(KEY).failure?.mayHaveStarted).toBe(true);
    expect(store.read(KEY).failure?.presentation.title).toBe(
      "Execute was sent, and the result is unknown",
    );
    expect(store.read(KEY).failure?.presentation.detail).not.toContain("socket exploded");
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

  it("treats a dropped connection as unknown, not as a refusal and not as safe", () => {
    // A LOST RESPONSE IS NOT A REFUSAL. The request may have reached the
    // coordinator, started a run and recorded the link while the answer was in
    // flight. Claiming "nothing started" here is the guess that forks a session.
    const failure = describeExecutionResultFailure(failWith(new Error("socket closed")));
    expect(failure.presentation.code).toBeNull();
    expect(failure.mayHaveStarted).toBe(true);
    expect(failure.presentation.mayHaveApplied).toBe(true);
    expect(failure.presentation.detail).toContain("cannot say whether a run started");
    expect(failure.presentation.detail).not.toContain("socket closed");
    // No run id to point at, so the owner is sent to the inspector index.
    expect(failure.inspectorRunId).toBeNull();
  });
});

/* ------------------------------------------------------ environments */

describe("two environments, the same ids", () => {
  // A local checkout and a cloud environment of the same project routinely
  // carry the same thread and proposal ids. Keyed without the environment,
  // one machine's pending Execute would render on the other.
  const OTHER_ENVIRONMENT = "environment-cloud";
  const otherKey = navigatorExecutionKey({
    environmentId: OTHER_ENVIRONMENT,
    threadId: THREAD_ID,
    proposedPlanId: PLAN_ID,
  });

  it("does not collide", () => {
    expect(otherKey).not.toBe(KEY);
  });

  it("gates, fails and retains independently", async () => {
    const store = createNavigatorExecutionStore();
    const gate = deferred<AsyncResult.AsyncResult<PeerLoopExecuteProposalResult, unknown>>();
    const here = vi.fn(() => gate.promise);
    const there = vi.fn(async () =>
      failWith(
        new PeerLoopCommandRefusedError({
          code: "CONTROL_UNAVAILABLE",
          detail: "another process",
          data: null,
        }),
      ),
    );

    void store.execute(KEY, { run: here });
    await store.execute(otherKey, { run: there });

    // Both ran: the first environment's gate did not refuse the second.
    expect(here).toHaveBeenCalledTimes(1);
    expect(there).toHaveBeenCalledTimes(1);
    expect(store.isBusy(KEY)).toBe(true);
    expect(store.isBusy(otherKey)).toBe(false);
    expect(store.read(KEY).pending).toBe(true);
    expect(store.read(KEY).failure).toBeNull();
    expect(store.read(otherKey).pending).toBe(false);
    expect(store.read(otherKey).failure?.presentation.code).toBe("CONTROL_UNAVAILABLE");

    gate.resolve(AsyncResult.success(RESULT));
  });

  it("keeps retained links apart", async () => {
    const store = createNavigatorExecutionStore();
    await store.execute(KEY, { run: async () => AsyncResult.success(RESULT) });
    expect(store.read(KEY).link).toEqual(EXECUTION);
    // The other environment has not executed anything and must not inherit a
    // link, or its conversation would show a run that is not on that machine.
    expect(store.read(otherKey).link).toBeNull();
    store.releaseLink(KEY);
    expect(store.read(KEY).link).toBeNull();
  });
});

/* ---------------------------------------------------------- cleanup */

describe("what the store keeps", () => {
  it("holds nothing for a conversation that has done nothing", () => {
    const store = createNavigatorExecutionStore();
    expect(store.read(KEY)).toEqual({ pending: false, failure: null, link: null });
    expect(store.size()).toBe(0);
  });

  it("evicts an entry once its link is durable, however it became idle", async () => {
    // The bug this replaces: releasing a link produced a NEW object that was
    // idle by every meaning that matters but was not the shared constant, so
    // the identity check kept it for ever.
    const store = createNavigatorExecutionStore();
    await store.execute(KEY, { run: async () => AsyncResult.success(RESULT) });
    expect(store.size()).toBe(1);
    store.releaseLink(KEY);
    expect(store.size()).toBe(0);
  });

  it("evicts an entry once a failure is dismissed", async () => {
    const store = createNavigatorExecutionStore();
    await store.execute(KEY, {
      run: async () =>
        failWith(
          new PeerLoopExecutionCoordinationError({
            reason: "proposal-not-found",
            detail: "internal",
            threadId: THREAD_ID,
            proposedPlanId: PLAN_ID as OrchestrationPeerLoopExecution["proposedPlanId"],
            runId: null,
            mayHaveStarted: false,
          }),
        ),
    });
    expect(store.size()).toBe(1);
    store.dismissFailure(KEY);
    expect(store.size()).toBe(0);
  });

  it("does not grow as conversation after conversation catches up", async () => {
    const store = createNavigatorExecutionStore();
    for (let index = 0; index < 50; index += 1) {
      const key = navigatorExecutionKey({
        environmentId: ENVIRONMENT_ID,
        threadId: ThreadId.make(`thread-${index}`),
        proposedPlanId: `plan-${index}`,
      });
      await store.execute(key, { run: async () => AsyncResult.success(RESULT) });
      store.releaseLink(key);
    }
    expect(store.size()).toBe(0);
  });

  it("keeps a settled failure that may have left a run behind", async () => {
    // Safety information. It is not dropped because a card unmounted, or the
    // next render would offer Execute for a run that may already exist.
    const store = createNavigatorExecutionStore();
    await store.execute(KEY, {
      run: async () => {
        throw new Error("socket exploded");
      },
    });
    expect(store.size()).toBe(1);
    expect(store.read(KEY).failure?.mayHaveStarted).toBe(true);
  });
});

/* -------------------------------------------------- snapshot refresh */

describe("who refreshes a shared snapshot, and for how long", () => {
  const KEY_A = navigatorSnapshotKey({ environmentId: "environment-local", runId: "run-77" });

  it("lets exactly one retained copy claim each revision", () => {
    const ledger = createSnapshotRefreshLedger();
    // The timeline copy and the sidebar copy both retain the entry, then both
    // see the same new `updatedAt` in the same tick. One `run.attach`, not two.
    ledger.retain(KEY_A);
    ledger.retain(KEY_A);
    expect(ledger.observers(KEY_A)).toBe(2);
    expect(ledger.claim(KEY_A, "2026-03-01T10:05:00.000Z")).toBe(true);
    expect(ledger.claim(KEY_A, "2026-03-01T10:05:00.000Z")).toBe(false);
    expect(ledger.claim(KEY_A, "2026-03-01T10:05:00.000Z")).toBe(false);
  });

  it("claims again when the summary actually moves", () => {
    const ledger = createSnapshotRefreshLedger();
    ledger.retain(KEY_A);
    ledger.claim(KEY_A, "2026-03-01T10:05:00.000Z");
    expect(ledger.claim(KEY_A, "2026-03-01T10:06:00.000Z")).toBe(true);
    expect(ledger.claim(KEY_A, "2026-03-01T10:06:00.000Z")).toBe(false);
  });

  it("refuses to claim for an entry nobody is observing", () => {
    // No card on screen means nothing to refresh, and creating an entry here
    // is exactly the unbounded growth this replaces.
    const ledger = createSnapshotRefreshLedger();
    expect(ledger.claim(KEY_A, "rev-1")).toBe(false);
    expect(ledger.size()).toBe(0);
  });

  it("keeps runs and environments apart", () => {
    const ledger = createSnapshotRefreshLedger();
    const other = navigatorSnapshotKey({ environmentId: "environment-cloud", runId: "run-77" });
    const otherRun = navigatorSnapshotKey({ environmentId: "environment-local", runId: "run-9" });
    expect(other).not.toBe(KEY_A);
    for (const key of [KEY_A, other, otherRun]) ledger.retain(key);
    ledger.claim(KEY_A, "rev-1");
    expect(ledger.claim(other, "rev-1")).toBe(true);
    expect(ledger.claim(otherRun, "rev-1")).toBe(true);
  });

  it("keeps the entry until the last observer has gone", () => {
    const ledger = createSnapshotRefreshLedger();
    ledger.retain(KEY_A);
    ledger.retain(KEY_A);
    ledger.claim(KEY_A, "rev-1");

    // The Plan sidebar closes. The timeline copy is still watching, so the
    // remembered revision must survive — otherwise it would refresh again for
    // a revision it has already read.
    ledger.release(KEY_A);
    expect(ledger.size()).toBe(1);
    expect(ledger.observers(KEY_A)).toBe(1);
    expect(ledger.claim(KEY_A, "rev-1")).toBe(false);

    ledger.release(KEY_A);
    expect(ledger.size()).toBe(0);
    expect(ledger.observers(KEY_A)).toBe(0);
  });

  it("survives a StrictMode setup, cleanup, setup", () => {
    const ledger = createSnapshotRefreshLedger();
    ledger.retain(KEY_A);
    ledger.release(KEY_A);
    ledger.retain(KEY_A);
    // Alive, owned once, and the intermediate cleanup left no second entry.
    expect(ledger.size()).toBe(1);
    expect(ledger.observers(KEY_A)).toBe(1);
    ledger.release(KEY_A);
    expect(ledger.size()).toBe(0);
  });

  it("does not grow across repeated mount and unmount cycles", () => {
    // The leak this replaces: one entry per environment/run an owner ever
    // looked at, kept for the lifetime of the tab.
    const ledger = createSnapshotRefreshLedger();
    for (let index = 0; index < 50; index += 1) {
      const key = navigatorSnapshotKey({
        environmentId: "environment-local",
        runId: `run-${index}`,
      });
      ledger.retain(key);
      ledger.retain(key);
      ledger.claim(key, "rev-1");
      ledger.release(key);
      ledger.release(key);
    }
    expect(ledger.size()).toBe(0);
  });

  it("ignores a release nobody matched", () => {
    const ledger = createSnapshotRefreshLedger();
    ledger.release(KEY_A);
    expect(ledger.size()).toBe(0);
    expect(ledger.observers(KEY_A)).toBe(0);
  });
});

/* --------------------------------------------------- retry disposition */

describe("what the owner may do after a failure", () => {
  const coordination = (
    reason: PeerLoopExecutionFailureReason,
    overrides: { readonly runId?: string | null; readonly mayHaveStarted?: boolean } = {},
  ) =>
    describeExecutionResultFailure(
      failWith(
        new PeerLoopExecutionCoordinationError({
          reason,
          detail: "internal",
          threadId: THREAD_ID,
          proposedPlanId: PLAN_ID as OrchestrationPeerLoopExecution["proposedPlanId"],
          runId: overrides.runId ?? null,
          mayHaveStarted: overrides.mayHaveStarted ?? false,
        }),
      ),
    );

  it("sends an already-executed proposal to its run despite mayHaveStarted: false", () => {
    const failure = coordination("proposal-already-executed", { runId: "run-12" });
    // The two facts are separate, and this is the case that proves it.
    expect(failure.mayHaveStarted).toBe(false);
    expect(failure.disposition).toBe("inspect-existing");
    expect(failure.inspectorRunId).toBe("run-12");
  });

  it("keeps an ordinary pre-start coordination refusal retryable", () => {
    const failure = coordination("project-not-found");
    expect(failure.mayHaveStarted).toBe(false);
    expect(failure.disposition).toBe("retryable");
  });

  it("marks a link that could not be confirmed as unknown", () => {
    const failure = coordination("link-not-confirmed", { runId: "run-77", mayHaveStarted: true });
    expect(failure.disposition).toBe("unknown");
  });

  it("links a project-level unfinished run without calling this proposal executed", () => {
    // A different run in the same project. Worth pointing at, and no reason to
    // stop the owner pressing Execute once it finishes.
    const failure = describeExecutionResultFailure(
      failWith(
        new PeerLoopCommandRefusedError({
          code: "PROJECT_HAS_UNFINISHED_RUN",
          detail: "run-5 is still going",
          data: { runId: "run-5" },
        }),
      ),
    );
    expect(failure.inspectorRunId).toBe("run-5");
    expect(failure.disposition).toBe("retryable");
  });

  it("marks a timeout that may have applied as unknown, and one that did not as retryable", () => {
    expect(
      describeExecutionResultFailure(
        failWith(
          new PeerLoopTimeoutError({
            method: "peer-loop/execute-proposal",
            timeoutMs: 30_000,
            mayHaveApplied: true,
          }),
        ),
      ).disposition,
    ).toBe("unknown");
    expect(
      describeExecutionResultFailure(
        failWith(
          new PeerLoopTimeoutError({
            method: "peer-loop/execute-proposal",
            timeoutMs: 30_000,
            mayHaveApplied: false,
          }),
        ),
      ).disposition,
    ).toBe("retryable");
  });

  it("marks an unclassified failure as unknown", () => {
    expect(describeExecutionResultFailure(failWith(new Error("socket closed"))).disposition).toBe(
      "unknown",
    );
  });
});
