/**
 * The in-memory projector's handling of proposal/run links.
 *
 * Ordering and de-duplication are asserted here rather than left to the
 * decider's invariants: this projector also runs over replayed history, where
 * the same link event can legitimately arrive more than once, and a duplicate
 * would surface as the same execution listed twice under one conversation.
 */
import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");

const makeEvent = (input: {
  readonly sequence: number;
  readonly type: OrchestrationEvent["type"];
  readonly occurredAt: string;
  readonly payload: unknown;
}): OrchestrationEvent =>
  ({
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: input.occurredAt,
    commandId: CommandId.make(`cmd-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload,
  }) as OrchestrationEvent;

const threadCreated = makeEvent({
  sequence: 1,
  type: "thread.created",
  occurredAt: NOW,
  payload: {
    threadId: THREAD_ID,
    projectId: ProjectId.make("project-1"),
    title: "Navigator",
    purpose: "navigator",
    modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
    runtimeMode: "approval-required",
    interactionMode: "plan",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
});

const linked = (input: {
  readonly sequence: number;
  readonly runId: string;
  readonly proposedPlanId: string;
  readonly createdAt: string;
}): OrchestrationEvent =>
  makeEvent({
    sequence: input.sequence,
    type: "thread.peer-loop-execution-linked",
    occurredAt: input.createdAt,
    payload: {
      threadId: THREAD_ID,
      proposedPlanId: input.proposedPlanId,
      runId: input.runId,
      createdAt: input.createdAt,
    },
  });

const applyAll = Effect.fn("applyAll")(function* (events: ReadonlyArray<OrchestrationEvent>) {
  let model = createEmptyReadModel(NOW);
  for (const event of events) {
    model = yield* projectEvent(model, event);
  }
  return model;
});

it.effect("orders links by createdAt, then by run id", () =>
  Effect.gen(function* () {
    const next = yield* applyAll([
      threadCreated,
      linked({
        sequence: 2,
        runId: "run-b",
        proposedPlanId: "plan-2",
        createdAt: "2026-01-01T00:02:00.000Z",
      }),
      linked({
        sequence: 3,
        runId: "run-a",
        proposedPlanId: "plan-1",
        createdAt: "2026-01-01T00:01:00.000Z",
      }),
      // Same instant as run-b: the run id is the stable tie-breaker.
      linked({
        sequence: 4,
        runId: "run-a2",
        proposedPlanId: "plan-3",
        createdAt: "2026-01-01T00:02:00.000Z",
      }),
    ]);

    assert.deepStrictEqual(
      next.threads[0]?.peerLoopExecutions.map((entry) => entry.runId),
      ["run-a", "run-a2", "run-b"],
    );
  }),
);

it.effect("de-duplicates a replayed link by run id and by proposal", () =>
  Effect.gen(function* () {
    const first = linked({
      sequence: 2,
      runId: "run-1",
      proposedPlanId: "plan-1",
      createdAt: "2026-01-01T00:01:00.000Z",
    });
    // The same proposal reaching a different run id, and the same run id
    // reaching a different proposal, both collapse to one entry.
    const sameProposal = linked({
      sequence: 3,
      runId: "run-2",
      proposedPlanId: "plan-1",
      createdAt: "2026-01-01T00:03:00.000Z",
    });
    const next = yield* applyAll([threadCreated, first, first, sameProposal]);

    assert.deepStrictEqual(next.threads[0]?.peerLoopExecutions, [
      { runId: "run-2", proposedPlanId: "plan-1", createdAt: "2026-01-01T00:03:00.000Z" },
    ]);
  }),
);

it.effect("materializes a thread with no links as an empty collection", () =>
  Effect.gen(function* () {
    const next = yield* applyAll([threadCreated]);
    assert.deepStrictEqual(next.threads[0]?.peerLoopExecutions, []);
  }),
);

it.effect("ignores a link for a thread it has never seen", () =>
  Effect.gen(function* () {
    const next = yield* applyAll([
      linked({
        sequence: 1,
        runId: "run-1",
        proposedPlanId: "plan-1",
        createdAt: "2026-01-01T00:01:00.000Z",
      }),
    ]);
    assert.deepStrictEqual(next.threads, []);
  }),
);
