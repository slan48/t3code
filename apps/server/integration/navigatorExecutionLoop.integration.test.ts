/**
 * The whole Navigator loop, once, against real machinery.
 *
 * Plan → execute → durable link → structured context → keep talking. Each of
 * those steps has focused unit coverage already; what none of them can show is
 * that they compose — that the proposal the provider produced is the one the
 * coordinator executes, that the link it writes is the one the context service
 * reads back on the next turn, and that a conversation about a finished run is
 * still just a conversation.
 *
 * WHAT IS REAL: the orchestration engine, decider, event store and projectors
 * over disposable SQLite; `ProviderRuntimeIngestion`; `ProviderCommandReactor`;
 * `PeerLoopExecutionCoordinator`; `NavigatorExecutionContext`; and the Navigator
 * provider frame. The proposed plan is produced the way a provider produces one
 * — `turn.proposed.*` runtime events through the real ingestion path — not by
 * dispatching a plan command directly.
 *
 * WHAT IS FAKE: the provider adapter (a scripted fixture, no CLI) and the Peer
 * Loop bridge (a recorder, no subprocess). Nothing else.
 *
 * THE CALL RECORD IS THE POINT. A test that only read rendered strings could
 * not tell a read-only context build from one that quietly started, resumed or
 * messaged a run. Every Peer Loop method is recorded; the mutations and the
 * subscription also die on contact.
 */
import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  defaultInstanceIdForDriver,
  type OrchestrationProposedPlanId,
  type PeerLoopEvent,
  type PeerLoopRunStateFile,
  type PeerLoopRunSummary,
  type PeerLoopSubscriptionEvent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";

import { NAVIGATOR_PROVIDER_FRAME } from "../src/orchestration/navigatorProviderFrame.ts";
import {
  NAVIGATOR_ACTIVITY_HEADING,
  NAVIGATOR_CONTEXT_HEADING,
} from "../src/peerLoop/navigatorExecutionContextFormat.ts";
import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";
import type { TestTurnResponse } from "./TestProviderAdapter.integration.ts";

const PROVIDER = ProviderDriverKind.make("codex");
const PROJECT_ID = ProjectId.make("project-navigator");
const NAVIGATOR_THREAD = ThreadId.make("thread-navigator");
const CODING_THREAD = ThreadId.make("thread-coding");
const RUN_ID = "run-navigator-1";
const NOW = "2026-05-01T00:00:00.000Z";

const PLAN_MARKDOWN = "## Split the migration\n\n- add the column\n- backfill in batches";

const instanceId = defaultInstanceIdForDriver(PROVIDER);
const model = DEFAULT_MODEL_BY_PROVIDER[PROVIDER] ?? DEFAULT_MODEL;

const runtimeBase = (id: string) => ({
  eventId: EventId.make(id),
  provider: PROVIDER,
  createdAt: NOW,
});

/** A turn that says something and nothing else. */
const conversationTurn = (id: string, text: string): TestTurnResponse => ({
  events: [
    {
      type: "turn.started",
      ...runtimeBase(`${id}-started`),
      threadId: NAVIGATOR_THREAD,
      turnId: id,
    },
    {
      type: "message.delta",
      ...runtimeBase(`${id}-delta`),
      threadId: NAVIGATOR_THREAD,
      turnId: id,
      delta: text,
    },
    {
      type: "turn.completed",
      ...runtimeBase(`${id}-completed`),
      threadId: NAVIGATOR_THREAD,
      turnId: id,
      status: "completed",
    },
  ],
});

/**
 * A turn that produces a proposed plan the way a provider does.
 *
 * `turn.proposed.completed` is the real runtime event; the real ingestion layer
 * turns it into a `thread.proposed-plan.upsert` command and the real decider
 * and projectors give it an id. Nothing here dispatches a plan command.
 */
