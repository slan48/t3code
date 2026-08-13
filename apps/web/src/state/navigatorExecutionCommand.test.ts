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
  EnvironmentId,
  OrchestrationPeerLoopExecution,
  OrchestrationProposedPlanId,
  PeerLoopAttachResult,
  PeerLoopExecuteProposalResult,
  PeerLoopExecutionFailureReason,
  PeerLoopRunStateFile,
  PeerLoopRunSummary,
} from "@t3tools/contracts";
import {
  PeerLoopCommandRefusedError,
  PeerLoopExecutionCoordinationError,
  PeerLoopTimeoutError,
  ThreadId,
  TurnId,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import type { RpcSession, WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import {
  createPeerLoopEnvironmentAtoms,
  createPeerLoopEnvironmentCommands,
} from "@t3tools/client-runtime/state/peer-loop";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  describeExecution,
  describeExecutionDetail,
  executionSnapshotIsUseful,
  selectNavigatorSnapshotAtom,
  type NavigatorExecutionDetail,
  type NavigatorExecutionPresentation,
} from "~/navigatorExecution";
import { consumeNavigatorConfirmation, routeNavigatorSend } from "~/navigatorConfirmation";
import { deriveNavigatorExecution } from "~/components/ChatView.logic";
import {
  createNavigatorExecutionStore,
  createSnapshotRefreshLedger,
  describeExecutionResultFailure,
  navigatorExecutionAvailability,
  navigatorExecutionKey,
  navigatorExecutionStore,
  navigatorSnapshotKey,
  navigatorSnapshotOf,
  observeSnapshotRevision,
  snapshotReadingIsBehind,
  snapshotRefreshLedger,
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
    // The timeline copy and the sidebar copy both hold the same reading and
    // both see the same new `updatedAt` in the same tick. One `run.attach`.
    ledger.retain(KEY_A);
    ledger.retain(KEY_A);
    expect(ledger.observers(KEY_A)).toBe(2);
    expect(ledger.claim(KEY_A, "2026-03-01T10:05:00.000Z")).toBe(true);
    expect(ledger.claim(KEY_A, "2026-03-01T10:05:00.000Z")).toBe(false);
    expect(ledger.claim(KEY_A, "2026-03-01T10:05:00.000Z")).toBe(false);
    expect(ledger.claimed(KEY_A)).toBe("2026-03-01T10:05:00.000Z");
  });

  it("claims again when the summary actually moves", () => {
    const ledger = createSnapshotRefreshLedger();
    ledger.retain(KEY_A);
    ledger.claim(KEY_A, "2026-03-01T10:05:00.000Z");
    expect(ledger.claim(KEY_A, "2026-03-01T10:06:00.000Z")).toBe(true);
    expect(ledger.claim(KEY_A, "2026-03-01T10:06:00.000Z")).toBe(false);
  });

  it("refuses to claim for an entry nobody is observing", () => {
    // No card on screen means nothing to read for, and creating an entry here
    // is exactly the unbounded growth this replaces.
    const ledger = createSnapshotRefreshLedger();
    expect(ledger.claim(KEY_A, "rev-1")).toBe(false);
    expect(ledger.size()).toBe(0);
    expect(ledger.claimed(KEY_A)).toBeNull();
  });

  it("keeps runs and environments apart", () => {
    const ledger = createSnapshotRefreshLedger();
    const other = navigatorSnapshotKey({ environmentId: "environment-cloud", runId: "run-77" });
    const otherRun = navigatorSnapshotKey({ environmentId: "environment-local", runId: "run-9" });
    expect(other).not.toBe(KEY_A);
    for (const key of [KEY_A, other, otherRun]) ledger.retain(key);
    ledger.claim(KEY_A, "rev-1");
    // One environment's run being read says nothing about the same run id on
    // another machine, or about a different run on this one.
    expect(ledger.claimed(other)).toBeNull();
    expect(ledger.claim(other, "rev-1")).toBe(true);
    expect(ledger.claim(otherRun, "rev-1")).toBe(true);
    expect(ledger.claimed(KEY_A)).toBe("rev-1");
  });

  it("keeps the entry until the last observer has gone", () => {
    const ledger = createSnapshotRefreshLedger();
    ledger.retain(KEY_A);
    ledger.retain(KEY_A);
    ledger.claim(KEY_A, "rev-1");

    // The Plan sidebar closes. The timeline copy is still watching, so the
    // claim must survive — otherwise the read already in flight for this
    // revision would be issued a second time.
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

describe("whether the reading a card holds is behind the run list", () => {
  it("is not behind before anything has been read", () => {
    // The read that mounting the atom started is the answer. A second one here
    // would be the duplicate the whole arrangement exists to avoid.
    expect(snapshotReadingIsBehind(null, "2026-03-01T10:05:00.000Z")).toBe(false);
  });

  it("is not behind at the listed revision", () => {
    expect(snapshotReadingIsBehind("2026-03-01T10:05:00.000Z", "2026-03-01T10:05:00.000Z")).toBe(
      false,
    );
  });

  it("is behind when the run moved after the reading was taken", () => {
    expect(snapshotReadingIsBehind("2026-03-01T10:05:00.000Z", "2026-03-01T10:06:00.000Z")).toBe(
      true,
    );
  });

  it("is not behind when the reading is newer than the summary", () => {
    // Routine, not exotic: the attach lands after the poll that prompted it,
    // and re-reading for a summary the reading already overtook would cost a
    // bridge request per poll.
    expect(snapshotReadingIsBehind("2026-03-01T10:07:00.000Z", "2026-03-01T10:05:00.000Z")).toBe(
      false,
    );
  });

  it("treats stamps it cannot compare as behind, which costs one read", () => {
    // A newer Peer Loop writing something this cannot parse must not freeze a
    // card on an old reading. The claim bounds it to one read per revision.
    expect(snapshotReadingIsBehind("not-a-time", "2026-03-01T10:05:00.000Z")).toBe(true);
    expect(snapshotReadingIsBehind("2026-03-01T10:05:00.000Z", "not-a-time")).toBe(true);
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

/* ------------------------------ the snapshot a mounted card actually reads */

/**
 * Child execution cards, over the REAL `peerLoop.attachRun` atom.
 *
 * Everything above this point drives the ledger on its own, which proves the
 * bookkeeping and nothing about the thing that goes wrong on screen: a card
 * showing one revision's reading while the run list has already moved on. That
 * only shows up where the shared atom, the reference counting and React's own
 * commit order meet, so this builds a fake authenticated environment around
 * `createPeerLoopEnvironmentAtoms` — the same factory `apps/web` ships — and
 * mounts cards against it in the order React commits them: every card renders,
 * then every teardown runs, then every setup runs.
 *
 * What is asserted is what an owner would see (`describeExecutionDetail` over
 * the reading the card holds) and what Peer Loop was asked for (one attach per
 * revision that needs one, and none at all for a run whose card wants no
 * structured detail).
 */
describe("a child execution whose run keeps moving", () => {
  const ENVIRONMENT = "environment-local" as EnvironmentId;
  const CLOUD_ENVIRONMENT = "environment-cloud" as EnvironmentId;
  /** Fixed, so the relative label in a presentation is deterministic. */
  const SNAPSHOT_NOW_MS = Date.parse("2026-03-01T10:20:00.000Z");

  const TEST_TARGET = new PrimaryConnectionTarget({
    environmentId: ENVIRONMENT,
    label: "Test environment",
    httpBaseUrl: "https://environment.example.test",
    wsBaseUrl: "wss://environment.example.test",
  });

  const adapters = {
    reviewer: "codex",
    reviewerVersion: null,
    builder: "claude-code",
    builderVersion: null,
  } as const;

  const Q1 = "Which database should the backfill target?";
  const Q2 = "The replica is behind. Wait for it, or switch to the primary?";

  /*
   * Peer Loop stamps the run list and the run state file from the same clock,
   * so a reading and the summary it belongs to carry the same `updatedAt`.
   * These fixtures keep that true, because it is the fact the surface uses to
   * tell a current reading from one taken before the run moved.
   */
  const OWNER_REVISION = "2026-03-01T10:01:00.000Z";
  const WORKING_REVISION = "2026-03-01T10:03:00.000Z";
  const DONE_REVISION = "2026-03-01T10:05:00.000Z";
  const SECOND_OWNER_REVISION = "2026-03-01T10:07:00.000Z";

  const RUN_ID = "run-77";
  const SNAPSHOT_LINK: OrchestrationPeerLoopExecution = {
    runId: RUN_ID,
    proposedPlanId: PLAN_ID as OrchestrationProposedPlanId,
    createdAt: "2026-03-01T09:00:00.000Z",
  };

  /** One entry of Peer Loop's run list — the only thing the card reads live. */
  const summary = (overrides: Partial<PeerLoopRunSummary> = {}): PeerLoopRunSummary => ({
    runId: RUN_ID,
    projectPath: "/repos/demo",
    state: "builder_working",
    iteration: 4,
    createdAt: "2026-03-01T09:00:00.000Z",
    updatedAt: "2026-03-01T10:00:00.000Z",
    haltReason: null,
    inFlight: null,
    queuedOwnerMessages: 0,
    lastSequence: 12,
    awaitingOwnerObjective: false,
    adapters,
    liveWriter: {
      pid: 4242,
      host: "workstation",
      command: "start",
      runId: RUN_ID,
      acquiredAt: "2026-03-01T09:00:00.000Z",
      renewedAt: "2026-03-01T10:00:00.000Z",
      isThisProcess: true,
    },
    liveInThisBridge: true,
    ...overrides,
  });

  const waitingOnOwner = (updatedAt: string, question: string): PeerLoopRunSummary =>
    summary({
      state: "owner_required",
      updatedAt,
      haltReason: { kind: "OWNER_REQUIRED", message: question },
    });

  const finished = (updatedAt: string): PeerLoopRunSummary =>
    summary({ state: "done", updatedAt, liveWriter: null });

  /** The durable state file behind an attach, as Peer Loop would hand it over. */
  const runState = (overrides: Partial<PeerLoopRunStateFile> = {}): PeerLoopRunStateFile =>
    ({
      schemaVersion: 1,
      runId: RUN_ID,
      projectPath: "/repos/demo",
      state: "owner_required",
      iteration: 4,
      createdAt: "2026-03-01T09:00:00.000Z",
      updatedAt: "2026-03-01T10:00:00.000Z",
      ownerPolicyText: "OWNER POLICY",
      builderSessionId: null,
      reviewerThreadId: null,
      repo: null,
      lastBuilderTask: "do not read me",
      lastBuilderReport: "do not read me either",
      lastReviewerDecision: null,
      queuedOwnerMessages: [],
      inFlight: null,
      haltReason: null,
      stopRequested: false,
      adapters,
      safetyLimit: null,
      lastSequence: 20,
      ...overrides,
    }) as PeerLoopRunStateFile;

  const asking = (question: string, updatedAt: string): PeerLoopRunStateFile =>
    runState({
      state: "owner_required",
      updatedAt,
      lastReviewerDecision: {
        decision: "OWNER_REQUIRED",
        summary: "Blocked on a choice.",
        ownerQuestion: question,
        whyOwnerIsRequired: "Only the owner can settle it.",
        options: ["Primary", "Replica"],
      },
    });

  const completed = runState({
    state: "done",
    updatedAt: DONE_REVISION,
    lastReviewerDecision: {
      decision: "DONE",
      summary: "Backfill shipped.",
      finalState: "Green on main.",
    },
    repo: {
      head: "abc123def456",
      branch: "main",
      worktreeDigest: null,
      isGitRepo: true,
      capturedAt: "2026-03-01T10:05:00.000Z",
    },
  });

  const attachOf = (state: PeerLoopRunStateFile): PeerLoopAttachResult =>
    ({
      runId: state.runId,
      state,
      control: {
        available: true,
        reason: "live_in_this_bridge",
        liveWriter: null,
        resumable: false,
      },
      eventHighWaterMark: 20,
      replayFromSeq: 0,
      live: false,
    }) as PeerLoopAttachResult;

  type SnapshotAtom = Atom.Atom<
    AsyncResult.AsyncResult<{ readonly state: PeerLoopRunStateFile }, unknown>
  >;

  /** Mirrors the production "queries nothing" atom, and queries nothing. */
  const NO_SNAPSHOT_QUERY = Atom.make(AsyncResult.initial<never, never>(false)) as SnapshotAtom;

  /** Deterministic: yield to the runtime until the condition holds, never sleep. */
  const until = (predicate: () => boolean, label: string) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 1_000; attempt += 1) {
        if (predicate()) return;
        yield* Effect.yieldNow;
      }
      throw new Error(`timed out waiting for ${label}`);
    });

  /**
   * A fake authenticated environment, and the real Peer Loop atom family over it.
   *
   * `serve` is what Peer Loop would answer the *next* attach with, so a test can
   * move the run and then let the surface discover it — which is the whole
   * question here.
   */
  interface Bridge {
    /** Every `peerLoop.attachRun` this surface issued, in order. */
    readonly attaches: ReadonlyArray<{ readonly runId: string }>;
    readonly registry: AtomRegistry.AtomRegistry;
    readonly serve: (state: PeerLoopRunStateFile) => void;
    readonly snapshotAtomFor: (environmentId: EnvironmentId, runId: string) => SnapshotAtom;
  }

  const bridge = (first: PeerLoopRunStateFile) =>
    Effect.gen(function* () {
      const attaches: Array<{ readonly runId: string }> = [];
      let serving = first;

      const client = {
        [WS_METHODS.peerLoopAttachRun]: (input: { readonly runId: string }) =>
          Effect.sync(() => {
            attaches.push(input);
            return attachOf(serving);
          }),
      } as unknown as WsRpcProtocolClient;

      const supervisor = EnvironmentSupervisor.of({
        target: TEST_TARGET,
        state: yield* SubscriptionRef.make({
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          phase: "connected",
          generation: 1,
        }),
        session: yield* SubscriptionRef.make(
          Option.some({
            client,
            initialConfig: Effect.never,
            ready: Effect.void,
            probe: Effect.void,
            closed: Effect.never,
          } as RpcSession),
        ),
        prepared: yield* SubscriptionRef.make(Option.none()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } as unknown as EnvironmentSupervisor["Service"]);

      const followStream: EnvironmentRegistry["Service"]["followStream"] = (_environmentId, s) =>
        Stream.provideService(s, EnvironmentSupervisor, supervisor);
      const runStream: EnvironmentRegistry["Service"]["runStream"] = (_environmentId, s) =>
        Stream.provideService(s, EnvironmentSupervisor, supervisor);
      const run = <A, E, R>(_environmentId: EnvironmentId, effect: Effect.Effect<A, E, R>) =>
        Effect.provideService(effect, EnvironmentSupervisor, supervisor);
      const environmentRegistry = EnvironmentRegistry.of({
        followStream,
        runStream,
        run,
      } as unknown as EnvironmentRegistry["Service"]);

      const peerLoopAtoms = createPeerLoopEnvironmentAtoms(
        Atom.runtime(Layer.succeed(EnvironmentRegistry, environmentRegistry)) as never,
      );
      const registry = AtomRegistry.make();

      const harness: Bridge = {
        attaches,
        registry,
        serve: (state: PeerLoopRunStateFile) => {
          serving = state;
        },
        // THE PRODUCTION ATOM. Same family, same key, same idle TTL — the two
        // copies of one execution get the same node from it, which is the whole
        // reason the reading has to be coordinated at all.
        snapshotAtomFor: (environmentId: EnvironmentId, runId: string) =>
          peerLoopAtoms.attach({
            environmentId: environmentId as never,
            input: { runId },
          }) as unknown as SnapshotAtom,
      };
      return harness;
    });

  interface Frame {
    readonly presentation: NavigatorExecutionPresentation;
    readonly wanted: boolean;
    readonly atom: SnapshotAtom;
    readonly key: string | null;
    readonly revision: string | null;
  }

  /**
   * One mounted copy of a child execution card, in React's own order.
   *
   * `render` is the render pass — which atom this copy reads and which entry it
   * owns, decided by exactly the production selectors. `destroy` and `create`
   * are the passive effects around it, kept apart because React runs every
   * teardown in a commit before any setup, and that ordering is precisely what
   * decides which copy does the reading.
   */
  const card = (input: { readonly harness: Bridge; readonly environmentId?: EnvironmentId }) => {
    const environmentId = input.environmentId ?? ENVIRONMENT;
    const { registry, snapshotAtomFor } = input.harness;
    let committed: Frame | null = null;
    let pending: Frame | null = null;
    let unmountAtom: (() => void) | null = null;

    const frameFor = (runs: ReadonlyArray<PeerLoopRunSummary>): Frame => {
      const presentation = describeExecution({
        link: SNAPSHOT_LINK,
        runs,
        unreadable: [],
        nowMs: SNAPSHOT_NOW_MS,
      });
      const wanted = executionSnapshotIsUseful(presentation.status);
      return {
        presentation,
        wanted,
        atom: selectNavigatorSnapshotAtom<SnapshotAtom>({
          environmentId,
          runId: presentation.runId,
          wanted,
          snapshotAtomFor,
          none: NO_SNAPSHOT_QUERY,
        }),
        key: wanted
          ? navigatorSnapshotKey({
              environmentId: String(environmentId),
              runId: presentation.runId,
            })
          : null,
        revision: presentation.status.kind === "summary" ? presentation.status.updatedAt : null,
      };
    };

    const current = (): Frame => {
      if (committed === null) throw new Error("this card is not mounted");
      return committed;
    };

    const snapshotOf = (frame: Frame) =>
      navigatorSnapshotOf({
        wanted: frame.wanted,
        environmentId,
        result: registry.get(frame.atom),
      });

    /** The hook's own effect, with the reading this copy is holding right now. */
    let lastReading: string | null = null;
    const observe = (frame: Frame): void => {
      lastReading = snapshotOf(frame).state?.updatedAt ?? null;
      observeSnapshotRevision({
        key: frame.key,
        revision: frame.revision,
        reading: lastReading,
        refresh: () => registry.refresh(frame.atom),
      });
    };

    return {
      render: (runs: ReadonlyArray<PeerLoopRunSummary>): void => {
        pending = frameFor(runs);
      },
      destroy: (): void => {
        if (pending === null || committed === null) return;
        if (pending.atom !== committed.atom) {
          unmountAtom?.();
          unmountAtom = null;
        }
        if (pending.key !== committed.key && committed.key !== null) {
          snapshotRefreshLedger.release(committed.key);
        }
      },
      create: (): void => {
        const frame = pending ?? committed;
        if (frame === null) return;
        const previous = committed;
        const atomChanged = previous === null || previous.atom !== frame.atom;
        const keyChanged = previous === null || previous.key !== frame.key;
        // `useAtomValue` subscribes before the hook's own effects run, so the
        // shared node exists — and this copy renders again when it changes,
        // which is how a reading arriving later reaches the same effect.
        if (atomChanged) {
          const unsubscribe = registry.subscribe(frame.atom, () => {
            if (committed === null) return;
            if ((snapshotOf(committed).state?.updatedAt ?? null) === lastReading) return;
            observe(committed);
          });
          const unmount = registry.mount(frame.atom);
          unmountAtom = () => {
            unsubscribe();
            unmount();
          };
        }
        if (keyChanged && frame.key !== null) snapshotRefreshLedger.retain(frame.key);
        committed = frame;
        pending = null;
        if (!atomChanged && !keyChanged && previous?.revision === frame.revision) return;
        observe(frame);
      },
      unmount: (): void => {
        if (committed === null) return;
        unmountAtom?.();
        unmountAtom = null;
        if (committed.key !== null) snapshotRefreshLedger.release(committed.key);
        committed = null;
        pending = null;
      },
      settled: (): boolean => committed === null || !registry.get(committed.atom).waiting,
      /** Exactly what the card renders under its status line. */
      detail: (): NavigatorExecutionDetail =>
        describeExecutionDetail({
          status: current().presentation.status,
          snapshot: snapshotOf(current()),
        }),
    } as const;
  };

  type Card = ReturnType<typeof card>;

  /** One commit: every copy renders, every teardown runs, then every setup. */
  const commit = (cards: ReadonlyArray<Card>, runs: ReadonlyArray<PeerLoopRunSummary>): void => {
    for (const one of cards) one.render(runs);
    for (const one of cards) one.destroy();
    for (const one of cards) one.create();
  };

  beforeEach(() => {
    snapshotRefreshLedger.reset();
  });

  effectIt.effect("replaces the owner question with the completion when the run finishes", () =>
    Effect.gen(function* () {
      const harness = yield* bridge(asking(Q1, OWNER_REVISION));
      const timeline = card({ harness });

      commit([timeline], [waitingOnOwner(OWNER_REVISION, "Which database?")]);
      yield* until(() => harness.attaches.length === 1 && timeline.settled(), "the first reading");
      expect(timeline.detail()).toEqual({
        kind: "owner-required",
        decision: {
          question: Q1,
          why: "Only the owner can settle it.",
          options: ["Primary", "Replica"],
        },
      });

      // Peer Loop finishes the run; the five-second run list is how this
      // surface hears about it, and its `updatedAt` is the only trigger.
      harness.serve(completed);
      commit([timeline], [finished(DONE_REVISION)]);
      yield* until(
        () => harness.attaches.length === 2 && timeline.settled(),
        "the reading for the DONE revision",
      );

      // The Reviewer's own completion, not the question underneath it, and not
      // the "no structured completion" a stale reading would produce.
      expect(timeline.detail()).toEqual({
        kind: "completion",
        completion: { summary: "Backfill shipped.", finalState: "Green on main." },
        head: "abc123def456",
        branch: "main",
      });
      expect(harness.attaches).toEqual([{ runId: RUN_ID }, { runId: RUN_ID }]);

      timeline.unmount();
      harness.registry.dispose();
    }),
  );

  effectIt.effect("reads the finished run for a copy that opens as it finishes", () =>
    Effect.gen(function* () {
      // THE REGRESSION. The Plan sidebar opening in the same commit that brings
      // the DONE summary used to consume the revision without reading it — its
      // own mount reads *something*, and from one card's side that looks like
      // enough. The timeline copy, holding the OWNER_REQUIRED reading they
      // share, then found the revision already accounted for and stood down, so
      // a finished run kept its question and reported no completion.
      const harness = yield* bridge(asking(Q1, OWNER_REVISION));
      const timeline = card({ harness });

      commit([timeline], [waitingOnOwner(OWNER_REVISION, "Which database?")]);
      yield* until(() => harness.attaches.length === 1 && timeline.settled(), "the first reading");

      const sidebar = card({ harness });
      harness.serve(completed);
      // The sidebar mounts in the same commit the DONE summary arrives in.
      commit([sidebar, timeline], [finished(DONE_REVISION)]);
      yield* until(
        () => harness.attaches.length === 2 && timeline.settled() && sidebar.settled(),
        "the reading for the DONE revision",
      );

      // Both copies show the completion, because both read the same node.
      for (const [name, copy] of [
        ["timeline", timeline],
        ["sidebar", sidebar],
      ] as const) {
        expect(copy.detail(), name).toEqual({
          kind: "completion",
          completion: { summary: "Backfill shipped.", finalState: "Green on main." },
          head: "abc123def456",
          branch: "main",
        });
      }
      // And one reading between them, not one each.
      expect(harness.attaches).toHaveLength(2);

      timeline.unmount();
      sidebar.unmount();
      harness.registry.dispose();
    }),
  );

  effectIt.effect("reads the finished run for a card that scrolled away and came back", () =>
    Effect.gen(function* () {
      // The timeline virtualizes its rows, so leaving a long conversation and
      // scrolling back is an unmount and a fresh mount. The shared node lingers
      // for a few minutes after the last card stops reading it, so the copy
      // that comes back is handed the reading from before it left — and used to
      // treat its own mount as the reading and never ask for another. The
      // finished run then reported no completion at all.
      const harness = yield* bridge(asking(Q1, OWNER_REVISION));
      const before = card({ harness });

      commit([before], [waitingOnOwner(OWNER_REVISION, "Which database?")]);
      yield* until(() => harness.attaches.length === 1 && before.settled(), "the first reading");
      before.unmount();

      harness.serve(completed);
      const returning = card({ harness });
      commit([returning], [finished(DONE_REVISION)]);
      yield* until(
        () => harness.attaches.length === 2 && returning.settled(),
        "the reading for the DONE revision",
      );
      expect(returning.detail()).toEqual({
        kind: "completion",
        completion: { summary: "Backfill shipped.", finalState: "Green on main." },
        head: "abc123def456",
        branch: "main",
      });

      returning.unmount();
      harness.registry.dispose();
    }),
  );

  effectIt.effect("shows the second question after the run works in between", () =>
    Effect.gen(function* () {
      const harness = yield* bridge(asking(Q1, OWNER_REVISION));
      const timeline = card({ harness });

      commit([timeline], [waitingOnOwner(OWNER_REVISION, "Which database?")]);
      yield* until(() => harness.attaches.length === 1 && timeline.settled(), "the first reading");
      expect(timeline.detail()).toMatchObject({ kind: "owner-required" });

      // The owner answers in the inspector and the Builder gets going again.
      // A working run has no structured detail worth a bridge request.
      commit([timeline], [summary({ updatedAt: WORKING_REVISION })]);
      yield* until(() => timeline.settled(), "the working commit to settle");
      expect(timeline.detail()).toEqual({ kind: "none" });
      expect(harness.attaches).toHaveLength(1);

      // And it stops for the owner again, with a different question.
      harness.serve(asking(Q2, SECOND_OWNER_REVISION));
      commit([timeline], [waitingOnOwner(SECOND_OWNER_REVISION, "Wait for the replica?")]);
      yield* until(
        () => harness.attaches.length === 2 && timeline.settled(),
        "the reading for the second question",
      );
      expect(timeline.detail()).toMatchObject({
        kind: "owner-required",
        decision: { question: Q2 },
      });

      timeline.unmount();
      harness.registry.dispose();
    }),
  );

  effectIt.effect("shows the second question to a card that mounts after the working state", () =>
    Effect.gen(function* () {
      // Same shape as scrolling back, with the run stopping for the owner a
      // second time rather than finishing: the cached reading still carries the
      // first question, and showing it under the second one would be an answer
      // to the wrong question.
      const harness = yield* bridge(asking(Q1, OWNER_REVISION));
      const before = card({ harness });

      commit([before], [waitingOnOwner(OWNER_REVISION, "Which database?")]);
      yield* until(() => harness.attaches.length === 1 && before.settled(), "the first reading");
      commit([before], [summary({ updatedAt: WORKING_REVISION })]);
      before.unmount();

      harness.serve(asking(Q2, SECOND_OWNER_REVISION));
      const returning = card({ harness });
      commit([returning], [waitingOnOwner(SECOND_OWNER_REVISION, "Wait for the replica?")]);
      yield* until(
        () => harness.attaches.length === 2 && returning.settled(),
        "the reading for the second question",
      );
      expect(returning.detail()).toMatchObject({
        kind: "owner-required",
        decision: { question: Q2 },
      });

      returning.unmount();
      harness.registry.dispose();
    }),
  );

  effectIt.effect("reads once for two copies that mount at the same revision", () =>
    Effect.gen(function* () {
      const harness = yield* bridge(asking(Q1, OWNER_REVISION));
      const timeline = card({ harness });
      const sidebar = card({ harness });

      commit([timeline, sidebar], [waitingOnOwner(OWNER_REVISION, "Which database?")]);
      yield* until(
        () => harness.attaches.length === 1 && timeline.settled() && sidebar.settled(),
        "the one shared reading",
      );
      expect(harness.attaches).toHaveLength(1);
      expect(
        snapshotRefreshLedger.observers(
          navigatorSnapshotKey({ environmentId: String(ENVIRONMENT), runId: RUN_ID }),
        ),
      ).toBe(2);

      // A later summary that says nothing new is not a revision, and re-reading
      // for it would be one bridge request per poll.
      commit([timeline, sidebar], [waitingOnOwner(OWNER_REVISION, "Which database?")]);
      yield* until(() => timeline.settled() && sidebar.settled(), "the repeated summary to settle");
      expect(harness.attaches).toHaveLength(1);

      timeline.unmount();
      sidebar.unmount();
      // Nothing on screen, nothing retained.
      expect(snapshotRefreshLedger.size()).toBe(0);
      harness.registry.dispose();
    }),
  );

  effectIt.effect("asks Peer Loop for nothing while the run is only working", () =>
    Effect.gen(function* () {
      const harness = yield* bridge(asking(Q1, OWNER_REVISION));
      const timeline = card({ harness });
      const sidebar = card({ harness });

      for (const runs of [
        [summary()],
        [summary({ updatedAt: WORKING_REVISION })],
        [summary({ state: "interrupted", updatedAt: WORKING_REVISION, liveWriter: null })],
        [summary({ state: "error", updatedAt: DONE_REVISION })],
      ]) {
        commit([timeline, sidebar], runs);
        yield* until(() => timeline.settled() && sidebar.settled(), "the working commit to settle");
        expect(timeline.detail()).toEqual({ kind: "none" });
      }
      // Not one `run.attach`, and not one ledger entry either.
      expect(harness.attaches).toHaveLength(0);
      expect(snapshotRefreshLedger.size()).toBe(0);

      timeline.unmount();
      sidebar.unmount();
      harness.registry.dispose();
    }),
  );

  effectIt.effect("keeps two environments holding the same run id apart", () =>
    Effect.gen(function* () {
      // Peer Loop run ids are per-machine. A local checkout and a cloud
      // environment can both carry `run-77`, and one's reading must never be
      // shown for the other's run.
      const harness = yield* bridge(asking(Q1, OWNER_REVISION));
      const local = card({ harness });
      const cloud = card({ harness, environmentId: CLOUD_ENVIRONMENT });

      commit([local, cloud], [waitingOnOwner(OWNER_REVISION, "Which database?")]);
      yield* until(
        () => harness.attaches.length === 2 && local.settled() && cloud.settled(),
        "one reading per environment",
      );
      // Two entries, two readings: nothing was shared across the machines.
      expect(snapshotRefreshLedger.size()).toBe(2);
      expect(
        snapshotRefreshLedger.observers(
          navigatorSnapshotKey({ environmentId: String(ENVIRONMENT), runId: RUN_ID }),
        ),
      ).toBe(1);
      expect(
        snapshotRefreshLedger.observers(
          navigatorSnapshotKey({ environmentId: String(CLOUD_ENVIRONMENT), runId: RUN_ID }),
        ),
      ).toBe(1);

      local.unmount();
      cloud.unmount();
      harness.registry.dispose();
    }),
  );
});

/* ------------------------------- executing from a rehydrated conversation */

/**
 * The owner's sequence, from the thread as the server hands it back.
 *
 * NOTHING HERE ASSERTS A DERIVED FACT INTO PLACE. The thread is built the way
 * a rehydrated Navigator conversation really arrives — a stopped session, no
 * latest-turn pointer, and a plan produced by a turn that finished long ago —
 * and every decision below is derived from it by the same functions the mounted
 * surface uses: `deriveNavigatorExecution` for the facts and the confirmation's
 * target, `navigatorExecutionAvailability` for the card, `routeNavigatorSend`
 * for the phrase.
 *
 * The refusal is produced by the REAL command over a fake authenticated
 * environment, so Peer Loop's answer is classified on the path that actually
 * carries it rather than by a hand-built `Cause`.
 */
describe("a historical proposal on a conversation the owner came back to", () => {
  const ENVIRONMENT = "environment-local" as EnvironmentId;
  const MOUNT_THREAD = ThreadId.make("thread-navigator-mount");
  const MOUNT_PLAN = "plan-mount" as OrchestrationProposedPlanId;
  const PLAN_TURN = TurnId.make("turn-that-produced-the-plan");

  const MOUNT_TARGET = new PrimaryConnectionTarget({
    environmentId: ENVIRONMENT,
    label: "Test environment",
    httpBaseUrl: "https://environment.example.test",
    wsBaseUrl: "wss://environment.example.test",
  });

  const historicalPlan = {
    id: MOUNT_PLAN,
    threadId: MOUNT_THREAD,
    turnId: PLAN_TURN,
    planMarkdown: "# Split the migration",
    createdAt: "2026-03-01T09:00:00.000Z",
    updatedAt: "2026-03-01T09:00:00.000Z",
    implementedAt: null,
    implementationThreadId: null,
  };

  /**
   * What `peerLoop.executeProposal` was refused with, and what the projection
   * left behind: `latestTurn: null`, because the session that produced the plan
   * has since stopped and the pointer is written from `session.activeTurnId`.
   */
  const rehydratedThread = (overrides: Record<string, unknown> = {}) =>
    ({
      id: MOUNT_THREAD,
      purpose: "navigator",
      latestTurn: null,
      session: { status: "stopped", activeTurnId: null },
      proposedPlans: [historicalPlan],
      ...overrides,
    }) as never;

  const mountKey = navigatorExecutionKey({
    environmentId: ENVIRONMENT,
    threadId: MOUNT_THREAD,
    proposedPlanId: MOUNT_PLAN,
  });

  /** One Execute attempt over the real command, answered with `refusal`. */
  const attempt = (refusal: Error) =>
    Effect.gen(function* () {
      const requests: Array<unknown> = [];
      const client = {
        [WS_METHODS.peerLoopExecuteProposal]: (input: unknown) => {
          requests.push(input);
          return Effect.fail(refusal);
        },
      } as unknown as WsRpcProtocolClient;

      const supervisor = EnvironmentSupervisor.of({
        target: MOUNT_TARGET,
        state: yield* SubscriptionRef.make({
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          phase: "connected",
          generation: 1,
        }),
        session: yield* SubscriptionRef.make(
          Option.some({
            client,
            initialConfig: Effect.never,
            ready: Effect.void,
            probe: Effect.void,
            closed: Effect.never,
          } as RpcSession),
        ),
        prepared: yield* SubscriptionRef.make(Option.none()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } as unknown as EnvironmentSupervisor["Service"]);

      const environmentRegistry = EnvironmentRegistry.of({
        followStream: (_environmentId: unknown, stream: never) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        runStream: (_environmentId: unknown, stream: never) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        run: <A, E, R>(_environmentId: unknown, effect: Effect.Effect<A, E, R>) =>
          Effect.provideService(effect, EnvironmentSupervisor, supervisor),
      } as unknown as EnvironmentRegistry["Service"]);

      const commands = createPeerLoopEnvironmentCommands(
        Atom.runtime(Layer.succeed(EnvironmentRegistry, environmentRegistry)) as never,
      );
      const registry = AtomRegistry.make();

      yield* Effect.promise(() =>
        navigatorExecutionStore.execute(mountKey, {
          run: () =>
            runAtomCommand(
              registry,
              commands.executeProposal,
              {
                environmentId: ENVIRONMENT,
                input: { threadId: MOUNT_THREAD, proposedPlanId: MOUNT_PLAN },
              } as never,
              { reportFailure: false, reportDefect: false },
            ) as never,
        }),
      );
      registry.dispose();
      return { requests } as const;
    });

  /** The first stable mounted state, derived — never asserted — from the thread. */
  const mount = (thread: unknown = rehydratedThread()) => {
    const derived = deriveNavigatorExecution({
      environmentId: ENVIRONMENT,
      thread: thread as never,
      isServerThread: true,
      executionsByProposal: new Map(),
    });
    const facts = derived.facts;
    if (facts === null) throw new Error("expected a Navigator conversation");
    // The timeline card names the proposal it is attached to; the composer
    // names whatever the conversation's current plan is. Same resolver.
    const card = navigatorExecutionAvailability({
      facts,
      proposal: {
        id: MOUNT_PLAN,
        implementedAt: null,
        implementationThreadId: null,
        turnId: PLAN_TURN,
      },
    });
    const composer =
      derived.confirmableProposal === null
        ? null
        : navigatorExecutionAvailability({ facts, proposal: derived.confirmableProposal });
    return {
      facts,
      card,
      composer,
      confirmable: derived.confirmableProposal,
      route: routeNavigatorSend({
        text: "hagamos eso",
        hasAttachments: false,
        purpose: facts.purpose,
        isDurableThread: facts.threadId !== null,
        proposal: derived.confirmableProposal,
        availability: composer ?? { canExecute: false, blockedReason: "no-proposal" },
      }),
    } as const;
  };

  const refused = (code: string, data: unknown = null) =>
    new PeerLoopCommandRefusedError({ code, detail: "peer loop said no", data });

  beforeEach(() => {
    navigatorExecutionStore.reset();
  });

  effectIt.effect("mounts CONTROL_UNAVAILABLE actionable, with no provider turn first", () =>
    Effect.gen(function* () {
      yield* attempt(refused("CONTROL_UNAVAILABLE"));

      // Peer Loop's own answer, classified, on the path that carries it.
      const failure = navigatorExecutionStore.read(mountKey).failure;
      expect(failure?.presentation.code).toBe("CONTROL_UNAVAILABLE");
      expect(failure?.mayHaveStarted).toBe(false);
      expect(failure?.disposition).toBe("retryable");

      // No refresh, no regenerated proposal, no new turn: just the mount.
      const mounted = mount();
      expect(mounted.facts.unsettledTurnId).toBeNull();
      expect(mounted.card).toEqual({ canExecute: true, blockedReason: null });
      // The card and the composer agree, because it is one answer.
      expect(mounted.composer).toEqual(mounted.card);
      expect(mounted.route).toEqual({ kind: "execute", proposal: mounted.confirmable });
      navigatorExecutionStore.reset();
    }),
  );

  effectIt.effect("mounts PROJECT_HAS_UNFINISHED_RUN retryable, not already executed", () =>
    Effect.gen(function* () {
      yield* attempt(refused("PROJECT_HAS_UNFINISHED_RUN", { runId: "run-5" }));

      const failure = navigatorExecutionStore.read(mountKey).failure;
      // The other run is named and linkable, and it is not this proposal's.
      expect(failure?.inspectorRunId).toBe("run-5");
      expect(failure?.disposition).toBe("retryable");

      const mounted = mount();
      expect(mounted.card.blockedReason).not.toBe("already-executed");
      expect(mounted.card.canExecute).toBe(true);
      expect(mounted.route.kind).toBe("execute");
      navigatorExecutionStore.reset();
    }),
  );

  effectIt.effect("consumes the first `hagamos eso` as one execute request", () =>
    Effect.gen(function* () {
      yield* attempt(refused("CONTROL_UNAVAILABLE"));
      const mounted = mount();

      const execute = vi.fn(async () => null);
      const clearComposer = vi.fn();
      const consumed = yield* Effect.promise(() =>
        consumeNavigatorConfirmation({ route: mounted.route, clearComposer, execute }),
      );
      // Consumed as an action on the first submission: no provider send.
      expect(consumed).toBe(true);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(mounted.confirmable);
      expect(clearComposer).toHaveBeenCalledTimes(1);

      // And what reaches Peer Loop is one request, from the one gate.
      const second = yield* attempt(refused("CONTROL_UNAVAILABLE"));
      expect(second.requests).toEqual([{ threadId: MOUNT_THREAD, proposedPlanId: MOUNT_PLAN }]);
      navigatorExecutionStore.reset();
    }),
  );

  effectIt.effect("keeps an unknown outcome fail-closed and sends the phrase", () =>
    Effect.gen(function* () {
      // A dropped socket proves nothing about the server. Mounting does not
      // make that safe, and the words are not an override.
      yield* attempt(new Error("socket closed"));
      const failure = navigatorExecutionStore.read(mountKey).failure;
      expect(failure?.disposition).toBe("unknown");
      expect(failure?.mayHaveStarted).toBe(true);

      const mounted = mount();
      expect(mounted.card).toEqual({ canExecute: false, blockedReason: "outcome-unknown" });
      expect(mounted.route).toEqual({ kind: "send" });
      navigatorExecutionStore.reset();
    }),
  );

  effectIt.effect("keeps a may-have-applied timeout fail-closed", () =>
    Effect.gen(function* () {
      yield* attempt(
        new PeerLoopTimeoutError({
          method: "peer-loop/execute-proposal",
          timeoutMs: 30_000,
          mayHaveApplied: true,
        }),
      );
      const mounted = mount();
      expect(mounted.card.blockedReason).toBe("outcome-unknown");
      expect(mounted.route).toEqual({ kind: "send" });
      navigatorExecutionStore.reset();
    }),
  );

  it("still blocks a proposal whose own turn is producing it", () => {
    // The one thing a missing latest-turn pointer must never be confused with.
    const mounted = mount(
      rehydratedThread({
        latestTurn: {
          turnId: PLAN_TURN,
          state: "running",
          requestedAt: "2026-03-01T09:00:00.000Z",
          startedAt: "2026-03-01T09:00:00.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
        session: { status: "running", activeTurnId: PLAN_TURN },
      }),
    );
    expect(mounted.card).toEqual({ canExecute: false, blockedReason: "proposal-not-settled" });
    expect(mounted.confirmable).toBeNull();
    expect(mounted.route).toEqual({ kind: "send" });
  });

  it("still blocks a proposal that already has a run", () => {
    const derived = deriveNavigatorExecution({
      environmentId: ENVIRONMENT,
      thread: rehydratedThread(),
      isServerThread: true,
      executionsByProposal: new Map([
        [
          MOUNT_PLAN,
          [{ runId: "run-9", proposedPlanId: MOUNT_PLAN, createdAt: "2026-03-01T10:00:00.000Z" }],
        ],
      ]),
    });
    expect(
      navigatorExecutionAvailability({
        facts: derived.facts!,
        proposal: derived.confirmableProposal,
      }),
    ).toEqual({ canExecute: false, blockedReason: "already-executed" });
  });

  it("still blocks while this client's own request is outstanding", () => {
    navigatorExecutionStore.reset();
    const gate = deferred<AsyncResult.AsyncResult<PeerLoopExecuteProposalResult, unknown>>();
    void navigatorExecutionStore.execute(mountKey, { run: () => gate.promise });
    const mounted = mount();
    expect(mounted.card.blockedReason).toBe("executing");
    expect(mounted.route).toEqual({ kind: "send" });
    gate.resolve(AsyncResult.success(RESULT));
    navigatorExecutionStore.reset();
  });

  it("renders nothing executable for a coding conversation or a draft", () => {
    expect(
      deriveNavigatorExecution({
        environmentId: ENVIRONMENT,
        thread: rehydratedThread({ purpose: "coding" }),
        isServerThread: true,
        executionsByProposal: new Map(),
      }),
    ).toEqual({ facts: null, confirmableProposal: null });

    const draft = deriveNavigatorExecution({
      environmentId: ENVIRONMENT,
      thread: rehydratedThread(),
      isServerThread: false,
      executionsByProposal: new Map(),
    });
    expect(draft.confirmableProposal).toBeNull();
    expect(
      navigatorExecutionAvailability({
        facts: draft.facts!,
        proposal: {
          id: MOUNT_PLAN,
          implementedAt: null,
          implementationThreadId: null,
          turnId: PLAN_TURN,
        },
      }).blockedReason,
    ).toBe("draft-conversation");
  });
});
