/**
 * The proposal/run association, from the command that records it to the
 * snapshot a client reads — and back again after a rebuild.
 *
 * The table is history: one row saying which Peer Loop run a Navigator
 * Execution Proposal produced, and when. Peer Loop keeps the run itself, its
 * state, its outcome and its files; nothing here copies any of that, and
 * deleting a projected thread's rows deletes nothing of Peer Loop's.
 */
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "./Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PLAN_AT = "2026-01-01T00:01:00.000Z";
const LINKED_AT = "2026-01-01T00:02:00.000Z";
const PROJECT_ID = ProjectId.make("project-navigator");
const THREAD_ID = ThreadId.make("thread-navigator");
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

interface LinkRow {
  readonly runId: string;
  readonly threadId: string;
  readonly proposedPlanId: string;
  readonly createdAt: string;
}

const readLinkRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<LinkRow>`
    SELECT
      run_id AS "runId",
      thread_id AS "threadId",
      proposed_plan_id AS "proposedPlanId",
      created_at AS "createdAt"
    FROM projection_thread_peer_loop_executions
    ORDER BY created_at ASC, run_id ASC
  `;
});

const makeLayer = (prefix: string) =>
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(NodeServices.layer),
  );

/** Project, navigator thread and one execution proposal, ready to be linked. */
const seedNavigatorThread = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;

  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-project"),
    projectId: PROJECT_ID,
    title: "Navigator Project",
    workspaceRoot: "/tmp/project-navigator",
    defaultModelSelection: MODEL_SELECTION,
    createdAt: NOW,
  });

  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("cmd-thread"),
    threadId: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Navigator",
    purpose: "navigator",
    modelSelection: MODEL_SELECTION,
    runtimeMode: "approval-required",
    interactionMode: "plan",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
  });

  yield* engine.dispatch({
    type: "thread.proposed-plan.upsert",
    commandId: CommandId.make("cmd-plan"),
    threadId: THREAD_ID,
    proposedPlan: {
      id: "plan-1",
      turnId: null,
      planMarkdown: "# Execute this",
      implementedAt: null,
      implementationThreadId: null,
      createdAt: PLAN_AT,
      updatedAt: PLAN_AT,
    },
    createdAt: PLAN_AT,
  });
});

const link = (runId: string, proposedPlanId: string, createdAt: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    yield* engine.dispatch({
      type: "thread.peer-loop-execution.link",
      commandId: CommandId.make(`cmd-link-${runId}`),
      threadId: THREAD_ID,
      proposedPlanId,
      runId,
      createdAt,
    });
  });

it.layer(makeLayer("t3-peer-loop-link-visibility-"))(
  "peer loop execution link is visible the moment dispatch resolves",
  (it) => {
    /*
     * The fact the Navigator at-most-once guarantee is built on.
     *
     * `OrchestrationEngine.processEnvelope` appends the event, calls
     * `projectionPipeline.projectEvent` and writes the accepted receipt inside
     * ONE `sql.withTransaction`, and `dispatch` resolves only after that
     * transaction returns. So the SQL projection is not eventually behind a
     * dispatch the caller awaited — it is already current.
     *
     * Asserted with no polling, no sleeping, no worker drain and no projector
     * wait: the read is the statement after `dispatch`. If projection
     * application ever moved out of that transaction — onto a background
     * fiber, a queue, a separate commit — this test fails, and the execution
     * coordinator's serialized revalidation would be unsound.
     */
    it.effect("puts the exact link in getThreadDetailById with no wait of any kind", () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        yield* seedNavigatorThread;

        const before = yield* snapshotQuery.getThreadDetailById(THREAD_ID);
        assert.deepStrictEqual(
          Option.isSome(before) ? [...before.value.peerLoopExecutions] : null,
          [],
        );

        yield* link("run-1", "plan-1", LINKED_AT);

        const after = yield* snapshotQuery.getThreadDetailById(THREAD_ID);
        assert.deepStrictEqual(Option.isSome(after) ? [...after.value.peerLoopExecutions] : null, [
          { runId: "run-1", proposedPlanId: "plan-1", createdAt: LINKED_AT },
        ]);

        // The same is true of the raw projection row the query reads from.
        assert.deepStrictEqual(
          (yield* readLinkRows).map((row) => row.runId),
          ["run-1"],
        );
      }),
    );
  },
);