const planTurn = (id: string, planMarkdown: string): TestTurnResponse => ({
  events: [
    {
      type: "turn.started",
      ...runtimeBase(`${id}-started`),
      threadId: NAVIGATOR_THREAD,
      turnId: id,
    },
    {
      type: "turn.proposed.completed",
      ...runtimeBase(`${id}-plan`),
      threadId: NAVIGATOR_THREAD,
      turnId: id,
      payload: { planMarkdown },
    },
    {
      type: "message.delta",
      ...runtimeBase(`${id}-delta`),
      threadId: NAVIGATOR_THREAD,
      turnId: id,
      delta: "Here is the proposal.",
    },
    {
      type: "turn.completed",
      ...runtimeBase(`${id}-completed`),
      threadId: NAVIGATOR_THREAD,
      turnId: id,
      status: "completed",
    },
  ],
});

const runSummary = (overrides: Partial<PeerLoopRunSummary> = {}): PeerLoopRunSummary => ({
  runId: RUN_ID,
  projectPath: "/replaced-by-the-test",
  state: "builder_working",
  iteration: 2,
  createdAt: NOW,
  updatedAt: "2026-05-01T00:05:00.000Z",
  haltReason: null,
  inFlight: null,
  queuedOwnerMessages: 0,
  lastSequence: 7,
  awaitingOwnerObjective: false,
  adapters: {
    reviewer: "codex",
    reviewerVersion: null,
    builder: "claude-code",
    builderVersion: null,
  },
  liveWriter: null,
  liveInThisBridge: false,
  ...overrides,
});

const runStateFile = (
  projectPath: string,
  overrides: Partial<PeerLoopRunStateFile> = {},
): PeerLoopRunStateFile =>
  ({
    schemaVersion: 1,
    runId: RUN_ID,
    projectPath,
    state: "done",
    iteration: 3,
    createdAt: NOW,
    updatedAt: "2026-05-01T00:20:00.000Z",
    ownerPolicyText: "",
    builderSessionId: null,
    reviewerThreadId: null,
    repo: null,
    lastBuilderTask: "BUILDER TASK PROSE THAT MUST NOT TRAVEL",
    lastBuilderReport: "BUILDER REPORT PROSE THAT MUST NOT TRAVEL",
    lastReviewerDecision: null,
    queuedOwnerMessages: [],
    inFlight: null,
    haltReason: null,
    stopRequested: false,
    adapters: {
      reviewer: "codex",
      reviewerVersion: null,
      builder: "claude-code",
      builderVersion: null,
    },
    safetyLimit: null,
    lastSequence: 12,
    ...overrides,
  }) as PeerLoopRunStateFile;

/** One replayed `run-event`, as the bridge would deliver it. */
const replayEvent = (input: {
  readonly seq: number;
  readonly payload: PeerLoopEvent["payload"];
}): PeerLoopSubscriptionEvent => ({
  kind: "run-event",
  runId: RUN_ID,
  replay: true,
  event: {
    runId: RUN_ID,
    seq: input.seq,
    ts: `2026-05-01T00:1${String(input.seq)}:00.000Z`,
    type: "run_event",
    actor: "builder",
    iteration: 1,
    payload: input.payload,
  } as PeerLoopEvent,
});

const replaySynced = (afterSeq: number): PeerLoopSubscriptionEvent => ({
  kind: "run-synced",
  runId: RUN_ID,
  afterSeq,
  eventHighWaterMark: afterSeq,
});

function withHarness<A, E>(use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>) {
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({ provider: PROVIDER, peerLoop: true }),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));
}

const seedProject = (harness: OrchestrationIntegrationHarness) =>
  harness.engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("cmd-project"),
    projectId: PROJECT_ID,
    title: "Navigator Project",
    workspaceRoot: harness.workspaceDir,
    defaultModelSelection: { instanceId, model },
    createdAt: NOW,
  });

const createNavigatorThread = (harness: OrchestrationIntegrationHarness) =>
  harness.engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("cmd-navigator-thread"),
    threadId: NAVIGATOR_THREAD,
    projectId: PROJECT_ID,
    title: "Navigator Conversation",
    // The only shape the server accepts for a planning conversation.
    purpose: "navigator",
    modelSelection: { instanceId, model },
    interactionMode: "plan",
    runtimeMode: "approval-required",
    branch: null,
    worktreePath: null,
    createdAt: NOW,
  });

