/**
 * Navigator threads, at the boundary that actually decides.
 *
 * A Navigator conversation is an ordinary durable thread with one immutable
 * piece of metadata on it. Everything that keeps it planning-only is enforced
 * here, in the decider's invariants, rather than by a UI that happens to pick
 * good defaults — a client that sends the command anyway has to be refused.
 *
 * Nothing in this file touches Peer Loop. `purpose` is thread metadata; Peer
 * Loop owns its own lifecycle, policy and recovery and none of it is mirrored.
 */
import {
  CommandId,
  ApprovalRequestId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ProviderApprovalDecision,
  type ThreadPurpose,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { decideOrchestrationCommand } from "./decider.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} as const;

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    purpose: "coding",
    modelSelection: MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
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
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

/** A Navigator thread as the decider will only ever let one be created. */
const navigatorThread = (overrides: Partial<OrchestrationThread> = {}): OrchestrationThread =>
  makeThread({
    purpose: "navigator",
    runtimeMode: "approval-required",
    interactionMode: "plan",
    branch: null,
    worktreePath: null,
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

const createCommand = (
  overrides: {
    readonly purpose?: ThreadPurpose;
    readonly runtimeMode?: OrchestrationThread["runtimeMode"];
    readonly interactionMode?: OrchestrationThread["interactionMode"];
    readonly branch?: string | null;
    readonly worktreePath?: string | null;
  } = {},
): OrchestrationCommand => ({
  type: "thread.create",
  commandId: CommandId.make("cmd-create"),
  threadId: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Navigator",
  purpose: overrides.purpose ?? "navigator",
  modelSelection: MODEL_SELECTION,
  runtimeMode: overrides.runtimeMode ?? "approval-required",
  interactionMode: overrides.interactionMode ?? "plan",
  branch: overrides.branch ?? null,
  worktreePath: overrides.worktreePath ?? null,
  createdAt: NOW,
});

/** The refusal detail, so a test can say which rule bit rather than "it failed". */
const isInvariantError = Schema.is(OrchestrationCommandInvariantError);

const refusalDetail = (command: OrchestrationCommand, readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.flip,
    Effect.map((error) => {
      // A typed invariant refusal, not a decode failure and not a crash.
      expect(isInvariantError(error)).toBe(true);
      return isInvariantError(error) ? error.detail : String(error);
    }),
  );

it.layer(NodeServices.layer)("navigator thread creation", (it) => {
  it.effect("creates a navigator thread and carries the purpose onto the event", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: createCommand(),
        readModel: makeReadModel([]),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events).toHaveLength(1);
      const event = events[0];
      expect(event?.type).toBe("thread.created");
      if (event?.type === "thread.created") {
        expect(event.payload.purpose).toBe("navigator");
        expect(event.payload.runtimeMode).toBe("approval-required");
        expect(event.payload.interactionMode).toBe("plan");
        expect(event.payload.branch).toBe(null);
        expect(event.payload.worktreePath).toBe(null);
      }
    }),
  );

  it.effect("refuses a navigator thread in a runtime mode that can write", () =>
    Effect.gen(function* () {
      for (const runtimeMode of ["full-access", "auto", "auto-accept-edits"] as const) {
        const detail = yield* refusalDetail(createCommand({ runtimeMode }), makeReadModel([]));
        expect(detail).toContain("approval-required");
      }
    }),
  );

  it.effect("refuses a navigator thread in the default interaction mode", () =>
    Effect.gen(function* () {
      const detail = yield* refusalDetail(
        createCommand({ interactionMode: "default" }),
        makeReadModel([]),
      );
      expect(detail).toContain("interactionMode 'plan'");
    }),
  );

  it.effect("refuses a navigator thread that comes with a checkout", () =>
    Effect.gen(function* () {
      const withBranch = yield* refusalDetail(
        createCommand({ branch: "feature/x" }),
        makeReadModel([]),
      );
      expect(withBranch).toContain("no branch");

      const withWorktree = yield* refusalDetail(
        createCommand({ worktreePath: "/repos/demo-wt" }),
        makeReadModel([]),
      );
      expect(withWorktree).toContain("no worktree");
    }),
  );

  it.effect("leaves ordinary coding threads alone", () =>
    Effect.gen(function* () {
      // The exact combination refused above is the ordinary, correct shape for
      // a coding thread. None of the navigator rules may reach it.
      const decided = yield* decideOrchestrationCommand({
        command: createCommand({
          purpose: "coding",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature/x",
          worktreePath: "/repos/demo-wt",
        }),
        readModel: makeReadModel([]),
      });
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events[0]?.type).toBe("thread.created");
      if (events[0]?.type === "thread.created") {
        expect(events[0].payload.purpose).toBe("coding");
        expect(events[0].payload.worktreePath).toBe("/repos/demo-wt");
      }
    }),
  );
});

