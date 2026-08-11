/**
 * OrchestrationEngineService - Service interface for orchestration command handling.
 *
 * Owns command validation/dispatch and in-memory read-model updates backed by
 * `OrchestrationEventStore` persistence. It does not own provider process
 * management or transport concerns (e.g. websocket request parsing).
 *
 * Uses Effect `Context.Service` for dependency injection. Command dispatch,
 * replay, and unknown-input decoding all return typed domain errors.
 *
 * @module OrchestrationEngineService
 */
import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationProject,
  OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Stream from "effect/Stream";

import type { OrchestrationDispatchError } from "../Errors.ts";
import type { OrchestrationEventStoreError } from "../../persistence/Errors.ts";

/**
 * OrchestrationEngineShape - Service API for orchestration command and event flow.
 */
export interface OrchestrationEngineShape {
  /**
   * Replay persisted orchestration events from an exclusive sequence cursor.
   *
   * @param fromSequenceExclusive - Sequence cursor (exclusive).
   * @param limit - Maximum number of events to read. Defaults to the event
   *   store's page-bounded default; pass a higher value when the caller must
   *   read every event after the cursor (e.g. per-thread catch-up that filters
   *   a small subset out of a potentially larger global range).
   * @returns Stream containing ordered events.
   */
  readonly readEvents: (
    fromSequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  /**
   * Dispatch a validated orchestration command.
   *
   * @param command - Valid orchestration command.
   * @returns Effect containing the sequence of the persisted event.
   *
   * Dispatch is serialized through an internal queue and deduplicated via
   * command receipts.
   */
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;

  /**
   * Stream persisted domain events in dispatch order.
   *
   * This is a hot runtime stream (new events only), not a historical replay.
   */
  readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>;

  /**
   * The latest sequence reflected in the engine's authoritative command read
   * model (0 if none). Used to gauge how far behind a resuming client is before
   * choosing between an incremental replay and a fresh projected snapshot.
   */
  readonly latestSequence: Effect.Effect<number, never, never>;

  /**
   * One thread out of the engine's authoritative command read model.
   *
   * COMMITTED STATE, NOT THE SQL PROJECTION. The read model is seeded from
   * replay at startup and advanced inside the same transaction that appends an
   * event, before `dispatch` resolves — so a caller that awaited a dispatch is
   * guaranteed to see its effect here. The SQL projection is eventually
   * consistent with respect to `dispatch` and cannot make that promise, which
   * matters to anything deciding whether an at-most-once action already ran.
   *
   * Deliberately narrow: one entity by id rather than the whole mutable read
   * model. Server-internal — there is no wire contract and no client method.
   *
   * Returns whatever the read model holds, including soft-deleted entities.
   * "Active" is a caller's policy, and callers that need it check `deletedAt`.
   */
  readonly getThreadById: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<OrchestrationThread>, never, never>;

  /**
   * One project out of the same authoritative command read model.
   *
   * Same guarantees, same caveats, same reasons as `getThreadById`.
   */
  readonly getProjectById: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<OrchestrationProject>, never, never>;
}

/**
 * OrchestrationEngineService - Service tag for orchestration engine access.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const engine = yield* OrchestrationEngineService
 *   return yield* engine.dispatch(command)
 * })
 * ```
 */
export class OrchestrationEngineService extends Context.Service<
  OrchestrationEngineService,
  OrchestrationEngineShape
>()("t3/orchestration/Services/OrchestrationEngine/OrchestrationEngineService") {}
