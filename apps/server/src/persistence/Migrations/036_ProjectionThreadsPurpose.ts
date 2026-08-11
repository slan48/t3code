/**
 * Adds the immutable thread purpose to the thread projection.
 *
 * Every row that exists when this runs is a coding thread — that is what T3
 * Code has always created — so the column is NOT NULL with a `coding` default
 * and SQLite backfills existing rows with it. No orchestration event is
 * rewritten: the event log stays exactly as it was written, and `thread.created`
 * payloads without a purpose decode as `coding` through the contract default.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "purpose")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN purpose TEXT NOT NULL DEFAULT 'coding'
    `;
  }
});
