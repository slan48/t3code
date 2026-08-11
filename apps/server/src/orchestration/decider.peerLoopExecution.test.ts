/**
 * Linking a Navigator Execution Proposal to the Peer Loop run it launched.
 *
 * The link is immutable and there is no command that edits or removes one, so
 * every rule about it holds at this single boundary or nowhere. What is stored
 * is an association and a timestamp; Peer Loop keeps the run.
 */
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProposedPlan,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LINKED_AT = "2026-01-01T00:05:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const NAVIGATOR_THREAD_ID = ThreadId.make("thread-navigator");
const CODING_THREAD_ID = ThreadId.make("thread-coding");
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} as const;

const plan = (id: string): OrchestrationProposedPlan => ({
  id,
  turnId: null,
  planMarkdown: `# ${id}`,
  implementedAt: null,
  implementationThreadId: null,
  createdAt: NOW,
  updatedAt: NOW,
});

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: NAVIGATOR_THREAD_ID,
    projectId: PROJECT_ID,
    title: "Navigator",
    purpose: "navigator",
    modelSelection: MODEL_SELECTION,
    runtimeMode: "approval-required",
    interactionMode: "plan",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [plan("plan-1"), plan("plan-2")],
    peerLoopExecutions: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

const codingThread = (overrides: Partial<OrchestrationThread> = {}): OrchestrationThread =>
  makeThread({
    id: CODING_THREAD_ID,
    purpose: "coding",
    runtimeMode: "full-access",
    interactionMode: "default",
    ...overrides,
  });

function makeReadModel(threads: ReadonlyArray<OrchestrationThread>): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/repos/demo",
        defaultModelSelection: MODEL_SELECTION,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads,
    updatedAt: NOW,
  };
}

const linkCommand = (
  overrides: {
    readonly threadId?: ThreadId;
    readonly proposedPlanId?: string;
    readonly runId?: string;
  } = {},
): OrchestrationCommand => ({
  type: "thread.peer-loop-execution.link",
  commandId: CommandId.make("cmd-link"),
  threadId: overrides.threadId ?? NAVIGATOR_THREAD_ID,
  proposedPlanId: overrides.proposedPlanId ?? "plan-1",
  runId: overrides.runId ?? "run-1",
  createdAt: LINKED_AT,
});

const isInvariantError = Schema.is(OrchestrationCommandInvariantError);

const refusalDetail = (command: OrchestrationCommand, readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.flip,
    Effect.map((error) => {
      expect(isInvariantError(error)).toBe(true);
      return isInvariantError(error) ? error.detail : String(error);
    }),
  );

