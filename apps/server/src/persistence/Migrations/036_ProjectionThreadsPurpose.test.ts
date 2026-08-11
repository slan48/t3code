import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const insertThread = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
      branch, worktree_path, latest_turn_id, created_at, updated_at,
      latest_user_message_at, pending_approval_count, pending_user_input_count,
      has_actionable_proposed_plan, deleted_at
    ) VALUES (
      ${threadId}, 'project-1', 'Thread', '{"instanceId":"codex","model":"gpt-5.4"}',
      'full-access', 'default', NULL, NULL, NULL,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
      NULL, 0, 0, 0, NULL
    )
  `;
  });

layer("036_ProjectionThreadsPurpose", (it) => {
  it.effect("gives a thread that predates the column the coding purpose", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 35 });
      // Written by a server that had never heard of a thread purpose.
      yield* insertThread("thread-historical");

      yield* runMigrations({ toMigrationInclusive: 36 });

      const rows = yield* sql<{ readonly purpose: string }>`
        SELECT purpose FROM projection_threads WHERE thread_id = 'thread-historical'
      `;
      assert.deepStrictEqual(
        rows.map((row) => row.purpose),
        ["coding"],
      );
    }),
  );

  it.effect("persists a navigator thread as navigator, and defaults an unstated one", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 36 });
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, purpose, model_selection_json, runtime_mode,
          interaction_mode, branch, worktree_path, latest_turn_id, created_at, updated_at,
          latest_user_message_at, pending_approval_count, pending_user_input_count,
          has_actionable_proposed_plan, deleted_at
        ) VALUES (
          'thread-navigator', 'project-1', 'Navigator', 'navigator',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'approval-required', 'plan',
          NULL, NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
          NULL, 0, 0, 0, NULL
        )
      `;
      // A writer that omits the column still lands on 'coding' rather than NULL.
      yield* insertThread("thread-coding");

      const rows = yield* sql<{ readonly threadId: string; readonly purpose: string }>`
        SELECT thread_id AS "threadId", purpose
        FROM projection_threads
        WHERE thread_id IN ('thread-navigator', 'thread-coding')
        ORDER BY thread_id ASC
      `;
      assert.deepStrictEqual(
        rows.map((row) => [row.threadId, row.purpose]),
        [
          ["thread-coding", "coding"],
          ["thread-navigator", "navigator"],
        ],
      );
    }),
  );

  it.effect("adds the column exactly once when the migration is re-run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 36 });
      yield* runMigrations({ toMigrationInclusive: 36 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_threads)
      `;
      const purposeColumns = columns.filter((column) => column.name === "purpose");
      assert.strictEqual(purposeColumns.length, 1);
      assert.strictEqual(purposeColumns[0]?.notnull, 1);
    }),
  );
});