const ownerTurn = (input: {
  readonly harness: OrchestrationIntegrationHarness;
  readonly threadId: ThreadId;
  readonly id: string;
  readonly text: string;
  readonly interactionMode: "plan" | "default";
}) =>
  input.harness.engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(`cmd-${input.id}`),
    threadId: input.threadId,
    message: {
      messageId: MessageId.make(`msg-${input.id}`),
      role: "user",
      text: input.text,
      attachments: [],
    },
    interactionMode: input.interactionMode,
    runtimeMode: "approval-required",
    createdAt: NOW,
  });

/** The provider-visible strings this thread's adapter actually received. */
const sentInputs = (harness: OrchestrationIntegrationHarness, threadId: ThreadId) =>
  harness.adapterHarness!.getSentTurnInputs(threadId);

/**
 * Nothing that changes a run, ever.
 *
 * Deliberately not about `subscribeEvents`: reading a replay is a read, and an
 * explicit deeper question is allowed exactly one. Where a turn must open none,
 * that is asserted at the turn.
 */
const assertNoPeerLoopMutations = (harness: OrchestrationIntegrationHarness) => {
  const calls = harness.peerLoop.calls;
  assert.deepEqual(calls.resumeRun, [], "resumeRun must never be reached");
  assert.deepEqual(calls.pauseRun, [], "pauseRun must never be reached");
  assert.deepEqual(calls.recoverRun, [], "recoverRun must never be reached");
  assert.deepEqual(calls.sendOwnerMessage, [], "sendOwnerMessage must never be reached");
};