it.layer(NodeServices.layer)("linking a navigator proposal to a Peer Loop run", (it) => {
  it.effect("emits the typed link event", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: linkCommand(),
        readModel: makeReadModel([makeThread()]),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event?.type).toBe("thread.peer-loop-execution-linked");
      if (event?.type === "thread.peer-loop-execution-linked") {
        expect(event.payload).toEqual({
          threadId: NAVIGATOR_THREAD_ID,
          proposedPlanId: "plan-1",
          runId: "run-1",
          createdAt: LINKED_AT,
        });
        // An association and a timestamp. Nothing about the run itself.
        expect(Object.keys(event.payload).toSorted()).toEqual([
          "createdAt",
          "proposedPlanId",
          "runId",
          "threadId",
        ]);
      }
    }),
  );

  it.effect("refuses a plan that is not on that thread", () =>
    Effect.gen(function* () {
      const detail = yield* refusalDetail(
        linkCommand({ proposedPlanId: "plan-elsewhere" }),
        makeReadModel([makeThread()]),
      );
      expect(detail).toContain("plan-elsewhere");
      expect(detail).toContain("does not exist on thread");
    }),
  );

  it.effect("refuses a thread that does not exist", () =>
    Effect.gen(function* () {
      const detail = yield* refusalDetail(
        linkCommand({ threadId: ThreadId.make("thread-missing") }),
        makeReadModel([makeThread()]),
      );
      expect(detail).toContain("thread-missing");
    }),
  );

  it.effect("refuses a coding thread outright", () =>
    Effect.gen(function* () {
      // A coding thread has no execution proposals to run, and collecting run
      // ids on one would make it look like something it is not.
      const detail = yield* refusalDetail(
        linkCommand({ threadId: CODING_THREAD_ID }),
        makeReadModel([codingThread()]),
      );
      expect(detail).toContain("coding thread");
      expect(detail).toContain("navigator");
    }),
  );

  it.effect("refuses a second run for a proposal that already has one", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel([
        makeThread({
          peerLoopExecutions: [{ runId: "run-existing", proposedPlanId: "plan-1", createdAt: NOW }],
        }),
      ]);
      const detail = yield* refusalDetail(linkCommand({ runId: "run-2" }), readModel);
      expect(detail).toContain("plan-1");
      expect(detail).toContain("already linked to Peer Loop run 'run-existing'");

      // A different proposal on the same thread is still free to link.
      const decided = yield* decideOrchestrationCommand({
        command: linkCommand({ proposedPlanId: "plan-2", runId: "run-2" }),
        readModel,
      });
      expect((Array.isArray(decided) ? decided[0] : decided)?.type).toBe(
        "thread.peer-loop-execution-linked",
      );
    }),
  );

  it.effect("refuses a run id already linked anywhere in the read model", () =>
    Effect.gen(function* () {
      // Peer Loop run ids are unique. The same id arriving twice is a replay or
      // a bug, never two runs — including from a different navigator thread.
      const otherNavigator = makeThread({
        id: ThreadId.make("thread-other-navigator"),
        proposedPlans: [plan("plan-other")],
        peerLoopExecutions: [{ runId: "run-1", proposedPlanId: "plan-other", createdAt: NOW }],
      });
      const detail = yield* refusalDetail(
        linkCommand(),
        makeReadModel([makeThread(), otherNavigator]),
      );
      expect(detail).toContain("run-1");
      expect(detail).toContain("thread-other-navigator");
      expect(detail).toContain("plan-other");
    }),
  );

  it.effect("refuses re-linking the identical pair rather than accepting it twice", () =>
    Effect.gen(function* () {
      // The caller is the coordination service and knows whether it recorded
      // this. Silently accepting would hide a double launch.
      const readModel = makeReadModel([
        makeThread({
          peerLoopExecutions: [{ runId: "run-1", proposedPlanId: "plan-1", createdAt: NOW }],
        }),
      ]);
      const detail = yield* refusalDetail(linkCommand(), readModel);
      expect(detail).toContain("already linked");
    }),
  );

  it.effect("says nothing about unrelated threads or plans in a refusal", () =>
    Effect.gen(function* () {
      const secret = makeThread({
        id: ThreadId.make("thread-unrelated"),
        title: "Confidential planning",
        proposedPlans: [plan("plan-unrelated")],
      });
      const detail = yield* refusalDetail(
        linkCommand({ proposedPlanId: "plan-missing" }),
        makeReadModel([makeThread(), secret]),
      );
      expect(detail).not.toContain("thread-unrelated");
      expect(detail).not.toContain("plan-unrelated");
      expect(detail).not.toContain("Confidential planning");
    }),
  );

  it.effect("leaves the proposal's own implementation metadata alone", () =>
    Effect.gen(function* () {
      // `implementedAt` / `implementationThreadId` mean "a coding thread picked
      // this plan up". A Peer Loop execution is a different fact and must not
      // be squeezed into those fields.
      const implemented: OrchestrationProposedPlan = {
        ...plan("plan-1"),
        implementedAt: "2026-01-01T00:02:00.000Z",
        implementationThreadId: ThreadId.make("thread-implementation"),
      };
      const decided = yield* decideOrchestrationCommand({
        command: linkCommand(),
        readModel: makeReadModel([makeThread({ proposedPlans: [implemented] })]),
      });
      const event = Array.isArray(decided) ? decided[0] : decided;
      expect(event?.type).toBe("thread.peer-loop-execution-linked");
      if (event?.type === "thread.peer-loop-execution-linked") {
        expect(Object.keys(event.payload)).not.toContain("implementedAt");
        expect(Object.keys(event.payload)).not.toContain("implementationThreadId");
      }
    }),
  );
});
