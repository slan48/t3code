/**
 * `purpose` from the command that created a thread to the snapshot a client reads.
 *
 * The path has five hops and each one used to know nothing about a thread's
 * purpose: the decider, the event, the in-memory projector, the SQL projection
 * and the snapshot queries. A field that survives four of them and is dropped
 * on the fifth reads as `coding` on the client, which is precisely the mistake
 * the Navigator invariants exist to prevent.
 *
 * There is no second Navigator table here on purpose. A Navigator conversation
 * is an ordinary durable thread with different metadata.
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
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-navigator");
const NAVIGATOR_THREAD_ID = ThreadId.make("thread-navigator");
const CODING_THREAD_ID = ThreadId.make("thread-coding");
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

const layer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(ProjectionThreadRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-navigator-purpose-" })),
    Layer.provideMerge(NodeServices.layer),
  ),
);

layer("navigator thread purpose end to end", (it) => {
  it.effect("survives decider, event, SQL projection, repository and both snapshots", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const threadRepository = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;

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
        commandId: CommandId.make("cmd-thread-navigator"),
        threadId: NAVIGATOR_THREAD_ID,
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
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-coding"),
        threadId: CODING_THREAD_ID,
        projectId: PROJECT_ID,
        title: "Coding",
        purpose: "coding",
        modelSelection: MODEL_SELECTION,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
      });

      // 1. The durable projection column.
      const rows = yield* sql<{ readonly threadId: string; readonly purpose: string }>`
        SELECT thread_id AS "threadId", purpose
        FROM projection_threads
        ORDER BY thread_id ASC
      `;
      assert.deepStrictEqual(
        rows.map((row) => [row.threadId, row.purpose]),
        [
          ["thread-coding", "coding"],
          ["thread-navigator", "navigator"],
        ],
      );

      // 2. Repository read and list, which is what every other projector uses
      //    when it has to re-upsert a row it did not create.
      const read = yield* threadRepository.getById({ threadId: NAVIGATOR_THREAD_ID });
      assert.strictEqual(Option.isSome(read), true);
      assert.strictEqual(Option.isSome(read) ? read.value.purpose : null, "navigator");

      const listed = yield* threadRepository.listByProjectId({ projectId: PROJECT_ID });
      assert.deepStrictEqual(
        listed.map((row) => [row.threadId, row.purpose]),
        [
          ["thread-navigator", "navigator"],
          ["thread-coding", "coding"],
        ].sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
      );

      // 3. A repository round-trip that changes something else must not lose it.
      if (Option.isSome(read)) {
        yield* threadRepository.upsert({ ...read.value, title: "Navigator renamed" });
      }
      const reread = yield* threadRepository.getById({ threadId: NAVIGATOR_THREAD_ID });
      assert.strictEqual(Option.isSome(reread) ? reread.value.purpose : null, "navigator");
      assert.strictEqual(Option.isSome(reread) ? reread.value.title : null, "Navigator renamed");

      // 4. Every snapshot a client can be served.
      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepStrictEqual(
        shellSnapshot.threads
          .map((thread) => [String(thread.id), String(thread.purpose)])
          .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
        [
          ["thread-coding", "coding"],
          ["thread-navigator", "navigator"],
        ],
      );

      const threadShell = yield* snapshotQuery.getThreadShellById(NAVIGATOR_THREAD_ID);
      assert.strictEqual(
        Option.isSome(threadShell) ? threadShell.value.purpose : null,
        "navigator",
      );

      const detail = yield* snapshotQuery.getThreadDetailById(NAVIGATOR_THREAD_ID);
      assert.strictEqual(Option.isSome(detail) ? detail.value.purpose : null, "navigator");

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      const navigatorInFull = fullSnapshot.threads.find(
        (thread) => thread.id === NAVIGATOR_THREAD_ID,
      );
      assert.strictEqual(navigatorInFull?.purpose, "navigator");
      assert.strictEqual(
        fullSnapshot.threads.find((thread) => thread.id === CODING_THREAD_ID)?.purpose,
        "coding",
      );
    }),
  );
});

/* --------------------------------------------- the in-memory projector */

const makeThreadCreatedEvent = (payload: Record<string, unknown>): OrchestrationEvent =>
  ({
    sequence: 1,
    eventId: EventId.make("evt-1"),
    type: "thread.created",
    aggregateKind: "thread",
    aggregateId: NAVIGATOR_THREAD_ID,
    occurredAt: NOW,
    commandId: CommandId.make("cmd-1"),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload,
  }) as unknown as OrchestrationEvent;

const basePayload = {
  threadId: "thread-navigator",
  projectId: "project-navigator",
  title: "Thread",
  modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
  runtimeMode: "approval-required",
  interactionMode: "plan",
  branch: null,
  worktreePath: null,
  createdAt: NOW,
  updatedAt: NOW,
};

it.effect("projects a navigator thread.created into the read model as navigator", () =>
  Effect.gen(function* () {
    const readModel = yield* projectEvent(
      createEmptyReadModel(NOW),
      makeThreadCreatedEvent({ ...basePayload, purpose: "navigator" }),
    );
    assert.strictEqual(readModel.threads[0]?.purpose, "navigator");
  }),
);

it.effect("projects a thread.created written before purpose existed as coding", () =>
  Effect.gen(function* () {
    // The historical event, byte for byte as it sits in the event log. Nothing
    // rewrites it; the contract default is what makes it readable.
    const readModel = yield* projectEvent(
      createEmptyReadModel(NOW),
      makeThreadCreatedEvent({ ...basePayload, runtimeMode: "full-access" }),
    );
    assert.strictEqual(readModel.threads[0]?.purpose, "coding");
  }),
);