it.live("carries one proposal from conversation through execution to a finished run", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProject(harness);
      yield* createNavigatorThread(harness);
      harness.peerLoop.setNextRunId(RUN_ID);

      /* 1. Ordinary conversation, and a proposal that comes out of it. -------- */

      yield* harness.adapterHarness!.queueTurnResponseForNextSession(
        conversationTurn("turn-talk", "Two approaches, then."),
      );
      yield* ownerTurn({
        harness,
        threadId: NAVIGATOR_THREAD,
        id: "talk",
        text: "Compare the two migration approaches.",
        interactionMode: "plan",
      });
      yield* harness.waitForThread(NAVIGATOR_THREAD, (thread) =>
        thread.messages.some((message) => message.role === "assistant" && !message.streaming),
      );

      yield* harness.adapterHarness!.queueTurnResponse(
        NAVIGATOR_THREAD,
        planTurn("turn-plan", PLAN_MARKDOWN),
      );
      yield* ownerTurn({
        harness,
        threadId: NAVIGATOR_THREAD,
        id: "plan",
        text: "Write that up as a proposal.",
        interactionMode: "plan",
      });
      const withPlan = yield* harness.waitForThread(
        NAVIGATOR_THREAD,
        (thread) => thread.proposedPlans.length === 1,
      );
      const plan = withPlan.proposedPlans[0]!;
      assert.equal(plan.planMarkdown, PLAN_MARKDOWN);

      /*
       * TALKING IS NOT EXECUTING. Two turns and a proposal, and the bridge has
       * not been touched once — not even to read.
       */
      assert.deepEqual(harness.peerLoop.calls.startRun, []);
      assert.deepEqual(harness.peerLoop.calls.listRuns, []);
      assert.deepEqual(harness.peerLoop.calls.attachRun, []);
      assertNoPeerLoopMutations(harness);

      // And both provider requests carried the role frame and nothing else.
      const beforeExecution = sentInputs(harness, NAVIGATOR_THREAD);
      assert.equal(beforeExecution.length, 2);
      for (const input of beforeExecution as ReadonlyArray<string>) {
        assert.isTrue(input.startsWith(NAVIGATOR_PROVIDER_FRAME));
        assert.isFalse(input.includes(NAVIGATOR_CONTEXT_HEADING));
      }

      /* 2. Execute that exact proposal. --------------------------------------- */

      const executed = yield* harness.peerLoopExecutionCoordinator
        .executeProposal({
          threadId: NAVIGATOR_THREAD,
          proposedPlanId: plan.id,
        })
        .pipe(Effect.orDie);

      assert.equal(harness.peerLoop.calls.startRun.length, 1);
      const startInput = harness.peerLoop.calls.startRun[0]!;
      // The project's canonical root, and the proposal's own markdown as the
      // objective. Neither came from the caller.
      assert.equal(startInput.projectPath, harness.workspaceDir);
      assert.equal(startInput.objective, PLAN_MARKDOWN);
      // Nothing a client could forge reaches Peer Loop.
      assert.deepEqual(Object.keys(startInput).toSorted(), ["objective", "projectPath"]);
      assert.equal(executed.execution.runId, RUN_ID);
      assert.equal(executed.execution.proposedPlanId, plan.id);

      /* 3. The immutable link is durable. ------------------------------------- */

      const linked = yield* harness.waitForThread(
        NAVIGATOR_THREAD,
        (thread) => thread.peerLoopExecutions.length === 1,
      );
      const link = linked.peerLoopExecutions[0]!;
      assert.equal(link.runId, RUN_ID);
      assert.equal(link.proposedPlanId, plan.id);

      /* 4. Keep talking while the run works. ---------------------------------- */

      harness.peerLoop.setRuns([runSummary({ projectPath: harness.workspaceDir })]);
      yield* harness.adapterHarness!.queueTurnResponse(
        NAVIGATOR_THREAD,
        conversationTurn("turn-during", "It is still going."),
      );
      const duringText = "How is it going?";
      yield* ownerTurn({
        harness,
        threadId: NAVIGATOR_THREAD,
        id: "during",
        text: duringText,
        interactionMode: "plan",
      });
      yield* harness.waitForThread(
        NAVIGATOR_THREAD,
        (thread) => sentInputs(harness, NAVIGATOR_THREAD).length === 3 && thread.id !== undefined,
      );

      const duringInput = sentInputs(harness, NAVIGATOR_THREAD)[2]!;
      assert.isTrue(duringInput.includes(NAVIGATOR_CONTEXT_HEADING));
      assert.isTrue(duringInput.includes(`run ${RUN_ID}`));
      assert.isTrue(duringInput.includes("state: builder_working"));
      assert.isTrue(duringInput.endsWith(duringText));
      // One list read for the turn, and still exactly one start for the loop.
      assert.equal(harness.peerLoop.calls.listRuns.length, 1);
      // "How is it going?" is a status question. No replay, no subscription.
      assert.deepEqual(harness.peerLoop.calls.subscribeEvents, []);
      assert.deepEqual(harness.peerLoop.calls.listRuns[0], {
        projectPath: harness.workspaceDir,
      });
      assert.equal(harness.peerLoop.calls.startRun.length, 1);
      // An active run is list-only: no snapshot is worth a second read.
      assert.deepEqual(harness.peerLoop.calls.attachRun, []);
      assertNoPeerLoopMutations(harness);

      // The transcript holds what the Owner typed, not what the provider saw.
      const duringThread = yield* harness.waitForThread(NAVIGATOR_THREAD, (thread) =>
        thread.messages.some((message) => message.id === MessageId.make("msg-during")),
      );
      const storedDuring = duringThread.messages.find(
        (message) => message.id === MessageId.make("msg-during"),
      );
      assert.equal(storedDuring?.text, duringText);

      /* 5. The run finishes. Ask what changed. -------------------------------- */

      harness.peerLoop.setRuns([
        runSummary({ projectPath: harness.workspaceDir, state: "done", iteration: 3 }),
      ]);
      harness.peerLoop.setSnapshot(
        RUN_ID,
        runStateFile(harness.workspaceDir, {
          lastReviewerDecision: {
            decision: "DONE",
            summary: "Column added and backfilled in batches.",
            finalState: "Green on main, migration applied.",
          },
          repo: {
            head: "abc123def456",
            branch: "main",
            worktreeDigest: null,
            isGitRepo: true,
            capturedAt: "2026-05-01T00:20:00.000Z",
          },
        }),
      );

      yield* harness.adapterHarness!.queueTurnResponse(
        NAVIGATOR_THREAD,
        conversationTurn("turn-after", "It finished; here is what changed."),
      );
      const afterText = "What changed?";
      yield* ownerTurn({
        harness,
        threadId: NAVIGATOR_THREAD,
        id: "after",
        text: afterText,
        interactionMode: "plan",
      });
      yield* harness.waitForThread(
        NAVIGATOR_THREAD,
        () => sentInputs(harness, NAVIGATOR_THREAD).length === 4,
      );

      const afterInput = sentInputs(harness, NAVIGATOR_THREAD)[3]!;
      assert.isTrue(afterInput.includes("state: done"));
      assert.isTrue(
        afterInput.includes("reviewer summary: Column added and backfilled in batches."),
      );
      assert.isTrue(afterInput.includes("final state: Green on main, migration applied."));
      assert.isTrue(afterInput.includes("repository: HEAD abc123def456 on main"));
      assert.isTrue(afterInput.endsWith(afterText));
      // Prose from the run state file is on the same object and never travels.
      assert.isFalse(afterInput.includes("BUILDER TASK PROSE"));
      assert.isFalse(afterInput.includes("BUILDER REPORT PROSE"));
      // DONE is worth exactly one snapshot read, and no mutation at all.
      assert.deepEqual(harness.peerLoop.calls.attachRun, [RUN_ID]);
      // "What changed?" is answered by the structured DONE decision. Still no
      // subscription: the deeper gate has not been asked to open.
      assert.deepEqual(harness.peerLoop.calls.subscribeEvents, []);
      assert.equal(harness.peerLoop.calls.startRun.length, 1);
      assertNoPeerLoopMutations(harness);

      const afterThread = yield* harness.waitForThread(NAVIGATOR_THREAD, (thread) =>
        thread.messages.some((message) => message.id === MessageId.make("msg-after")),
      );
      assert.equal(
        afterThread.messages.find((message) => message.id === MessageId.make("msg-after"))?.text,
        afterText,
      );

      /* 6. The conversation is still a conversation. -------------------------- */

      yield* harness.adapterHarness!.queueTurnResponse(
        NAVIGATOR_THREAD,
        conversationTurn("turn-next", "Sure — what next?"),
      );
      yield* ownerTurn({
        harness,
        threadId: NAVIGATOR_THREAD,
        id: "next",
        text: "Good. What should we plan next?",
        interactionMode: "plan",
      });
      const finalThread = yield* harness.waitForThread(
        NAVIGATOR_THREAD,
        () => sentInputs(harness, NAVIGATOR_THREAD).length === 5,
      );

      // Same durable thread, same single link, still accepting turns.
      assert.equal(finalThread.id, NAVIGATOR_THREAD);
      assert.equal(finalThread.purpose, "navigator");
      assert.equal(finalThread.peerLoopExecutions.length, 1);
      assert.equal(finalThread.archivedAt, null);
      assert.equal(harness.peerLoop.calls.startRun.length, 1);
      // Four ordinary turns, and not one of them opened a replay.
      assert.deepEqual(harness.peerLoop.calls.subscribeEvents, []);
      assertNoPeerLoopMutations(harness);

      /* 7. Ask for the detail explicitly. ------------------------------------- */

      harness.peerLoop.setReplay(RUN_ID, [
        replayEvent({ seq: 1, payload: { kind: "run_started" } }),
        replayEvent({
          seq: 2,
          payload: { kind: "builder_task", task: "Add the column with a default." },
        }),
        replayEvent({
          seq: 3,
          payload: {
            kind: "builder_report",
            report: "Column added; backfilled 1200 rows.",
            // Not an allowlisted field on this kind, so it must not travel.
            cwd: "/private/tmp/should-not-travel",
          },
        }),
        replaySynced(3),
        // Anything after the boundary is a live event. Reaching it would mean
        // the turn was still attached, which is the failure this guards.
        replayEvent({
          seq: 4,
          payload: { kind: "notice", message: "LIVE AFTER SYNC" },
        }),
      ]);

      yield* harness.adapterHarness!.queueTurnResponse(
        NAVIGATOR_THREAD,
        conversationTurn("turn-detail", "Here is what happened, step by step."),
      );
      const detailText = "What happened step by step?";
      yield* ownerTurn({
        harness,
        threadId: NAVIGATOR_THREAD,
        id: "detail",
        text: detailText,
        interactionMode: "plan",
      });
      yield* harness.waitForThread(
        NAVIGATOR_THREAD,
        () => sentInputs(harness, NAVIGATOR_THREAD).length === 6,
      );

      const detailInput = sentInputs(harness, NAVIGATOR_THREAD)[5]!;
      // Exactly one subscription, for the one linked run, once.
      assert.deepEqual(harness.peerLoop.calls.subscribeEvents, [RUN_ID]);
      // The compact facts still come first; the activity is an addition.
      assert.isTrue(detailInput.startsWith(NAVIGATOR_PROVIDER_FRAME));
      assert.isTrue(detailInput.includes(NAVIGATOR_CONTEXT_HEADING));
      assert.isTrue(detailInput.includes(NAVIGATOR_ACTIVITY_HEADING));
      assert.equal(detailInput.split(NAVIGATOR_ACTIVITY_HEADING).length, 2);
      assert.isTrue(
        detailInput.indexOf(NAVIGATOR_CONTEXT_HEADING) <
          detailInput.indexOf(NAVIGATOR_ACTIVITY_HEADING),
      );
      assert.isTrue(detailInput.includes("task: Add the column with a default."));
      assert.isTrue(detailInput.includes("report: Column added; backfilled 1200 rows."));
      // Stopped at the boundary; the live event was never observed.
      assert.isFalse(detailInput.includes("LIVE AFTER SYNC"));
      // A field outside the allowlist for that kind never travels.
      assert.isFalse(detailInput.includes("/private/tmp/should-not-travel"));
      // The Owner's words are still last, and still exactly theirs.
      assert.isTrue(detailInput.endsWith(detailText));
      assert.isTrue(detailInput.length <= 12_000 + NAVIGATOR_PROVIDER_FRAME.length + 256);
      // Reading is not acting.
      assert.equal(harness.peerLoop.calls.startRun.length, 1);
      assertNoPeerLoopMutations(harness);

      const detailThread = yield* harness.waitForThread(NAVIGATOR_THREAD, (thread) =>
        thread.messages.some((message) => message.id === MessageId.make("msg-detail")),
      );
      assert.equal(
        detailThread.messages.find((message) => message.id === MessageId.make("msg-detail"))?.text,
        detailText,
      );
    }),
  ),
);

