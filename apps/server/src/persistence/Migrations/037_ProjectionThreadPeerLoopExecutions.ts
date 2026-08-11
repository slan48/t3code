/**
 * The association between a Navigator Execution Proposal and the Peer Loop run
 * it launched.
 *
 * History, not state. The row says "this proposal produced this run, at this
 * time" and nothing else — no status, no outcome, no halt reason, no summary.
 * Peer Loop owns all of those and answers for them live over its own protocol;
 * a copy here would be a second, stale answer.
 *
 * `run_id` is the primary key because a Peer Loop run belongs to exactly one
 * proposal, and `(thread_id, proposed_plan_id)` is unique because a proposal
 * launches at most one run. Both are enforced in the decider too; the
 * constraints are what make a replay idempotent rather than duplicating rows.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_peer_loop_executions (
      run_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      proposed_plan_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_thread_peer_loop_executions_plan
    ON projection_thread_peer_loop_executions(thread_id, proposed_plan_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_peer_loop_executions_thread_created
    ON projection_thread_peer_loop_executions(thread_id, created_at)
  `;
});
