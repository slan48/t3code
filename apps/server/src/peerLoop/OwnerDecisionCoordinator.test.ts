/**
 * Answering an owner decision, against fake services.
 *
 * The assertions are about CALLS and their ORDER, not about strings: whether
 * the association table was consulted before Peer Loop was touched at all,
 * whether the run was re-read for this request rather than trusted from a
 * cache, and — the one that matters most — exactly what text reached
 * `sendOwnerMessage`. A client sends an index; if anything a client can
 * influence ever reaches a Builder, these tests are the place that has to
 * catch it.
 *
 * The decisions are the two a real run produced: `20260812T062443Z-4eb56b42`
 * asked at iteration 2 and again at iteration 3, so "the run moved on" is
 * modelled on something that actually happened rather than on an invention.
 */
import type {
  PeerLoopAttachRunInput,
  PeerLoopReviewerDecision,
  PeerLoopRunStateFile,
  PeerLoopSendOwnerMessageInput,
} from "@t3tools/contracts";
import {
  PeerLoopCommandRefusedError,
  PeerLoopUnavailableError,
  ThreadId,
} from "@t3tools/contracts";
import { peerLoopDecisionFingerprint } from "@t3tools/shared/peerLoopDecisionFingerprint";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  ProjectionThreadPeerLoopExecutionRepository,
  type ProjectionThreadPeerLoopExecution,
} from "../persistence/Services/ProjectionThreadPeerLoopExecutions.ts";
import {
  layer as OwnerDecisionCoordinatorLayer,
  PeerLoopOwnerDecisionCoordinator,
} from "./OwnerDecisionCoordinator.ts";
import { PeerLoopService } from "./Service.ts";

const THREAD_ID = ThreadId.make("thread-navigator-1");
const OTHER_THREAD_ID = ThreadId.make("thread-navigator-2");
const RUN_ID = "20260812T062443Z-4eb56b42";

/** Iteration 2, event sequence 85 of the real run. */
const DECISION_ITERATION_2 = {
  decision: "OWNER_REQUIRED",
  summary: "The local commit is verified.",
  ownerQuestion: "What should happen next with the verified local commit?",
  whyOwnerIsRequired:
    "Publishing would require adding or using a remote and pushing, while the owner policy reserves that for the owner.",
  options: [
    "Option A — Publish/push it yourself (recommended default).",
    "Option B — In a future instruction, explicitly authorize the assistant to publish.",
    "Option C — Do not publish; keep the commit local only.",
  ],
} satisfies PeerLoopReviewerDecision;

/** Iteration 3, event sequence 112. A different question, same run. */
const DECISION_ITERATION_3 = {
  decision: "OWNER_REQUIRED",
  summary: "The marker commit is verified.",
  ownerQuestion: "What should happen next with the verified local marker commit?",
  whyOwnerIsRequired:
    "Any assistant publishing action would require configuring or using a remote.",
  options: [
    "Keep the commit local only and do not publish.",
    "Publish/push it yourself.",
    "Explicitly authorize assistant publishing in a future instruction.",
  ],
} satisfies PeerLoopReviewerDecision;

const FINGERPRINT_ITERATION_2 = peerLoopDecisionFingerprint({
  ownerQuestion: DECISION_ITERATION_2.ownerQuestion,
  whyOwnerIsRequired: DECISION_ITERATION_2.whyOwnerIsRequired,
  options: DECISION_ITERATION_2.options,
  iteration: 2,
});

const FINGERPRINT_ITERATION_3 = peerLoopDecisionFingerprint({
  ownerQuestion: DECISION_ITERATION_3.ownerQuestion,
  whyOwnerIsRequired: DECISION_ITERATION_3.whyOwnerIsRequired,
  options: DECISION_ITERATION_3.options,
  iteration: 3,
});

