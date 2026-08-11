/**
 * Executing an agreed Navigator proposal, against fakes only.
 *
 * Every dependency here is injected: a recording Peer Loop, a dispatch that
 * records commands, and a projected thread view.
 *
 * THE FAKE DISPATCH MIRRORS THE REAL TRANSACTION. In
 * `OrchestrationEngine.processEnvelope`, appending the event, applying every
 * SQL projector and writing the accepted receipt all happen inside one
 * `sql.withTransaction`, and `dispatch` resolves only after that transaction
 * returns. So the fake updates the projected view *before* it answers. Doing it
 * afterwards would model a system this repository does not have, and the
 * at-most-once tests would then be asserting against fiction.
 *
 * That transactional visibility is what makes serialized revalidation against
 * `ProjectionSnapshotQuery` sound, and it is proved separately against the real
 * engine and real SQL in `peerLoopExecutionLink.projection.test.ts`.
 *
 * No bridge is spawned, no agent runs, and nothing is billed.
 */
import {
  PeerLoopCommandRefusedError,
  PeerLoopExecutionCoordinationError,
  PeerLoopTimeoutError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationProposedPlan,
  type OrchestrationThread,
  type PeerLoopExecuteProposalInput,
  type PeerLoopStartResult,
  type PeerLoopStartRunInput,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { executionGateKey, make, PeerLoopExecutionCoordinator } from "./ExecutionCoordinator.ts";
import { PeerLoopService } from "./Service.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-navigator");
const WORKSPACE_ROOT = "/repos/demo";
const PLAN_MARKDOWN = "# Agreed plan\n\n1. Do the thing.\n2. Then stop.";
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} as const;

