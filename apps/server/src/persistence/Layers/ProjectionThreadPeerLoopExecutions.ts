import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadPeerLoopExecutionsInput,
  ListProjectionThreadPeerLoopExecutionsInput,
  ProjectionThreadPeerLoopExecution,
  ProjectionThreadPeerLoopExecutionRepository,
  type ProjectionThreadPeerLoopExecutionRepositoryShape,
} from "../Services/ProjectionThreadPeerLoopExecutions.ts";

const makeProjectionThreadPeerLoopExecutionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertProjectionThreadPeerLoopExecutionRow = SqlSchema.void({
    Request: ProjectionThreadPeerLoopExecution,
    // `DO NOTHING` with no conflict target covers both the run_id primary key
    // and the (thread_id, proposed_plan_id) unique index, which is what makes a
    // projector rebuild idempotent. It never overwrites: a link is immutable,
    // so the row already there is the same fact this event carries.
    execute: (row) => sql`
      INSERT INTO projection_thread_peer_loop_executions (
        run_id,
        thread_id,
        proposed_plan_id,
        created_at
      )
      VALUES (
        ${row.runId},
        ${row.threadId},
        ${row.proposedPlanId},
        ${row.createdAt}
      )
      ON CONFLICT DO NOTHING
    `,
  });

  const listProjectionThreadPeerLoopExecutionRows = SqlSchema.findAll({
    Request: ListProjectionThreadPeerLoopExecutionsInput,
    Result: ProjectionThreadPeerLoopExecution,
    execute: ({ threadId }) => sql`
      SELECT
        run_id AS "runId",
        thread_id AS "threadId",
        proposed_plan_id AS "proposedPlanId",
        created_at AS "createdAt"
      FROM projection_thread_peer_loop_executions
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, run_id ASC
    `,
  });

  const deleteProjectionThreadPeerLoopExecutionRows = SqlSchema.void({
    Request: DeleteProjectionThreadPeerLoopExecutionsInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_peer_loop_executions
      WHERE thread_id = ${threadId}
    `,
  });

  const insert: ProjectionThreadPeerLoopExecutionRepositoryShape["insert"] = (row) =>
    insertProjectionThreadPeerLoopExecutionRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadPeerLoopExecutionRepository.insert:query"),
      ),
    );

  const listByThreadId: ProjectionThreadPeerLoopExecutionRepositoryShape["listByThreadId"] = (
    input,
  ) =>
    listProjectionThreadPeerLoopExecutionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadPeerLoopExecutionRepository.listByThreadId:query"),
      ),
    );

  const deleteByThreadId: ProjectionThreadPeerLoopExecutionRepositoryShape["deleteByThreadId"] = (
    input,
  ) =>
    deleteProjectionThreadPeerLoopExecutionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadPeerLoopExecutionRepository.deleteByThreadId:query"),
      ),
    );

  return {
    insert,
    listByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadPeerLoopExecutionRepositoryShape;
});

export const ProjectionThreadPeerLoopExecutionRepositoryLive = Layer.effect(
  ProjectionThreadPeerLoopExecutionRepository,
  makeProjectionThreadPeerLoopExecutionRepository,
);