const stateFile = (overrides: Partial<PeerLoopRunStateFile> = {}): PeerLoopRunStateFile =>
  ({
    schemaVersion: 1,
    runId: RUN_ID,
    projectPath: "/Users/owner/repos/demo",
    state: "owner_required",
    iteration: 2,
    createdAt: "2026-08-12T06:24:43.000Z",
    updatedAt: "2026-08-12T06:40:00.000Z",
    ownerPolicyText: "OWNER POLICY",
    builderSessionId: null,
    reviewerThreadId: null,
    repo: null,
    lastBuilderTask: null,
    lastBuilderReport: null,
    lastReviewerDecision: DECISION_ITERATION_2,
    queuedOwnerMessages: [],
    inFlight: null,
    haltReason: { kind: "OWNER_REQUIRED", message: "Publish or keep local?" },
    stopRequested: false,
    adapters: {
      reviewer: "codex",
      reviewerVersion: null,
      builder: "claude-code",
      builderVersion: null,
    },
    safetyLimit: null,
    lastSequence: 85,
    ...overrides,
  }) as PeerLoopRunStateFile;

const queuedMessage = {
  id: "queued-1",
  text: "Option C — Do not publish; keep the commit local only.",
  queuedAt: "2026-08-12T06:41:00.000Z",
};

/** The typed error a failed attempt carries, or null. */
const failureOf = (exit: Exit.Exit<unknown, unknown>): unknown =>
  Exit.isFailure(exit) ? Option.getOrNull(Cause.findErrorOption(exit.cause)) : null;

const linkRow = (runId: string): ProjectionThreadPeerLoopExecution =>
  ({
    runId,
    threadId: THREAD_ID,
    proposedPlanId: "plan-1",
    createdAt: "2026-08-12T06:24:43.000Z",
  }) as ProjectionThreadPeerLoopExecution;

/** Every call the operation can make, in the order it made them. */
interface Calls {
  readonly order: Array<string>;
  readonly linkLookups: Array<string>;
  readonly attach: Array<PeerLoopAttachRunInput>;
  readonly sends: Array<PeerLoopSendOwnerMessageInput>;
}