const plan = (overrides: Partial<OrchestrationProposedPlan> = {}): OrchestrationProposedPlan => ({
  id: "plan-1",
  turnId: null,
  planMarkdown: PLAN_MARKDOWN,
  implementedAt: null,
  implementationThreadId: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const navigatorThread = (overrides: Partial<OrchestrationThread> = {}): OrchestrationThread => ({
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Navigator",
  purpose: "navigator",
  modelSelection: MODEL_SELECTION,
  runtimeMode: "approval-required",
  interactionMode: "plan",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [plan()],
  peerLoopExecutions: [],
  activities: [],
  checkpoints: [],
  session: null,
  ...overrides,
});

const projectShell: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "Demo",
  workspaceRoot: WORKSPACE_ROOT,
  defaultModelSelection: MODEL_SELECTION,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
};

const startResult = (runId: string): PeerLoopStartResult =>
  ({
    runId,
    projectPath: WORKSPACE_ROOT,
    awaitingOwnerObjective: false,
    eventHighWaterMark: 0,
    replayFromSeq: 0,
    live: true,
    control: {
      available: true,
      reason: "live_in_this_bridge",
      liveWriter: null,
      resumable: false,
    },
    state: {
      schemaVersion: 1,
      runId,
      projectPath: WORKSPACE_ROOT,
      state: "reviewer_working",
      iteration: 0,
      createdAt: NOW,
      updatedAt: NOW,
      ownerPolicyText: "OWNER POLICY",
      builderSessionId: null,
      reviewerThreadId: null,
      repo: null,
      lastBuilderTask: null,
      lastBuilderReport: null,
      lastReviewerDecision: null,
      queuedOwnerMessages: [],
      inFlight: null,
      haltReason: null,
      stopRequested: false,
      adapters: {
        reviewer: "codex",
        reviewerVersion: null,
        builder: "claude-code",
        builderVersion: null,
      },
      safetyLimit: null,
      lastSequence: 0,
    },
  }) as PeerLoopStartResult;

const EXECUTE: PeerLoopExecuteProposalInput = { threadId: THREAD_ID, proposedPlanId: "plan-1" };

/* --------------------------------------------------------------- harness */

interface Recorder {
  readonly startCalls: Ref.Ref<ReadonlyArray<PeerLoopStartRunInput>>;
  readonly dispatched: Ref.Ref<ReadonlyArray<OrchestrationCommand>>;
  /**
   * The projected thread view, written by a successful dispatch before it
   * resolves — exactly as the real transaction does.
   */
  readonly projected: Ref.Ref<ReadonlyArray<OrchestrationThread>>;
}

interface HarnessOptions {
  readonly threads?: ReadonlyArray<OrchestrationThread>;
  readonly project?: OrchestrationProjectShell | null;
  /** Peer Loop's answer to the nth start call. Defaults to a fresh run id. */
  readonly startRun?: (
    input: PeerLoopStartRunInput,
    attempt: number,
  ) => Effect.Effect<PeerLoopStartResult, PeerLoopTimeoutError | PeerLoopCommandRefusedError>;
  /** Whether the link command dispatch succeeds. Defaults to yes. */
  readonly dispatchSucceeds?: boolean;
  /**
   * Applied when a link command dispatches successfully: the projection the
   * next read will see. Defaults to actually recording the link, as the real
   * projector would.
   */
  readonly applyLink?: boolean;
  /** Projection reads fail. */
  readonly readFails?: boolean;
  /**
   * Hold `startRun` open until this is completed.
   *
   * Without it a request can run start-to-finish without ever yielding, so a
   * "concurrent" test would pass with no serialization at all. Blocking inside
   * the critical section is what forces the second request to prove it waited.
   */
  readonly startGate?: Deferred.Deferred<void>;
}

const makeHarness = Effect.fn("makeHarness")(function* (options: HarnessOptions = {}) {
  const recorder: Recorder = {
    startCalls: yield* Ref.make<ReadonlyArray<PeerLoopStartRunInput>>([]),
    dispatched: yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]),
    projected: yield* Ref.make<ReadonlyArray<OrchestrationThread>>(
      options.threads ?? [navigatorThread()],
    ),
  };

  const findThread = (threads: ReadonlyArray<OrchestrationThread>, threadId: string) => {
    const found = threads.find((thread) => thread.id === threadId);
    return found === undefined ? Option.none<OrchestrationThread>() : Option.some(found);
  };

  /** Record the link on one view. The real projector does exactly this. */
  const withLink = (
    threads: ReadonlyArray<OrchestrationThread>,
    command: Extract<OrchestrationCommand, { type: "thread.peer-loop-execution.link" }>,
  ): ReadonlyArray<OrchestrationThread> =>
    threads.map((thread) =>
      thread.id === command.threadId
        ? {
            ...thread,
            peerLoopExecutions: [
              ...thread.peerLoopExecutions,
              {
                runId: command.runId,
                proposedPlanId: command.proposedPlanId,
                createdAt: command.createdAt,
              },
            ],
          }
        : thread,
    );

  const peerLoopLayer = Layer.mock(PeerLoopService)({
    startRun: (input: PeerLoopStartRunInput) =>
      Ref.modify(recorder.startCalls, (calls) => [calls.length, [...calls, input]] as const).pipe(
        Effect.tap(() =>
          options.startGate === undefined ? Effect.void : Deferred.await(options.startGate),
        ),
        Effect.flatMap((attempt) =>
          options.startRun === undefined
            ? Effect.succeed(startResult(`run-${attempt + 1}`))
            : options.startRun(input, attempt),
        ),
      ),
    status: () => Effect.die("unused"),
    listRuns: () => Effect.die("unused"),
    attachRun: () => Effect.die("unused"),
    resumeRun: () => Effect.die("unused"),
    sendOwnerMessage: () => Effect.die("unused"),
    pauseRun: () => Effect.die("unused"),
    recoverRun: () => Effect.die("unused"),
    subscribeEvents: () => Stream.empty,
    diagnostics: Effect.succeed([]),
  });

  const snapshotLayer = Layer.mock(ProjectionSnapshotQuery)({
    getThreadDetailById: (threadId) =>
      options.readFails === true
        ? Effect.fail(new Error("projection unavailable") as never)
        : (Ref.get(recorder.projected).pipe(
            Effect.map((threads) => findThread(threads, threadId)),
          ) as never),
    getProjectShellById: () =>
      Effect.succeed(
        options.project === null ? Option.none() : Option.some(options.project ?? projectShell),
      ) as never,
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.die("unused"),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
    getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
    getThreadCheckpointContext: () => Effect.die("unused"),
    getFullThreadDiffContext: () => Effect.die("unused"),
    getThreadShellById: () => Effect.die("unused"),
    getThreadDetailSnapshot: () => Effect.die("unused"),
    searchThreads: () => Effect.die("unused"),
  });

  const engineLayer = Layer.mock(OrchestrationEngineService)({
    /*
     * Event append and SQL projection are one transaction in the real engine,
     * and `dispatch` resolves after it returns. So the projected view is
     * updated BEFORE this answers. Moving that update after the answer would
     * model a system this repository does not have — and would break the
     * concurrency test, which is the point.
     */
    dispatch: (command: OrchestrationCommand) =>
      Effect.gen(function* () {
        yield* Ref.update(recorder.dispatched, (all) => [...all, command]);
        const isLink = command.type === "thread.peer-loop-execution.link";
        const dispatchFails = options.dispatchSucceeds === false;

        // `applyLink` is the case where the transaction committed and only the
        // answer was lost, so the projection is written either way when set.
        if (isLink && (!dispatchFails || options.applyLink === true)) {
          yield* Ref.update(recorder.projected, (threads) => withLink(threads, command));
        }

        if (dispatchFails) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "dispatch queue rejected the command",
          });
        }
        return { sequence: 1 };
      }) as never,
    readEvents: () => Stream.empty,
    streamDomainEvents: Stream.empty,
    latestSequence: Effect.succeed(0),
  } as never);

  const coordinator = yield* make().pipe(
    Effect.provide(Layer.mergeAll(peerLoopLayer, snapshotLayer, engineLayer)),
  );

  return { coordinator, recorder };
});

