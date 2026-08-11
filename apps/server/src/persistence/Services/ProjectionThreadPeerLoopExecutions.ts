/**
 * ProjectionThreadPeerLoopExecutionRepository - the proposal/run association.
 *
 * Owns persistence for the immutable link between a Navigator Execution
 * Proposal and the Peer Loop run launched from it. There is no update
 * operation and no status column: a link is a historical fact, and every
 * mutable fact about the run belongs to Peer Loop.
 *
 * @module ProjectionThreadPeerLoopExecutionRepository
 */
import {
  IsoDateTime,
  OrchestrationProposedPlanId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadPeerLoopExecution = Schema.Struct({
  /** Peer Loop's own run id, carried opaquely. */
  runId: TrimmedNonEmptyString,
  threadId: ThreadId,
  proposedPlanId: OrchestrationProposedPlanId,
  /** When the link was recorded. Not the run's own timeline. */
  createdAt: IsoDateTime,
});
export type ProjectionThreadPeerLoopExecution = typeof ProjectionThreadPeerLoopExecution.Type;

export const ListProjectionThreadPeerLoopExecutionsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadPeerLoopExecutionsInput =
  typeof ListProjectionThreadPeerLoopExecutionsInput.Type;

export const DeleteProjectionThreadPeerLoopExecutionsInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadPeerLoopExecutionsInput =
  typeof DeleteProjectionThreadPeerLoopExecutionsInput.Type;

export interface ProjectionThreadPeerLoopExecutionRepositoryShape {
  /**
   * Record a link, once.
   *
   * Ignores a row that is already there rather than replacing it: the decider
   * refuses a genuine duplicate, so a conflict here is a replay of an event
   * already applied and the stored row is the same fact.
   */
  readonly insert: (
    execution: ProjectionThreadPeerLoopExecution,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /** Links for one thread, oldest first, run id breaking ties. */
  readonly listByThreadId: (
    input: ListProjectionThreadPeerLoopExecutionsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadPeerLoopExecution>, ProjectionRepositoryError>;

  /**
   * Drop a deleted thread's association rows.
   *
   * Read-model housekeeping only. Peer Loop's runs and its durable files are
   * untouched by this and are not T3 Code's to remove.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadPeerLoopExecutionsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadPeerLoopExecutionRepository extends Context.Service<
  ProjectionThreadPeerLoopExecutionRepository,
  ProjectionThreadPeerLoopExecutionRepositoryShape
>()(
  "t3/persistence/Services/ProjectionThreadPeerLoopExecutions/ProjectionThreadPeerLoopExecutionRepository",
) {}
