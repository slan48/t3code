/**
 * NavigatorExecutionContext, against fake services.
 *
 * The assertions that matter here are about *calls*, not strings: which
 * conversations reach the Peer Loop bridge at all, how many times, scoped to
 * what, and which methods are reachable from a read that is supposed to be
 * read-only. Every mutation and the subscription die on contact, so a context
 * build that touched one fails the test that provoked it.
 */
import type {
  OrchestrationPeerLoopExecution,
  OrchestrationProposedPlanId,
  PeerLoopAttachRunInput,
  PeerLoopListRunsInput,
  PeerLoopRunStateFile,
  PeerLoopRunSummary,
} from "@t3tools/contracts";
import { PeerLoopUnavailableError, ProjectId, ThreadId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  layer as NavigatorExecutionContextLayer,
  NavigatorExecutionContext,
  type NavigatorExecutionContextThread,
} from "./NavigatorExecutionContext.ts";
import {
  NAVIGATOR_CONTEXT_MAX_ATTACHMENTS,
  NAVIGATOR_CONTEXT_MAX_LINKS,
} from "./navigatorExecutionContextFormat.ts";
import { PeerLoopService } from "./Service.ts";

const THREAD_ID = ThreadId.make("thread-navigator-1");
const PROJECT_ID = ProjectId.make("project-1");
const WORKSPACE_ROOT = "/Users/owner/repos/demo";

const link = (input: {
  readonly runId: string;
  readonly createdAt?: string;
}): OrchestrationPeerLoopExecution => ({
  runId: input.runId,
  proposedPlanId: "plan-1" as OrchestrationProposedPlanId,
  createdAt: input.createdAt ?? "2026-03-01T10:00:00.000Z",
});