const linkCommands = (recorder: Recorder) =>
  Ref.get(recorder.dispatched).pipe(
    Effect.map((all) =>
      all.filter((command) => command.type === "thread.peer-loop-execution.link"),
    ),
  );

const isCoordinationError = Schema.is(PeerLoopExecutionCoordinationError);

/* ----------------------------------------------------------------- tests */

it.layer(NodeServices.layer)("peer loop execution coordinator: the happy path", (it) => {
  it.effect("sends the agreed plan and the project's own root as one start call", () =>
    Effect.gen(function* () {
      const { coordinator, recorder } = yield* makeHarness();

      const result = yield* coordinator.executeProposal(EXECUTE);

      const calls = yield* Ref.get(recorder.startCalls);
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0], {
        projectPath: WORKSPACE_ROOT,
        objective: PLAN_MARKDOWN,
      });
      // `newRun` bypasses Peer Loop's duplicate-run preflight and is never ours
      // to send; no safety limit was asked for, so none is invented.
      assert.strictEqual(Object.hasOwn(calls[0] ?? {}, "newRun"), false);
      assert.strictEqual(Object.hasOwn(calls[0] ?? {}, "safetyLimit"), false);

      assert.strictEqual(result.run.runId, "run-1");
      assert.strictEqual(result.execution.runId, "run-1");
      assert.strictEqual(result.execution.proposedPlanId, "plan-1");
    }),
  );

  it.effect("forwards an explicit safety limit untouched", () =>
    Effect.gen(function* () {
      const { coordinator, recorder } = yield* makeHarness();
      yield* coordinator.executeProposal({ ...EXECUTE, safetyLimit: 7 });

      const calls = yield* Ref.get(recorder.startCalls);
      assert.deepStrictEqual(calls[0], {
        projectPath: WORKSPACE_ROOT,
        objective: PLAN_MARKDOWN,
        safetyLimit: 7,
      });
    }),
  );

  it.effect("records exactly one link command for the run Peer Loop returned", () =>
    Effect.gen(function* () {
      const { coordinator, recorder } = yield* makeHarness();
      const result = yield* coordinator.executeProposal(EXECUTE);

      const links = yield* linkCommands(recorder);
      assert.strictEqual(links.length, 1);
      const link = links[0];
      assert.strictEqual(link?.type, "thread.peer-loop-execution.link");
      if (link?.type === "thread.peer-loop-execution.link") {
        assert.strictEqual(link.threadId, THREAD_ID);
        assert.strictEqual(link.proposedPlanId, "plan-1");
        assert.strictEqual(link.runId, "run-1");
        // Server-generated, not client-supplied.
        assert.ok(link.commandId.startsWith("server:peer-loop-execute:"));
        assert.strictEqual(link.createdAt, result.execution.createdAt);
      }
    }),
  );

  it.effect("leaves no serialization gate behind", () =>
    Effect.gen(function* () {
      const { coordinator } = yield* makeHarness();
      yield* coordinator.executeProposal(EXECUTE);
      assert.strictEqual(yield* coordinator.pendingExecutionGateCount, 0);
    }),
  );
});