it.layer(makeLayer("t3-peer-loop-link-roundtrip-"))("peer loop execution link", (it) => {
  it.effect("round-trips from the event to the SQL row and both snapshots", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* seedNavigatorThread;
      yield* link("run-1", "plan-1", LINKED_AT);

      const rows = yield* readLinkRows;
      assert.deepStrictEqual(rows, [
        {
          runId: "run-1",
          threadId: "thread-navigator",
          proposedPlanId: "plan-1",
          createdAt: LINKED_AT,
        },
      ]);

      const expected = [{ runId: "run-1", proposedPlanId: "plan-1", createdAt: LINKED_AT }];

      const detail = yield* snapshotQuery.getThreadDetailById(THREAD_ID);
      assert.strictEqual(Option.isSome(detail), true);
      if (Option.isSome(detail)) {
        assert.deepStrictEqual([...detail.value.peerLoopExecutions], expected);
        // The plan's own implementation metadata is a different fact and stays
        // exactly as the plan was written.
        assert.deepStrictEqual(
          detail.value.proposedPlans.map((plan) => [
            plan.id,
            plan.implementedAt,
            plan.implementationThreadId,
          ]),
          [["plan-1", null, null]],
        );
      }

      const snapshot = yield* snapshotQuery.getSnapshot();
      const thread = snapshot.threads.find((entry) => entry.id === THREAD_ID);
      assert.deepStrictEqual(
        thread === undefined ? null : [...thread.peerLoopExecutions],
        expected,
      );

      // The decider reads this one, and its duplicate-run rule depends on the
      // links being loaded into it.
      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      const commandThread = commandReadModel.threads.find((entry) => entry.id === THREAD_ID);
      assert.deepStrictEqual(
        commandThread === undefined ? null : [...commandThread.peerLoopExecutions],
        expected,
      );
    }),
  );

  it.effect("refuses a second run for the same proposal through the engine", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(link("run-2", "plan-1", LINKED_AT));
      assert.strictEqual(result._tag, "Failure");

      const rows = yield* readLinkRows;
      assert.deepStrictEqual(
        rows.map((row) => row.runId),
        ["run-1"],
      );
    }),
  );
});

it.layer(makeLayer("t3-peer-loop-link-delete-"))("peer loop execution link cleanup", (it) => {
  it.effect("drops association rows with the thread and nothing else", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const sql = yield* SqlClient.SqlClient;

      yield* seedNavigatorThread;
      yield* link("run-1", "plan-1", LINKED_AT);
      assert.strictEqual((yield* readLinkRows).length, 1);

      yield* engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("cmd-delete"),
        threadId: THREAD_ID,
      });

      // No orphan association rows...
      assert.deepStrictEqual(yield* readLinkRows, []);

      // ...and nothing else was swept up with them. The thread row survives as
      // a soft delete exactly as it did before, and the proposed plan with it.
      const threadRows = yield* sql<{ readonly deletedAt: string | null }>`
        SELECT deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${THREAD_ID}
      `;
      assert.strictEqual(threadRows.length, 1);
      assert.notStrictEqual(threadRows[0]?.deletedAt, null);

      const planRows = yield* sql<{ readonly planId: string }>`
        SELECT plan_id AS "planId"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${THREAD_ID}
      `;
      assert.deepStrictEqual(
        planRows.map((row) => row.planId),
        ["plan-1"],
      );
    }),
  );
});

/* ------------------------------------------------------------- rebuild */

const eventBase = (sequence: number, commandId: string) => ({
  eventId: EventId.make(`evt-${sequence}`),
  aggregateKind: "thread" as const,
  aggregateId: THREAD_ID,
  occurredAt: NOW,
  commandId: CommandId.make(commandId),
  causationEventId: null,
  correlationId: CommandId.make(commandId),
  metadata: {},
});

it.layer(makeLayer("t3-peer-loop-link-rebuild-"))("peer loop execution link rebuild", (it) => {
  it.effect("recreates association rows from the event log alone", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;

      yield* eventStore.append({
        ...eventBase(1, "cmd-project"),
        aggregateKind: "project",
        aggregateId: PROJECT_ID,
        type: "project.created",
        payload: {
          projectId: PROJECT_ID,
          title: "Navigator Project",
          workspaceRoot: "/tmp/project-navigator",
          defaultModelSelection: null,
          scripts: [],
          createdAt: NOW,
          updatedAt: NOW,
        },
      } as unknown as Omit<OrchestrationEvent, "sequence">);

      yield* eventStore.append({
        ...eventBase(2, "cmd-thread"),
        type: "thread.created",
        payload: {
          threadId: THREAD_ID,
          projectId: PROJECT_ID,
          title: "Navigator",
          purpose: "navigator",
          modelSelection: MODEL_SELECTION,
          runtimeMode: "approval-required",
          interactionMode: "plan",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      } as unknown as Omit<OrchestrationEvent, "sequence">);

      yield* eventStore.append({
        ...eventBase(3, "cmd-link"),
        type: "thread.peer-loop-execution-linked",
        payload: {
          threadId: THREAD_ID,
          proposedPlanId: "plan-1",
          runId: "run-1",
          createdAt: LINKED_AT,
        },
      } as unknown as Omit<OrchestrationEvent, "sequence">);

      // A rebuild replays every event through every projector. The link's
      // insert has to be conflict-tolerant or a second bootstrap would fail.
      yield* projectionPipeline.bootstrap;
      yield* projectionPipeline.bootstrap;

      assert.deepStrictEqual(yield* readLinkRows, [
        {
          runId: "run-1",
          threadId: "thread-navigator",
          proposedPlanId: "plan-1",
          createdAt: LINKED_AT,
        },
      ]);
    }),
  );
});
