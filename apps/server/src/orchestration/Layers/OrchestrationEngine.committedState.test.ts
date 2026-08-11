/**
 * The engine's committed-state accessors, against the real engine.
 *
 * `getThreadById` and `getProjectById` exist to answer one question honestly:
 * "has this already happened?" — for a caller that just awaited a dispatch, or
 * for a server that just started up. Both halves are asserted here against the
 * real engine over a real (in-memory) database, because a mock could not tell
 * the difference between the committed read model and the SQL projection, and
 * the difference is the entire reason these methods exist.
 *
 * No deferred waits, no sleeps, no polling: the assertions are made on the
 * statement after `dispatch` resolves. If the read model were advanced later
 * than that, they would fail.
 */
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-navigator");
const THREAD_ID = ThreadId.make("thread-navigator");
const WORKSPACE_ROOT = "/tmp/project-navigator";
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

/**
 * The engine, over whatever SQL client is ambient.
 *
 * Built inside a test rather than by `it.layer` so a second engine can be
 * started over the *same* database — which is how "restored from replay" is
 * observable at all.
 */
const engineLayer = OrchestrationEngineLive.pipe(
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(OrchestrationProjectionPipelineLive),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
);

const withEngine = <A, E>(program: Effect.Effect<A, E, OrchestrationEngineService>) =>
  Effect.scoped(Effect.provide(program, Layer.fresh(engineLayer)));

const seed = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;

  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-project"),
    projectId: PROJECT_ID,
    title: "Navigator Project",
    workspaceRoot: WORKSPACE_ROOT,
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
      createdAt: NOW,
      updatedAt: NOW,
    },
    createdAt: NOW,
  });
});

const links = (thread: Option.Option<OrchestrationThread>) =>
  Option.isNone(thread) ? null : thread.value.peerLoopExecutions.map((entry) => entry.runId);

const layer = it.layer(
  SqlitePersistenceMemory.pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-engine-committed-state-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("orchestration engine committed state", (it) => {
  it.effect("sees a link on the statement after dispatch resolves", () =>
    withEngine(
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        yield* seed;

        const before = yield* engine.getThreadById(THREAD_ID);
        assert.deepStrictEqual(links(before), []);

        yield* engine.dispatch({
          type: "thread.peer-loop-execution.link",
          commandId: CommandId.make("cmd-link"),
          threadId: THREAD_ID,
          proposedPlanId: "plan-1",
          runId: "run-1",
          createdAt: NOW,
        });

        // No await on a projector, no retry loop, no sleep. The very next read
        // must already show it, or the at-most-once guarantee built on this
        // accessor is not a guarantee.
        const after = yield* engine.getThreadById(THREAD_ID);
        assert.deepStrictEqual(links(after), ["run-1"]);
      }),
    ),
  );

  it.effect("sees the whole thread, including purpose and proposals", () =>
    withEngine(
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        yield* seed;

        const thread = yield* engine.getThreadById(THREAD_ID);
        assert.strictEqual(Option.isSome(thread), true);
        if (Option.isSome(thread)) {
          // Everything the execution coordinator validates against.
          assert.strictEqual(thread.value.purpose, "navigator");
          assert.strictEqual(thread.value.deletedAt, null);
          assert.deepStrictEqual(
            thread.value.proposedPlans.map((plan) => [
              plan.id,
              plan.implementedAt,
              plan.implementationThreadId,
            ]),
            [["plan-1", null, null]],
          );
        }

        const project = yield* engine.getProjectById(PROJECT_ID);
        assert.strictEqual(
          Option.isSome(project) ? project.value.workspaceRoot : null,
          WORKSPACE_ROOT,
        );
      }),
    ),
  );

  it.effect("answers none for ids it has never seen", () =>
    withEngine(
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        yield* seed;
        assert.strictEqual(Option.isNone(yield* engine.getThreadById(ThreadId.make("nope"))), true);
        assert.strictEqual(
          Option.isNone(yield* engine.getProjectById(ProjectId.make("nope"))),
          true,
        );
      }),
    ),
  );

  it.effect("restores committed state on a fresh engine over the same database", () =>
    Effect.gen(function* () {
      // One engine writes; it goes away; a second one starts over the same
      // database and must know everything the first committed. That is the
      // startup path — an Execute arriving one second after a restart has to
      // be refused exactly as it would have been before.
      yield* withEngine(
        Effect.gen(function* () {
          const engine = yield* OrchestrationEngineService;
          yield* seed;
          yield* engine.dispatch({
            type: "thread.peer-loop-execution.link",
            commandId: CommandId.make("cmd-link"),
            threadId: THREAD_ID,
            proposedPlanId: "plan-1",
            runId: "run-1",
            createdAt: NOW,
          });
        }),
      );

      // Sanity: the durable record is really there, so a failure below is
      // about replay rather than about nothing having been written.
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly runId: string }>`
        SELECT run_id AS "runId" FROM projection_thread_peer_loop_executions
      `;
      assert.deepStrictEqual(
        rows.map((row) => row.runId),
        ["run-1"],
      );

      yield* withEngine(
        Effect.gen(function* () {
          const engine = yield* OrchestrationEngineService;
          const thread = yield* engine.getThreadById(THREAD_ID);
          assert.deepStrictEqual(links(thread), ["run-1"]);
          assert.strictEqual(Option.isSome(thread) ? thread.value.purpose : null, "navigator");

          const project = yield* engine.getProjectById(PROJECT_ID);
          assert.strictEqual(
            Option.isSome(project) ? project.value.workspaceRoot : null,
            WORKSPACE_ROOT,
          );
        }),
      );
    }),
  );
});