it.layer(NodeServices.layer)("peer loop execution coordinator: refused before start", (it) => {
  const expectNoStart = Effect.fn("expectNoStart")(function* (
    options: HarnessOptions,
    input: PeerLoopExecuteProposalInput,
    reason: string,
  ) {
    const { coordinator, recorder } = yield* makeHarness(options);
    const error = yield* Effect.flip(coordinator.executeProposal(input));

    assert.ok(isCoordinationError(error), "expected a typed coordination error");
    if (isCoordinationError(error)) {
      assert.strictEqual(error.reason, reason);
      // Nothing was started, and the error says so rather than leaving it open.
      assert.strictEqual(error.mayHaveStarted, false);
      assert.ok(error.detail.includes("Nothing was started"));
    }
    assert.deepStrictEqual(yield* Ref.get(recorder.startCalls), []);
    assert.deepStrictEqual(yield* linkCommands(recorder), []);
    return error;
  });

  it.effect("refuses a thread that is not there", () =>
    expectNoStart({ threads: [] }, EXECUTE, "navigator-thread-not-found"),
  );

  it.effect("refuses a coding thread", () =>
    expectNoStart(
      { threads: [navigatorThread({ purpose: "coding", interactionMode: "default" })] },
      EXECUTE,
      "not-a-navigator-thread",
    ),
  );

  it.effect("refuses a proposal that is not on the thread", () =>
    expectNoStart({}, { ...EXECUTE, proposedPlanId: "plan-missing" }, "proposal-not-found"),
  );

  it.effect("refuses a proposal that already has a run, and names it", () =>
    Effect.gen(function* () {
      const error = yield* expectNoStart(
        {
          threads: [
            navigatorThread({
              peerLoopExecutions: [
                { runId: "run-existing", proposedPlanId: "plan-1", createdAt: NOW },
              ],
            }),
          ],
        },
        EXECUTE,
        "proposal-already-executed",
      );
      // The run id travels so the client can open that run rather than guess.
      assert.strictEqual(isCoordinationError(error) ? error.runId : null, "run-existing");
    }),
  );

  it.effect("refuses a proposal a coding thread already implemented", () =>
    expectNoStart(
      {
        threads: [
          navigatorThread({
            proposedPlans: [
              plan({
                implementedAt: NOW,
                implementationThreadId: ThreadId.make("thread-implementation"),
              }),
            ],
          }),
        ],
      },
      EXECUTE,
      "proposal-already-implemented",
    ),
  );

  it.effect("refuses when the project is gone", () =>
    expectNoStart({ project: null }, EXECUTE, "project-not-found"),
  );

  it.effect("refuses, without detail, when the projection cannot be read", () =>
    Effect.gen(function* () {
      const error = yield* expectNoStart({ readFails: true }, EXECUTE, "coordination-failed");
      if (isCoordinationError(error)) {
        // Sanitized: no SQL, no stack, no path.
        assert.strictEqual(error.detail.includes("projection unavailable"), false);
        assert.strictEqual(error.detail.includes(WORKSPACE_ROOT), false);
      }
    }),
  );
});

it.layer(NodeServices.layer)("peer loop execution coordinator: Peer Loop's own answers", (it) => {
  it.effect("passes a duplicate-run refusal through with its code intact", () =>
    Effect.gen(function* () {
      const { coordinator, recorder } = yield* makeHarness({
        startRun: () =>
          Effect.fail(
            new PeerLoopCommandRefusedError({
              code: "PROJECT_HAS_UNFINISHED_RUN",
              detail: "already running",
              data: { runId: "run-other" },
            }),
          ),
      });

      const error = yield* Effect.flip(coordinator.executeProposal(EXECUTE));
      assert.strictEqual(error._tag, "PeerLoopCommandRefusedError");
      assert.strictEqual(
        error._tag === "PeerLoopCommandRefusedError" ? error.code : null,
        "PROJECT_HAS_UNFINISHED_RUN",
      );
      // A refused start produced no run, so there is nothing to link.
      assert.deepStrictEqual(yield* linkCommands(recorder), []);
    }),
  );

  it.effect("never retries a timed-out start", () =>
    Effect.gen(function* () {
      const { coordinator, recorder } = yield* makeHarness({
        startRun: () =>
          Effect.fail(
            new PeerLoopTimeoutError({
              method: "run.start",
              timeoutMs: 30_000,
              mayHaveApplied: true,
            }),
          ),
      });

      const error = yield* Effect.flip(coordinator.executeProposal(EXECUTE));
      assert.strictEqual(error._tag, "PeerLoopTimeoutError");
      // `mayHaveApplied` survives: Peer Loop may already have started the run,
      // which is exactly why nothing here tries again.
      assert.strictEqual(error._tag === "PeerLoopTimeoutError" ? error.mayHaveApplied : null, true);
      assert.strictEqual((yield* Ref.get(recorder.startCalls)).length, 1);
      assert.deepStrictEqual(yield* linkCommands(recorder), []);
    }),
  );
});