it.live("explains an OWNER_REQUIRED run without offering to answer it", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProject(harness);
      yield* createNavigatorThread(harness);
      harness.peerLoop.setNextRunId(RUN_ID);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession(
        planTurn("turn-plan", PLAN_MARKDOWN),
      );
      yield* ownerTurn({
        harness,
        threadId: NAVIGATOR_THREAD,
        id: "plan",
        text: "Draft the proposal.",
        interactionMode: "plan",
      });
      const withPlan = yield* harness.waitForThread(
        NAVIGATOR_THREAD,
        (thread) => thread.proposedPlans.length === 1,
      );
      const planId = withPlan.proposedPlans[0]!.id as OrchestrationProposedPlanId;

      yield* harness.peerLoopExecutionCoordinator
        .executeProposal({ threadId: NAVIGATOR_THREAD, proposedPlanId: planId })
        .pipe(Effect.orDie);
      yield* harness.waitForThread(
        NAVIGATOR_THREAD,
        (thread) => thread.peerLoopExecutions.length === 1,
      );

      harness.peerLoop.setRuns([
        runSummary({
          projectPath: harness.workspaceDir,
          state: "owner_required",
          haltReason: { kind: "OWNER_REQUIRED", message: "free text that must not travel" },
        }),
      ]);
      harness.peerLoop.setSnapshot(
        RUN_ID,
        runStateFile(harness.workspaceDir, {
          state: "owner_required",
          lastReviewerDecision: {
            decision: "OWNER_REQUIRED",
            summary: "Blocked on a choice.",
            ownerQuestion: "Which database should the backfill target?",
            whyOwnerIsRequired: "Both are in use and only you know which is canonical.",
            options: ["Primary", "Replica"],
          },
        }),
      );

      yield* harness.adapterHarness!.queueTurnResponse(
        NAVIGATOR_THREAD,
        conversationTurn("turn-owner", "It is waiting on you."),
      );
      yield* ownerTurn({
        harness,
        threadId: NAVIGATOR_THREAD,
        id: "owner",
        text: "Is it stuck?",
        interactionMode: "plan",
      });
      yield* harness.waitForThread(
        NAVIGATOR_THREAD,
        () => sentInputs(harness, NAVIGATOR_THREAD).length === 2,
      );

      const input = sentInputs(harness, NAVIGATOR_THREAD)[1]!;
      assert.isTrue(input.includes("state: owner_required"));
      assert.isTrue(input.includes("owner question: Which database should the backfill target?"));
      assert.isTrue(
        input.includes(
          "why the owner is required: Both are in use and only you know which is canonical.",
        ),
      );
      assert.isTrue(input.includes("option: Primary"));
      assert.isTrue(input.includes("option: Replica"));
      // The halt's free-text message is not structured and does not travel.
      assert.isFalse(input.includes("free text that must not travel"));
      // Read-only: one list, one snapshot, and nothing that could answer.
      assert.equal(harness.peerLoop.calls.listRuns.length, 1);
      assert.deepEqual(harness.peerLoop.calls.attachRun, [RUN_ID]);
      // "Is it stuck?" is a status question: the structured question answers
      // it, so no replay is opened.
      assert.deepEqual(harness.peerLoop.calls.subscribeEvents, []);
      assertNoPeerLoopMutations(harness);

      /*
       * AND THE CONVERSATION IS STILL A CONVERSATION. Answering the question is
       * an explicit action in the execution details; a Navigator turn about it
       * is a turn like any other.
       */
      yield* harness.adapterHarness!.queueTurnResponse(
        NAVIGATOR_THREAD,
        conversationTurn("turn-owner-2", "Primary sounds right to me."),
      );
      yield* ownerTurn({
        harness,
        threadId: NAVIGATOR_THREAD,
        id: "owner-2",
        text: "Which would you pick?",
        interactionMode: "plan",
      });
      const thread = yield* harness.waitForThread(
        NAVIGATOR_THREAD,
        () => sentInputs(harness, NAVIGATOR_THREAD).length === 3,
      );
      assert.equal(thread.peerLoopExecutions.length, 1);
      assert.equal(harness.peerLoop.calls.startRun.length, 1);
      assert.deepEqual(harness.peerLoop.calls.subscribeEvents, []);
      assertNoPeerLoopMutations(harness);
    }),
  ),
);