const summary = (overrides: Partial<PeerLoopRunSummary> = {}): PeerLoopRunSummary => ({
  runId: "run-77",
  projectPath: WORKSPACE_ROOT,
  state: "builder_working",
  iteration: 4,
  createdAt: "2026-03-01T09:00:00.000Z",
  updatedAt: "2026-03-01T10:05:00.000Z",
  haltReason: null,
  inFlight: null,
  queuedOwnerMessages: 0,
  lastSequence: 12,
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

const stateFile = (overrides: Partial<PeerLoopRunStateFile> = {}): PeerLoopRunStateFile =>
  ({
    schemaVersion: 1,
    runId: "run-77",
    projectPath: WORKSPACE_ROOT,
    state: "done",
    iteration: 5,
    createdAt: "2026-03-01T09:00:00.000Z",
    updatedAt: "2026-03-01T10:05:00.000Z",
    ownerPolicyText: "",
    builderSessionId: null,
    reviewerThreadId: null,
    repo: null,
    lastBuilderTask: null,
    lastBuilderReport: null,
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
    lastSequence: 20,
    ...overrides,
  }) as PeerLoopRunStateFile;

const navigatorThread = (
  links: ReadonlyArray<OrchestrationPeerLoopExecution>,
): NavigatorExecutionContextThread => ({
  id: THREAD_ID,
  purpose: "navigator",
  projectId: PROJECT_ID,
  peerLoopExecutions: links,
});

interface Calls {
  readonly list: Array<PeerLoopListRunsInput>;
  readonly attach: Array<string>;
  readonly projectLookups: Array<ProjectId>;
}

const harness = (options?: {
  readonly runs?: ReadonlyArray<PeerLoopRunSummary> | "fail";
  readonly unreadable?: ReadonlyArray<string>;
  readonly snapshots?: Readonly<Record<string, PeerLoopRunStateFile | "fail">>;
  readonly project?: "missing" | "fails";
}) => {
  const calls: Calls = { list: [], attach: [], projectLookups: [] };

  const peerLoopLayer = Layer.mock(PeerLoopService)({
    listRuns: (input: PeerLoopListRunsInput) => {
      calls.list.push(input);
      return options?.runs === "fail"
        ? Effect.fail(new PeerLoopUnavailableError({ reason: "bridge is not installed" }))
        : Effect.succeed({ runs: options?.runs ?? [], unreadable: options?.unreadable ?? [] });
    },
    attachRun: (input: PeerLoopAttachRunInput) => {
      calls.attach.push(input.runId);
      const snapshot = options?.snapshots?.[input.runId];
      if (snapshot === undefined || snapshot === "fail") {
        return Effect.fail(new PeerLoopUnavailableError({ reason: "snapshot unavailable" }));
      }
      return Effect.succeed({
        runId: input.runId,
        state: snapshot,
        control: { available: false, reason: "not_attached", resumable: true, liveWriter: null },
        eventHighWaterMark: 0,
        replayFromSeq: 0,
        live: false,
      });
    },
    /*
     * EVERY MUTATION AND THE SUBSCRIPTION DIE.
     *
     * This is the assertion, not a convenience: a context build that started,
     * resumed, paused, recovered, messaged or subscribed to a run would fail
     * whichever test provoked it rather than passing quietly.
     */
    status: () => Effect.die("status is not part of building context"),
    startRun: () => Effect.die("startRun is not part of building context"),
    resumeRun: () => Effect.die("resumeRun is not part of building context"),
    sendOwnerMessage: () => Effect.die("sendOwnerMessage is not part of building context"),
    pauseRun: () => Effect.die("pauseRun is not part of building context"),
    recoverRun: () => Effect.die("recoverRun is not part of building context"),
    subscribeEvents: () => Stream.die("subscribeEvents is not part of building context"),
    diagnostics: Effect.succeed([]),
  });

  const snapshotLayer = Layer.mock(ProjectionSnapshotQuery)({
    getProjectShellById: (projectId) => {
      calls.projectLookups.push(projectId);
      if (options?.project === "fails") {
        return Effect.fail(new Error("projection unavailable") as never);
      }
      return Effect.succeed(
        options?.project === "missing"
          ? Option.none()
          : Option.some({
              id: PROJECT_ID,
              title: "Demo",
              workspaceRoot: WORKSPACE_ROOT,
            }),
      ) as never;
    },
    getThreadDetailById: () => Effect.die("unused"),
    getCommandReadModel: () => Effect.die("unused"),
    getSnapshot: () => Effect.die("unused"),
    getShellSnapshot: () => Effect.die("unused"),
    getArchivedShellSnapshot: () => Effect.die("unused"),
    getSnapshotSequence: () => Effect.die("unused"),
    getCounts: () => Effect.die("unused"),
    getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
  });

  const layer = NavigatorExecutionContextLayer.pipe(
    Layer.provide(peerLoopLayer),
    Layer.provide(snapshotLayer),
  );
  return { calls, layer } as const;
};

/* ------------------------------------------------------ the no-query line */

describe("conversations that never touch Peer Loop", () => {
  it.effect("a coding thread gets no context and makes no call", () => {
    const { calls, layer } = harness({ runs: [summary()] });
    return Effect.gen(function* () {
      const context = yield* NavigatorExecutionContext;
      const result = yield* context.forThread({
        id: THREAD_ID,
        purpose: "coding",
        projectId: PROJECT_ID,
        peerLoopExecutions: [link({ runId: "run-77" })],
      });
      // Null, so the provider text is the owner's byte for byte.
      expect(result).toBeNull();
      // AND nothing was asked. Not "asked and ignored".
      expect(calls.list).toEqual([]);
      expect(calls.attach).toEqual([]);
      expect(calls.projectLookups).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a Navigator thread with no links gets no context and makes no call", () => {
    const { calls, layer } = harness({ runs: [summary()] });
    return Effect.gen(function* () {
      const context = yield* NavigatorExecutionContext;
      expect(yield* context.forThread(navigatorThread([]))).toBeNull();
      // THE BOUNDARY THAT KEEPS AN UNUSED INSTALL FROM SPAWNING THE BRIDGE.
      // The first Peer Loop call is what starts `peer-loop`; a conversation
      // that has executed nothing must never make one.
      expect(calls.list).toEqual([]);
      expect(calls.attach).toEqual([]);
      expect(calls.projectLookups).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});

/* -------------------------------------------------------------- listing */

describe("reading the project's runs", () => {
  it.effect("asks once, scoped to the thread's own workspace root", () => {
    const { calls, layer } = harness({ runs: [summary()] });
    return Effect.gen(function* () {
      const context = yield* NavigatorExecutionContext;
      yield* context.forThread(navigatorThread([link({ runId: "run-77" })]));
      expect(calls.list).toEqual([{ projectPath: WORKSPACE_ROOT }]);
      expect(calls.projectLookups).toEqual([PROJECT_ID]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks once even when the conversation has many links", () => {
    const { calls, layer } = harness({ runs: [] });
    return Effect.gen(function* () {
      const context = yield* NavigatorExecutionContext;
      yield* context.forThread(
        navigatorThread(
          Array.from({ length: 12 }, (_, index) =>
            link({
              runId: `run-${String(index)}`,
              createdAt: `2026-03-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
            }),
          ),
        ),
      );
      expect(calls.list).toHaveLength(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("shows only linked runs, never the project's others", () => {
    const { layer } = harness({
      runs: [
        summary({ runId: "run-mine", state: "paused" }),
        summary({ runId: "run-someone-elses", state: "builder_working" }),
      ],
    });
    return Effect.gen(function* () {
      const context = yield* NavigatorExecutionContext;
      const result = yield* context.forThread(navigatorThread([link({ runId: "run-mine" })]));
      expect(result).toContain("run-mine");
      // The join is strictly by linked run id. Another run in the same project
      // is not this conversation's business.
      expect(result).not.toContain("run-someone-elses");
      expect(result).toContain("state: paused");
    }).pipe(Effect.provide(layer));
  });

  it.effect("describes only the most recent links, newest first", () => {
    const { layer } = harness({ runs: [] });
    return Effect.gen(function* () {
      const context = yield* NavigatorExecutionContext;
      const result =
        (yield* context.forThread(
          navigatorThread(
            Array.from({ length: NAVIGATOR_CONTEXT_MAX_LINKS + 4 }, (_, index) =>
              link({
                runId: `run-${String(index).padStart(2, "0")}`,
                createdAt: `2026-03-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
              }),
            ),
          ),
        )) ?? "";
      expect(result).toContain(`1. run run-${String(NAVIGATOR_CONTEXT_MAX_LINKS + 3)}`);
      expect(result).not.toContain("run-00");
      expect(result.match(/^\d+\. run /gmu) ?? []).toHaveLength(NAVIGATOR_CONTEXT_MAX_LINKS);
    }).pipe(Effect.provide(layer));
  });

  it.effect("names a linked run the list does not carry, and one it cannot read", () => {
    const { layer } = harness({ runs: [], unreadable: ["run-broken"] });
    return Effect.gen(function* () {
      const context = yield* NavigatorExecutionContext;
      const result =
        (yield* context.forThread(
          navigatorThread([
            link({ runId: "run-gone", createdAt: "2026-03-02T10:00:00.000Z" }),
            link({ runId: "run-broken", createdAt: "2026-03-01T10:00:00.000Z" }),
          ]),
        )) ?? "";
      expect(result).toContain("not currently listing this run");
      expect(result).toContain("could not read this run's record");
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports working, paused, interrupted and driverless from the summary alone", () => {
    const { calls, layer } = harness({
      runs: [
        summary({ runId: "run-a", state: "builder_working", liveWriter: null }),
        summary({ runId: "run-b", state: "paused" }),
        summary({ runId: "run-c", state: "interrupted" }),
      ],
    });
    return Effect.gen(function* () {
      const context = yield* NavigatorExecutionContext;
      const result =
        (yield* context.forThread(
          navigatorThread([
            link({ runId: "run-a", createdAt: "2026-03-03T10:00:00.000Z" }),
            link({ runId: "run-b", createdAt: "2026-03-02T10:00:00.000Z" }),
            link({ runId: "run-c", createdAt: "2026-03-01T10:00:00.000Z" }),
          ]),
        )) ?? "";
      expect(result).toContain("state: builder_working");
      expect(result).toContain("state: paused");
      expect(result).toContain("state: interrupted");
      expect(result).toContain("live writer: no");
      // None of them is DONE or OWNER_REQUIRED, so none is attached.
      expect(calls.attach).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});

/* ----------------------------------------------------------- attaching */

describe("the second, structured read", () => {
  it.effect("attaches only DONE and OWNER_REQUIRED links", () => {
    const { calls, layer } = harness({
      runs: [
        summary({ runId: "run-done", state: "done" }),
        summary({ runId: "run-active", state: "builder_working" }),
        summary({ runId: "run-owner", state: "owner_required" }),
      ],
      snapshots: {
        "run-done": stateFile({
          lastReviewerDecision: {
            decision: "DONE",
            summary: "Backfill shipped.",
            finalState: "Green on main.",
          },
          repo: {
            head: "abc123",
            branch: "main",
            worktreeDigest: null,
            isGitRepo: true,
            capturedAt: "2026-03-01T10:05:00.000Z",
          },
        }),
        "run-owner": stateFile({
          state: "owner_required",
          lastReviewerDecision: {
            decision: "OWNER_REQUIRED",
            summary: "Blocked.",
            ownerQuestion: "Which database?",
            whyOwnerIsRequired: "Both are in use.",
            options: ["Primary", "Replica"],
          },
        }),
      },
    });
    return Effect.gen(function* () {
      const context = yield* NavigatorExecutionContext;
      const result =
        (yield* context.forThread(
          navigatorThread([
            link({ runId: "run-done", createdAt: "2026-03-03T10:00:00.000Z" }),
            link({ runId: "run-active", createdAt: "2026-03-02T10:00:00.000Z" }),
            link({ runId: "run-owner", createdAt: "2026-03-01T10:00:00.000Z" }),
          ]),
        )) ?? "";

      expect(calls.attach.toSorted()).toEqual(["run-done", "run-owner"]);
      expect(result).toContain("reviewer summary: Backfill shipped.");
      expect(result).toContain("final state: Green on main.");
      expect(result).toContain("repository: HEAD abc123 on main");
      expect(result).toContain("owner question: Which database?");
      expect(result).toContain("why the owner is required: Both are in use.");
      expect(result).toContain("option: Primary");
      expect(result).toContain("option: Replica");
    }).pipe(Effect.provide(layer));
  });

  it.effect("never attaches more than the per-turn limit", () => {
    const runIds = Array.from({ length: 8 }, (_, index) => `run-${String(index)}`);
    const { calls, layer } = harness({
      runs: runIds.map((runId) => summary({ runId, state: "done" })),
    });
    return Effect.gen(function* () {
      const context = yield* NavigatorExecutionContext;
      yield* context.forThread(
        navigatorThread(
          runIds.map((runId, index) =>
            link({
              runId,
              createdAt: `2026-03-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
            }),
          ),
        ),
      );
      // Bounded, and deterministic about which: the most recent qualifying.
      expect(calls.attach).toHaveLength(NAVIGATOR_CONTEXT_MAX_ATTACHMENTS);
      expect(calls.attach.toSorted()).toEqual(["run-4", "run-5", "run-6", "run-7"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("degrades one run to 'structured detail unavailable' when its attach fails", () => {
    const { layer } = harness({
      runs: [
        summary({ runId: "run-ok", state: "done" }),
        summary({ runId: "run-bad", state: "done" }),
      ],
      snapshots: {
        "run-ok": stateFile({
          lastReviewerDecision: { decision: "DONE", summary: "Shipped.", finalState: "Green." },
        }),
        "run-bad": "fail",
      },
    });
    return Effect.gen(function* () {
      const context = yield* NavigatorExecutionContext;
      const result =
        (yield* context.forThread(
          navigatorThread([
            link({ runId: "run-bad", createdAt: "2026-03-02T10:00:00.000Z" }),
            link({ runId: "run-ok", createdAt: "2026-03-01T10:00:00.000Z" }),
          ]),
        )) ?? "";
      // One card degrades; the other still carries its structured answer, and
      // the turn is not failed by either.
      expect(result).toContain("structured detail unavailable");
      expect(result).toContain("reviewer summary: Shipped.");
      expect(result).not.toContain("snapshot unavailable");
    }).pipe(Effect.provide(layer));
  });
});

/* -------------------------------------------------------------- failure */

describe("when Peer Loop cannot be read", () => {
  it.effect("says so in one neutral sentence and never fails the turn", () => {
    const { calls, layer } = harness({ runs: "fail" });
    return Effect.gen(function* () {
      const context = yield* NavigatorExecutionContext;
      const result = (yield* context.forThread(navigatorThread([link({ runId: "run-77" })]))) ?? "";
      expect(result).toContain("Structured execution status is unavailable");
      // Nothing from the Cause reaches the provider. A bridge error is exactly
      // the kind of text that carries paths and diagnostics.
      expect(result).not.toContain("bridge is not installed");
      // And no second attempt was made.
      expect(calls.list).toHaveLength(1);
      expect(calls.attach).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("still names the links it has, with no state claimed for them", () => {
    const { layer } = harness({ runs: "fail" });
    return Effect.gen(function* () {
      const context = yield* NavigatorExecutionContext;
      const result = (yield* context.forThread(navigatorThread([link({ runId: "run-77" })]))) ?? "";
      expect(result).toContain("run run-77");
      expect(result).toContain("not currently listing this run");
    }).pipe(Effect.provide(layer));
  });

  it.effect("says records are unavailable when the project cannot be resolved", () => {
    const { calls, layer } = harness({ project: "missing" });
    return Effect.gen(function* () {
      const context = yield* NavigatorExecutionContext;
      const result = (yield* context.forThread(navigatorThread([link({ runId: "run-77" })]))) ?? "";
      expect(result).toContain("Execution records are unavailable");
      // No canonical workspace root means no scoped list to ask for, and an
      // unscoped one would return other projects' runs.
      expect(calls.list).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("treats a failed projection read the same way", () => {
    const { calls, layer } = harness({ project: "fails" });
    return Effect.gen(function* () {
      const context = yield* NavigatorExecutionContext;
      const result = (yield* context.forThread(navigatorThread([link({ runId: "run-77" })]))) ?? "";
      expect(result).toContain("Execution records are unavailable");
      expect(result).not.toContain("projection unavailable");
      expect(calls.list).toEqual([]);
    }).pipe(Effect.provide(layer));
  });
});