it.layer(NodeServices.layer)("peer loop execution coordinator: partial failure", (it) => {
  it.effect("treats a lost dispatch answer as success when the link is durably there", () =>
    Effect.gen(function* () {
      const { coordinator, recorder } = yield* makeHarness({
        dispatchSucceeds: false,
        applyLink: true,
      });

      const result = yield* coordinator.executeProposal(EXECUTE);
      assert.strictEqual(result.run.runId, "run-1");
      assert.deepStrictEqual(result.execution, {
        runId: "run-1",
        proposedPlanId: "plan-1",
        createdAt: result.execution.createdAt,
      });
      // One start, one link attempt. The re-read is a read.
      assert.strictEqual((yield* Ref.get(recorder.startCalls)).length, 1);
      assert.strictEqual((yield* linkCommands(recorder)).length, 1);
    }),
  );

  it.effect("reports an unconfirmed link with the run id and does not start again", () =>
    Effect.gen(function* () {
      const { coordinator, recorder } = yield* makeHarness({
        dispatchSucceeds: false,
        applyLink: false,
      });

      const error = yield* Effect.flip(coordinator.executeProposal(EXECUTE));
      assert.ok(isCoordinationError(error));
      if (isCoordinationError(error)) {
        assert.strictEqual(error.reason, "link-not-confirmed");
        assert.strictEqual(error.runId, "run-1");
        // The one case where a run may exist. Recovery is deliberate: the
        // client opens that run, nothing here resumes or recovers it.
        assert.strictEqual(error.mayHaveStarted, true);
      }
      assert.strictEqual((yield* Ref.get(recorder.startCalls)).length, 1);
      assert.strictEqual((yield* linkCommands(recorder)).length, 1);
    }),
  );
});