it.live("leaves a coding thread's provider text byte for byte, and asks Peer Loop nothing", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      yield* seedProject(harness);
      yield* harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-coding-thread"),
        threadId: CODING_THREAD,
        projectId: PROJECT_ID,
        title: "Coding Thread",
        purpose: "coding",
        modelSelection: { instanceId, model },
        interactionMode: "default",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: harness.workspaceDir,
        createdAt: NOW,
      });

      const ownerText = "Rename the column and update the callers.";
      yield* harness.adapterHarness!.queueTurnResponseForNextSession({
        events: [
          {
            type: "turn.started",
            ...runtimeBase("coding-started"),
            threadId: CODING_THREAD,
            turnId: "turn-coding",
          },
          {
            type: "turn.completed",
            ...runtimeBase("coding-completed"),
            threadId: CODING_THREAD,
            turnId: "turn-coding",
            status: "completed",
          },
        ],
      });
      yield* ownerTurn({
        harness,
        threadId: CODING_THREAD,
        id: "coding",
        text: ownerText,
        interactionMode: "default",
      });
      yield* harness.waitForThread(
        CODING_THREAD,
        () => sentInputs(harness, CODING_THREAD).length === 1,
      );

      // Identical, not merely equivalent. No frame, no context, no wrapper.
      assert.deepEqual(sentInputs(harness, CODING_THREAD), [ownerText]);
      // And the real context service was consulted and returned before asking
      // the bridge anything at all.
      assert.deepEqual(harness.peerLoop.calls.listRuns, []);
      assert.deepEqual(harness.peerLoop.calls.attachRun, []);
      assert.deepEqual(harness.peerLoop.calls.startRun, []);
      assert.deepEqual(harness.peerLoop.calls.subscribeEvents, []);
      assertNoPeerLoopMutations(harness);
    }),
  ),
);