const harness = (options?: {
  /** What the association table holds for the thread. Defaults to this run. */
  readonly links?: ReadonlyArray<ProjectionThreadPeerLoopExecution> | "unreadable";
  /** The state each successive attach returns. The last one repeats. */
  readonly states?: ReadonlyArray<PeerLoopRunStateFile>;
  readonly attachFails?: PeerLoopUnavailableError;
  readonly sendFails?: PeerLoopCommandRefusedError;
}) => {
  const calls: Calls = { order: [], linkLookups: [], attach: [], sends: [] };
  const states = options?.states ?? [stateFile()];

  const repositoryLayer = Layer.mock(ProjectionThreadPeerLoopExecutionRepository)({
    listByThreadId: (input) => {
      calls.order.push("listByThreadId");
      calls.linkLookups.push(input.threadId);
      if (options?.links === "unreadable") {
        return Effect.fail(
          new PersistenceSqlError({
            operation: "ProjectionThreadPeerLoopExecutions.listByThreadId",
            detail: "SQLITE_CORRUPT: database disk image is malformed",
            cause: "disk on fire at /Users/owner/.t3/userdata/state.sqlite",
          }),
        );
      }
      return Effect.succeed(options?.links ?? [linkRow(RUN_ID)]);
    },
    insert: () => Effect.die("insert is not part of answering a decision"),
    deleteByThreadId: () => Effect.die("deleteByThreadId is not part of answering a decision"),
  });

  const peerLoopLayer = Layer.mock(PeerLoopService)({
    attachRun: (input: PeerLoopAttachRunInput) => {
      calls.order.push("attachRun");
      calls.attach.push(input);
      if (options?.attachFails !== undefined) return Effect.fail(options.attachFails);
      const state = states[Math.min(calls.attach.length - 1, states.length - 1)] ?? stateFile();
      return Effect.succeed({
        runId: input.runId,
        state,
        control: {
          available: true,
          reason: "live_in_this_bridge",
          resumable: false,
          liveWriter: null,
        },
        eventHighWaterMark: state.lastSequence,
        replayFromSeq: 0,
        live: false,
      });
    },
    sendOwnerMessage: (input: PeerLoopSendOwnerMessageInput) => {
      calls.order.push("sendOwnerMessage");
      calls.sends.push(input);
      if (options?.sendFails !== undefined) return Effect.fail(options.sendFails);
      return Effect.succeed({
        runId: input.runId,
        queued: false,
        accepted: true,
        queuedOwnerMessages: 0,
      });
    },
    /*
     * EVERYTHING ELSE DIES.
     *
     * Answering a decision reads one run and sends one message. A pause, a
     * resume, a recovery or a second start would fail whichever test provoked
     * it rather than passing quietly.
     */
    status: () => Effect.die("status is not part of answering a decision"),
    listRuns: () => Effect.die("listRuns is not part of answering a decision"),
    startRun: () => Effect.die("startRun is not part of answering a decision"),
    resumeRun: () => Effect.die("resumeRun is not part of answering a decision"),
    pauseRun: () => Effect.die("pauseRun is not part of answering a decision"),
    recoverRun: () => Effect.die("recoverRun is not part of answering a decision"),
    subscribeEvents: () => Stream.die("subscribeEvents is not part of answering a decision"),
    diagnostics: Effect.succeed([]),
  });

  const layer = OwnerDecisionCoordinatorLayer.pipe(
    Layer.provide(Layer.mergeAll(peerLoopLayer, repositoryLayer)),
  );

  const answer = (input?: {
    readonly threadId?: ThreadId;
    readonly runId?: string;
    readonly decisionFingerprint?: string;
    readonly optionIndex?: number;
  }) =>
    Effect.service(PeerLoopOwnerDecisionCoordinator).pipe(
      Effect.flatMap((coordinator) =>
        coordinator.answerOwnerDecision({
          threadId: input?.threadId ?? THREAD_ID,
          runId: input?.runId ?? RUN_ID,
          decisionFingerprint: input?.decisionFingerprint ?? FINGERPRINT_ITERATION_2,
          optionIndex: input?.optionIndex ?? 2,
        }),
      ),
      Effect.provide(layer),
    );

  return { calls, answer } as const;
};

describe("answering the decision the owner was shown", () => {
  it.effect("sends the freshly indexed option text and nothing a client chose", () =>
    Effect.gen(function* () {
      const { calls, answer } = harness();
      const result = yield* answer({ optionIndex: 2 });

      // The text is Peer Loop's own, resolved out of the attach this request
      // made. A client sent the number 2 and never these words.
      expect(calls.sends).toEqual([
        { runId: RUN_ID, text: "Option C — Do not publish; keep the commit local only." },
      ]);
      expect(result).toEqual({
        outcome: "answered",
        delivery: { runId: RUN_ID, queued: false, accepted: true, queuedOwnerMessages: 0 },
        decisionFingerprint: FINGERPRINT_ITERATION_2,
      });
    }),
  );

  it.effect("resolves each index out of the fresh decision's own order", () =>
    Effect.gen(function* () {
      for (const [index, expected] of DECISION_ITERATION_2.options.entries()) {
        const { calls, answer } = harness();
        yield* answer({ optionIndex: index });
        expect(calls.sends[0]?.text, String(index)).toBe(expected);
      }
    }),
  );

  it.effect("does the link check, the attach and the send in that order", () =>
    Effect.gen(function* () {
      const { calls, answer } = harness();
      yield* answer();
      // Entitlement before the bridge is touched; the reading before the send.
      expect(calls.order).toEqual(["listByThreadId", "attachRun", "sendOwnerMessage"]);
      expect(calls.linkLookups).toEqual([THREAD_ID]);
      expect(calls.attach).toEqual([{ runId: RUN_ID }]);
    }),
  );

  it.effect("attaches freshly for every attempt, including a second one", () =>
    Effect.gen(function* () {
      // No caching, no memoized snapshot: the whole point of the freshness
      // check is that it is taken now, and a second answer re-reads the run.
      const { calls, answer } = harness();
      yield* answer({ optionIndex: 0 });
      yield* answer({ optionIndex: 1 });
      expect(calls.attach).toEqual([{ runId: RUN_ID }, { runId: RUN_ID }]);
      expect(calls.order).toEqual([
        "listByThreadId",
        "attachRun",
        "sendOwnerMessage",
        "listByThreadId",
        "attachRun",
        "sendOwnerMessage",
      ]);
    }),
  );
});