it.layer(NodeServices.layer)("peer loop execution coordinator: concurrency", (it) => {
  it.effect("two simultaneous requests for one proposal start exactly one run", () =>
    Effect.gen(function* () {
      const startGate = yield* Deferred.make<void>();
      const { coordinator, recorder } = yield* makeHarness({ startGate });

      /*
       * Hold the first request inside `startRun` and watch what the second one
       * does. Without this the first request could run to completion before
       * the second even began, and the test would pass with the serialization
       * removed — it was written that way first, and it did.
       */
      const observeWhileHeld = Effect.gen(function* () {
        // Cooperative yields rather than sleeps: `it.effect` runs on a test
        // clock, so a sleep would never come back.
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if ((yield* Ref.get(recorder.startCalls)).length >= 1) break;
          yield* Effect.yieldNow;
        }
        // Every chance for a second start to slip through, if one could.
        for (let attempt = 0; attempt < 200; attempt += 1) yield* Effect.yieldNow;
        const heldCalls = (yield* Ref.get(recorder.startCalls)).length;
        yield* Deferred.succeed(startGate, undefined);
        return heldCalls;
      });

      const [firstResult, secondResult, callsWhileHeld] = yield* Effect.all(
        [
          Effect.result(coordinator.executeProposal(EXECUTE)),
          Effect.result(coordinator.executeProposal(EXECUTE)),
          observeWhileHeld,
        ],
        { concurrency: "unbounded" },
      );

      // The second request never reached Peer Loop while the first held the
      // gate. This is the assertion the whole test exists for.
      assert.strictEqual(callsWhileHeld, 1);

      const results = [firstResult, secondResult];

      const successes = results.filter((result) => result._tag === "Success");
      const failures = results.filter((result) => result._tag === "Failure");
      assert.strictEqual(successes.length, 1);
      assert.strictEqual(failures.length, 1);

      // The decisive assertion: one start call and one link, whichever request
      // got there first.
      assert.strictEqual((yield* Ref.get(recorder.startCalls)).length, 1);
      assert.strictEqual((yield* linkCommands(recorder)).length, 1);

      // The loser is told the proposal is already executed, not handed a
      // second run.
      const loser = failures[0]?.failure;
      assert.ok(loser !== undefined && isCoordinationError(loser));
      if (loser !== undefined && isCoordinationError(loser)) {
        assert.strictEqual(loser.reason, "proposal-already-executed");
        assert.strictEqual(loser.mayHaveStarted, false);
      }

      /*
       * And the projection the loser revalidated against already held the link
       * the winner recorded, because the fake dispatch wrote it before
       * answering — as the real transaction does. Delay that write until after
       * dispatch resolves and this test starts seeing two runs.
       */
      const projectedThread = (yield* Ref.get(recorder.projected)).find(
        (thread) => thread.id === THREAD_ID,
      );
      assert.deepStrictEqual(
        projectedThread?.peerLoopExecutions.map((entry) => entry.runId),
        ["run-1"],
      );

      assert.strictEqual(yield* coordinator.pendingExecutionGateCount, 0);
    }),
  );

  it.effect("refuses a second Execute issued immediately after the first resolves", () =>
    Effect.gen(function* () {
      // No barrier: the second request arrives the statement after the first
      // returned. Nothing drained a worker and nothing awaited a projector, and
      // it must still be refused — which is exactly the promise that dispatch
      // being transactional with its projection makes.
      const { coordinator, recorder } = yield* makeHarness();

      const first = yield* coordinator.executeProposal(EXECUTE);
      assert.strictEqual(first.run.runId, "run-1");

      const error = yield* Effect.flip(coordinator.executeProposal(EXECUTE));
      assert.ok(isCoordinationError(error));
      if (isCoordinationError(error)) {
        assert.strictEqual(error.reason, "proposal-already-executed");
        // And it names the run the first request started, so the client can
        // open it rather than press again.
        assert.strictEqual(error.runId, "run-1");
      }

      assert.strictEqual((yield* Ref.get(recorder.startCalls)).length, 1);
      assert.strictEqual((yield* linkCommands(recorder)).length, 1);
    }),
  );

  it.effect("does not serialize two different proposals behind each other", () =>
    Effect.gen(function* () {
      const { coordinator, recorder } = yield* makeHarness({
        threads: [navigatorThread({ proposedPlans: [plan(), plan({ id: "plan-2" })] })],
      });

      yield* Effect.all(
        [
          coordinator.executeProposal(EXECUTE),
          coordinator.executeProposal({ ...EXECUTE, proposedPlanId: "plan-2" }),
        ],
        { concurrency: 2 },
      );

      assert.strictEqual((yield* Ref.get(recorder.startCalls)).length, 2);
      assert.strictEqual((yield* linkCommands(recorder)).length, 2);
      assert.strictEqual(yield* coordinator.pendingExecutionGateCount, 0);
    }),
  );
});

it.layer(NodeServices.layer)("peer loop execution gate keys", (it) => {
  it.effect("cannot collide two different proposals onto one gate", () =>
    Effect.sync(() => {
      // A separator-joined key would map both of these to the same string, and
      // the failure would be silent: one proposal's gate serializing another's
      // execution, or worse, two presses on one proposal landing on different
      // gates and serializing against nothing.
      assert.notStrictEqual(
        executionGateKey("thread:1", "plan"),
        executionGateKey("thread", "1:plan"),
      );
      assert.notStrictEqual(executionGateKey("a", "bc"), executionGateKey("ab", "c"));
      assert.notStrictEqual(executionGateKey("", "ab"), executionGateKey("a", "b"));
      // Same pair, same key: the property the gate actually relies on.
      assert.strictEqual(
        executionGateKey("thread-1", "plan-1"),
        executionGateKey("thread-1", "plan-1"),
      );
    }),
  );
});

/* The service tag is what the WS layer resolves; keep it constructible. */
it.layer(NodeServices.layer)("peer loop execution coordinator: wiring", (it) => {
  it.effect("exposes the coordinator under its service tag", () =>
    Effect.gen(function* () {
      const { coordinator } = yield* makeHarness();
      const provided = yield* Effect.service(PeerLoopExecutionCoordinator).pipe(
        Effect.provide(Layer.succeed(PeerLoopExecutionCoordinator)(coordinator)),
      );
      assert.strictEqual(typeof provided.executeProposal, "function");
    }),
  );
});
