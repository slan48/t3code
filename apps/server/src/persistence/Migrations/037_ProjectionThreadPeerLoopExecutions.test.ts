import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

const insertLink = (input: {
  readonly runId: string;
  readonly threadId: string;
  readonly proposedPlanId: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_peer_loop_executions (
        run_id, thread_id, proposed_plan_id, created_at
      ) VALUES (
        ${input.runId}, ${input.threadId}, ${input.proposedPlanId}, '2026-01-01T00:00:00.000Z'
      )
    `;
  });

layer("037_ProjectionThreadPeerLoopExecutions", (it) => {
  it.effect("creates the association table with the columns it promises", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 36 });
      yield* runMigrations({ toMigrationInclusive: 37 });

      const columns = yield* sql<{
        readonly name: string;
        readonly notnull: number;
        readonly pk: number;
      }>`
        PRAGMA table_info(projection_thread_peer_loop_executions)
      `;
      const byName = new Map(columns.map((column) => [column.name, column]));

      assert.deepStrictEqual(columns.map((column) => column.name).toSorted(), [
        "created_at",
        "proposed_plan_id",
        "run_id",
        "thread_id",
      ]);
      assert.strictEqual(byName.get("run_id")?.pk, 1);
      for (const name of ["thread_id", "proposed_plan_id", "created_at"]) {
        assert.strictEqual(byName.get(name)?.notnull, 1, `${name} must be NOT NULL`);
      }

      // No status, outcome or summary column: this table is history, and every
      // mutable run fact belongs to Peer Loop.
      for (const forbidden of ["state", "status", "outcome", "halt_reason", "summary"]) {
        assert.strictEqual(byName.has(forbidden), false, `${forbidden} must not exist`);
      }
    }),
  );

  it.effect("enforces one run per proposal and one proposal per run", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 37 });

      yield* insertLink({ runId: "run-1", threadId: "thread-1", proposedPlanId: "plan-1" });

      // Same run id again: refused by the primary key.
      const duplicateRun = yield* Effect.exit(
        insertLink({ runId: "run-1", threadId: "thread-1", proposedPlanId: "plan-2" }),
      );
      assert.strictEqual(duplicateRun._tag, "Failure");

      // Same (thread, plan) with a new run id: refused by the unique index.
      const duplicatePlan = yield* Effect.exit(
        insertLink({ runId: "run-2", threadId: "thread-1", proposedPlanId: "plan-1" }),
      );
      assert.strictEqual(duplicatePlan._tag, "Failure");

      // A different plan on the same thread is fine.
      yield* insertLink({ runId: "run-3", threadId: "thread-1", proposedPlanId: "plan-3" });

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly runId: string }>`
        SELECT run_id AS "runId"
        FROM projection_thread_peer_loop_executions
        ORDER BY run_id ASC
      `;
      assert.deepStrictEqual(
        rows.map((row) => row.runId),
        ["run-1", "run-3"],
      );
    }),
  );

  it.effect("is idempotent when re-run and leaves earlier tables alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 37 });
      yield* runMigrations({ toMigrationInclusive: 37 });

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'projection_thread_peer_loop_executions'
          AND name IS NOT NULL
        ORDER BY name ASC
      `;
      assert.ok(
        indexes.some((index) => index.name === "idx_projection_thread_peer_loop_executions_plan"),
      );

      // The proposed-plan table is untouched: a Peer Loop execution link is a
      // separate fact, not a rewrite of plan implementation metadata.
      const planColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_proposed_plans)
      `;
      const planColumnNames = new Set(planColumns.map((column) => column.name));
      assert.ok(planColumnNames.has("implemented_at"));
      assert.ok(planColumnNames.has("implementation_thread_id"));
      assert.strictEqual(planColumnNames.has("run_id"), false);
    }),
  );
});