describe("a view that has gone stale", () => {
  it.effect("does not send when the run is asking a different question", () =>
    Effect.gen(function* () {
      // The real sequence: the run answered iteration 2 and stopped again at
      // iteration 3. An owner still looking at the first question must not
      // have their click applied to the second.
      const { calls, answer } = harness({
        states: [stateFile({ iteration: 3, lastReviewerDecision: DECISION_ITERATION_3 })],
      });
      const result = yield* answer({ decisionFingerprint: FINGERPRINT_ITERATION_2 });

      expect(result).toEqual({
        outcome: "refresh-required",
        reason: "decision-changed",
        currentDecisionFingerprint: FINGERPRINT_ITERATION_3,
      });
      expect(calls.sends).toEqual([]);
      expect(calls.order).toEqual(["listByThreadId", "attachRun"]);
    }),
  );

  it.effect("does not send when the same question moved to another iteration", () =>
    Effect.gen(function* () {
      // Same words, different Reviewer turn. Still a different decision.
      const { calls, answer } = harness({ states: [stateFile({ iteration: 4 })] });
      const result = yield* answer();
      expect(result).toMatchObject({ outcome: "refresh-required", reason: "decision-changed" });
      expect(calls.sends).toEqual([]);
    }),
  );

  it.effect("does not send when an owner response is already queued", () =>
    Effect.gen(function* () {
      const { calls, answer } = harness({
        states: [stateFile({ queuedOwnerMessages: [queuedMessage] })],
      });
      const result = yield* answer();
      expect(result).toEqual({
        outcome: "refresh-required",
        reason: "owner-response-queued",
        currentDecisionFingerprint: FINGERPRINT_ITERATION_2,
      });
      expect(calls.sends).toEqual([]);
    }),
  );

  it.effect("does not send when the run is no longer waiting on its owner", () =>
    Effect.gen(function* () {
      for (const state of ["builder_working", "done", "error", "paused"] as const) {
        const { calls, answer } = harness({ states: [stateFile({ state })] });
        const result = yield* answer();
        expect(result, state).toEqual({
          outcome: "refresh-required",
          reason: "not-owner-required",
          currentDecisionFingerprint: null,
        });
        expect(calls.sends, state).toEqual([]);
      }
    }),
  );

  it.effect("does not send when a waiting run recorded no structured question", () =>
    Effect.gen(function* () {
      // OWNER_REQUIRED with a CONTINUE decision, or none at all. There is no
      // option list to resolve an index against, and inventing one is a guess.
      for (const decision of [
        null,
        { decision: "CONTINUE", summary: "s", builderTask: "t" } as PeerLoopReviewerDecision,
        { decision: "DONE", summary: "s", finalState: "f" } as PeerLoopReviewerDecision,
      ]) {
        const { calls, answer } = harness({
          states: [stateFile({ lastReviewerDecision: decision })],
        });
        const result = yield* answer();
        expect(result).toEqual({
          outcome: "refresh-required",
          reason: "decision-changed",
          currentDecisionFingerprint: null,
        });
        expect(calls.sends).toEqual([]);
      }
    }),
  );

  it.effect("checks freshness before it ever looks at the option index", () =>
    Effect.gen(function* () {
      // An index that could not be resolved, on a decision that has moved on.
      // The stale answer is the honest one, and nothing is sent either way.
      const { calls, answer } = harness({
        states: [stateFile({ iteration: 3, lastReviewerDecision: DECISION_ITERATION_3 })],
      });
      const result = yield* answer({ optionIndex: 99 });
      expect(result).toMatchObject({ outcome: "refresh-required", reason: "decision-changed" });
      expect(calls.sends).toEqual([]);
    }),
  );
});