it.layer(NodeServices.layer)("navigator thread cannot escape planning", (it) => {
  const readModel = makeReadModel([navigatorThread()]);
  const codingReadModel = makeReadModel([makeThread()]);

  it.effect("refuses a runtime mode that would let it write", () =>
    Effect.gen(function* () {
      const detail = yield* refusalDetail(
        {
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("cmd-runtime"),
          threadId: THREAD_ID,
          runtimeMode: "full-access",
          createdAt: NOW,
        },
        readModel,
      );
      expect(detail).toContain("navigator thread");
      expect(detail).toContain("approval-required");
    }),
  );

  it.effect("refuses leaving plan mode", () =>
    Effect.gen(function* () {
      const detail = yield* refusalDetail(
        {
          type: "thread.interaction-mode.set",
          commandId: CommandId.make("cmd-interaction"),
          threadId: THREAD_ID,
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel,
      );
      expect(detail).toContain("interactionMode 'plan'");
    }),
  );

  it.effect("accepts setting the values it already has", () =>
    Effect.gen(function* () {
      // An idempotent set is how a client re-asserts state it already believes.
      // Refusing it would break the client and protect nothing.
      const runtime = yield* decideOrchestrationCommand({
        command: {
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("cmd-runtime-same"),
          threadId: THREAD_ID,
          runtimeMode: "approval-required",
          createdAt: NOW,
        },
        readModel,
      });
      expect((Array.isArray(runtime) ? runtime[0] : runtime)?.type).toBe("thread.runtime-mode-set");

      const interaction = yield* decideOrchestrationCommand({
        command: {
          type: "thread.interaction-mode.set",
          commandId: CommandId.make("cmd-interaction-same"),
          threadId: THREAD_ID,
          interactionMode: "plan",
          createdAt: NOW,
        },
        readModel,
      });
      expect((Array.isArray(interaction) ? interaction[0] : interaction)?.type).toBe(
        "thread.interaction-mode-set",
      );
    }),
  );

  it.effect("refuses being given a checkout after the fact", () =>
    Effect.gen(function* () {
      const detail = yield* refusalDetail(
        {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-meta"),
          threadId: THREAD_ID,
          worktreePath: "/repos/demo-wt",
        },
        readModel,
      );
      expect(detail).toContain("cannot be given a worktree");
    }),
  );

  it.effect("lets a coding thread change either mode", () =>
    Effect.gen(function* () {
      const runtime = yield* decideOrchestrationCommand({
        command: {
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("cmd-runtime-coding"),
          threadId: THREAD_ID,
          runtimeMode: "full-access",
          createdAt: NOW,
        },
        readModel: codingReadModel,
      });
      expect((Array.isArray(runtime) ? runtime[0] : runtime)?.type).toBe("thread.runtime-mode-set");

      const interaction = yield* decideOrchestrationCommand({
        command: {
          type: "thread.interaction-mode.set",
          commandId: CommandId.make("cmd-interaction-coding"),
          threadId: THREAD_ID,
          interactionMode: "default",
          createdAt: NOW,
        },
        readModel: codingReadModel,
      });
      expect((Array.isArray(interaction) ? interaction[0] : interaction)?.type).toBe(
        "thread.interaction-mode-set",
      );
    }),
  );
});

it.layer(NodeServices.layer)("navigator thread cannot approve its way into acting", (it) => {
  const readModel = makeReadModel([navigatorThread()]);
  const codingReadModel = makeReadModel([makeThread()]);

  const approval = (decision: ProviderApprovalDecision): OrchestrationCommand => ({
    type: "thread.approval.respond",
    commandId: CommandId.make(`cmd-approval-${decision}`),
    threadId: THREAD_ID,
    requestId: ApprovalRequestId.make("request-1"),
    decision,
    createdAt: NOW,
  });

  it.effect("refuses accept and acceptForSession", () =>
    Effect.gen(function* () {
      for (const decision of ["accept", "acceptForSession"] as const) {
        const detail = yield* refusalDetail(approval(decision), readModel);
        expect(detail).toContain("navigator thread");
        expect(detail).toContain(decision);
      }
    }),
  );

  it.effect("still allows decline and cancel, so a request can be cleared", () =>
    Effect.gen(function* () {
      // Blocking these would strand a navigator thread with a pending question
      // it could never answer.
      for (const decision of ["decline", "cancel"] as const) {
        const decided = yield* decideOrchestrationCommand({
          command: approval(decision),
          readModel,
        });
        const event = Array.isArray(decided) ? decided[0] : decided;
        expect(event?.type).toBe("thread.approval-response-requested");
        if (event?.type === "thread.approval-response-requested") {
          expect(event.payload.decision).toBe(decision);
        }
      }
    }),
  );

  it.effect("leaves a coding thread's approvals untouched", () =>
    Effect.gen(function* () {
      for (const decision of ["accept", "acceptForSession", "decline", "cancel"] as const) {
        const decided = yield* decideOrchestrationCommand({
          command: approval(decision),
          readModel: codingReadModel,
        });
        const event = Array.isArray(decided) ? decided[0] : decided;
        expect(event?.type).toBe("thread.approval-response-requested");
      }
    }),
  );
});

it.layer(NodeServices.layer)("navigator thread has no history to revert", (it) => {
  const revert: OrchestrationCommand = {
    type: "thread.checkpoint.revert",
    commandId: CommandId.make("cmd-revert"),
    threadId: THREAD_ID,
    turnCount: 1,
    createdAt: NOW,
  };

  it.effect("refuses a checkpoint revert", () =>
    Effect.gen(function* () {
      const detail = yield* refusalDetail(revert, makeReadModel([navigatorThread()]));
      expect(detail).toContain("navigator thread");
      expect(detail).toContain("worktree");
    }),
  );

  it.effect("still reverts a coding thread", () =>
    Effect.gen(function* () {
      const decided = yield* decideOrchestrationCommand({
        command: revert,
        readModel: makeReadModel([makeThread()]),
      });
      const event = Array.isArray(decided) ? decided[0] : decided;
      expect(event?.type).toBe("thread.checkpoint-revert-requested");
    }),
  );
});
