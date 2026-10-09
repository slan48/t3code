import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("038_ProjectionThreadMessageKind", (it) => {
  it.effect("adds a legacy-compatible provider-turn default and is idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming,
          created_at, updated_at
        ) VALUES (
          'message-legacy', 'thread-1', NULL, 'user', 'legacy', 0,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 38 });
      yield* runMigrations({ toMigrationInclusive: 38 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
      }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      const messageKind = columns.find((column) => column.name === "message_kind");
      assert.ok(messageKind);
      assert.strictEqual(messageKind.notnull, 1);
      assert.strictEqual(messageKind.dflt_value, "'provider-turn'");

      const rows = yield* sql<{ readonly messageKind: string }>`
        SELECT message_kind AS "messageKind"
        FROM projection_thread_messages
        WHERE message_id = 'message-legacy'
      `;
      assert.deepStrictEqual(rows, [{ messageKind: "provider-turn" }]);
    }),
  );
});