describe("a request that could not have come from the decision", () => {
  it.effect("refuses a run the conversation never started, before attaching", () =>
    Effect.gen(function* () {
      const { calls, answer } = harness({ links: [linkRow("some-other-run")] });
      const exit = yield* Effect.exit(answer());

      expect(Exit.isFailure(exit)).toBe(true);
      const error = failureOf(exit);
      expect(error).toMatchObject({
        _tag: "PeerLoopOwnerDecisionCoordinationError",
        reason: "run-not-linked-to-thread",
        threadId: THREAD_ID,
        runId: RUN_ID,
      });
      // No attach and no send: an unentitled request never reaches Peer Loop.
      expect(calls.order).toEqual(["listByThreadId"]);
    }),
  );

  it.effect("refuses when another thread holds the link", () =>
    Effect.gen(function* () {
      const { calls, answer } = harness({ links: [] });
      const exit = yield* Effect.exit(answer({ threadId: OTHER_THREAD_ID }));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(calls.linkLookups).toEqual([OTHER_THREAD_ID]);
      expect(calls.attach).toEqual([]);
      expect(calls.sends).toEqual([]);
    }),
  );

  it.effect("refuses an out-of-range index without sending", () =>
    Effect.gen(function* () {
      // The fingerprint matched, so the client rendered these three options and
      // still asked for a fourth. Malformed, not stale.
      const { calls, answer } = harness();
      const exit = yield* Effect.exit(answer({ optionIndex: 3 }));
      expect(Exit.isFailure(exit)).toBe(true);
      const error = failureOf(exit);
      expect(error).toMatchObject({
        _tag: "PeerLoopOwnerDecisionCoordinationError",
        reason: "option-out-of-range",
      });
      expect(calls.sends).toEqual([]);
      expect(calls.order).toEqual(["listByThreadId", "attachRun"]);
    }),
  );

  it.effect("refuses, sanitized, when the association table cannot be read", () =>
    Effect.gen(function* () {
      const { calls, answer } = harness({ links: "unreadable" });
      const exit = yield* Effect.exit(answer());
      const error = failureOf(exit);
      expect(error).toMatchObject({
        _tag: "PeerLoopOwnerDecisionCoordinationError",
        reason: "link-unreadable",
      });
      // NOTHING CAUGHT TRAVELS. No SQL, no path, no cause text.
      const detail = (error as { readonly detail?: string } | null)?.detail ?? "";
      expect(detail).not.toContain("sqlite");
      expect(detail).not.toContain("/Users/");
      expect(detail).not.toContain("disk on fire");
      expect(calls.attach).toEqual([]);
      expect(calls.sends).toEqual([]);
    }),
  );
});

describe("Peer Loop's own failures", () => {
  it.effect("lets an attach failure travel as itself", () =>
    Effect.gen(function* () {
      const { calls, answer } = harness({
        attachFails: new PeerLoopUnavailableError({ reason: "bridge is not installed" }),
      });
      const exit = yield* Effect.exit(answer());
      const error = failureOf(exit);
      // Not flattened into a fabricated "refresh-required": a bridge that is
      // not there is a different problem with a different fix.
      expect(error).toMatchObject({ _tag: "PeerLoopUnavailableError" });
      expect(calls.sends).toEqual([]);
    }),
  );

  it.effect("lets a send refusal travel as itself, with its code", () =>
    Effect.gen(function* () {
      const { calls, answer } = harness({
        sendFails: new PeerLoopCommandRefusedError({
          code: "INVALID_RUN_STATE",
          detail: "the run stopped accepting owner messages",
          data: null,
        }),
      });
      const exit = yield* Effect.exit(answer());
      const error = failureOf(exit);
      expect(error).toMatchObject({
        _tag: "PeerLoopCommandRefusedError",
        code: "INVALID_RUN_STATE",
      });
      // It was attempted exactly once. A refusal is never retried.
      expect(calls.sends).toHaveLength(1);
    }),
  );
});
