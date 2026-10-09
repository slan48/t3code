/**
 * Distinguishes ordinary user messages, which request a provider turn, from
 * server-authored Owner approval records, which are visible history only.
 * Existing rows retain the historical provider-turn behavior through the
 * migration default.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;

  if (!columns.some((column) => column.name === "message_kind")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN message_kind TEXT NOT NULL DEFAULT 'provider-turn'
    `;
  }
});
