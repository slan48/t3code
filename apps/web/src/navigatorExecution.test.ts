/**
 * Who may execute a proposal, what goes on the wire, and what a run card says.
 *
 * The three things that can go badly wrong are all here: an Execute button
 * appearing on a conversation that must not have one, a request carrying a
 * field a client is not allowed to choose, and a child card inventing a
 * lifecycle state for a run Peer Loop is not reporting.
 */
import type {
  EnvironmentId,
  OrchestrationPeerLoopExecution,
  OrchestrationProposedPlanId,
  PeerLoopRunStateFile,
  PeerLoopRunSummary,
} from "@t3tools/contracts";
import {
  PeerLoopCommandRefusedError,
  PeerLoopExecutionCoordinationError,
  PeerLoopTimeoutError,
  PEER_LOOP_EXECUTION_FAILURE_REASONS,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildExecuteProposalRequest,
  describeCoordinationError,
  describeExecution,
  describeExecutionDetail,
  describePeerLoopExecutionError,
  executeProposalAvailability,
  executionSnapshotIsUseful,
  EXECUTION_RESULT_UNKNOWN,
  groupExecutionsByProposal,
  inspectorTargetFor,
  localLinkIsDurable,
  NO_EXECUTION_SNAPSHOT,
  reconcileExecutionLinks,
  selectNavigatorRunListAtom,
  selectNavigatorSnapshotAtom,
  showsExecutionArea,
  type NavigatorExecutionSnapshot,
} from "./navigatorExecution";

const ENVIRONMENT_ID = "environment-local" as EnvironmentId;
const THREAD_ID = ThreadId.make("thread-navigator-1");
const PLAN_ID = "plan-1" as OrchestrationProposedPlanId;
/** Fixed, so the relative-time label is deterministic. */
const NOW_MS = Date.parse("2026-03-01T10:20:00.000Z");

const proposal = (
  overrides: Partial<{ implementedAt: string | null; implementationThreadId: string | null }> = {},
) => ({
  id: PLAN_ID,
  implementedAt: overrides.implementedAt ?? null,
  implementationThreadId: overrides.implementationThreadId ?? null,
});

const eligible = {
  purpose: "navigator" as const,
  isDurableThread: true,
  latestTurnSettled: true,
  proposal: proposal(),
  executionCount: 0,
  executing: false,
  lastAttemptMayHaveStarted: false,
};

const link = (input: {
  readonly runId: string;
  readonly proposedPlanId?: string;
  readonly createdAt?: string;
}): OrchestrationPeerLoopExecution => ({
  runId: input.runId,
  proposedPlanId: (input.proposedPlanId ?? PLAN_ID) as OrchestrationProposedPlanId,
  createdAt: input.createdAt ?? "2026-03-01T10:00:00.000Z",
});

const adapters = {
  reviewer: "codex",
  reviewerVersion: null,
  builder: "claude-code",
  builderVersion: null,
} as const;

const summary = (overrides: Partial<PeerLoopRunSummary> = {}): PeerLoopRunSummary => ({
  runId: "run-1",
  projectPath: "/repos/demo",
  state: "builder_working",
  iteration: 3,
  createdAt: "2026-03-01T09:00:00.000Z",
  updatedAt: "2026-03-01T10:05:00.000Z",
  haltReason: null,
  inFlight: null,
  queuedOwnerMessages: 0,
  lastSequence: 12,
  awaitingOwnerObjective: false,
  adapters,
  liveWriter: {
    pid: 4242,
    host: "workstation",
    command: "start",
    runId: "run-77",
    acquiredAt: "2026-03-01T09:00:00.000Z",
    renewedAt: "2026-03-01T10:05:00.000Z",
    isThisProcess: true,
  },
  liveInThisBridge: true,
  ...overrides,
});

/* --------------------------------------------------------- eligibility */

describe("execute eligibility", () => {
  it("offers the action for a settled, unexecuted proposal on a durable Navigator thread", () => {
    expect(executeProposalAvailability(eligible)).toEqual({
      canExecute: true,
      blockedReason: null,
    });
  });

  it("never offers it on a coding thread", () => {
    // The ordinary plan card must look exactly as it does today. Not disabled —
    // absent, along with everything else about execution.
    expect(executeProposalAvailability({ ...eligible, purpose: "coding" })).toEqual({
      canExecute: false,
      blockedReason: "not-a-navigator-thread",
    });
    expect(executeProposalAvailability({ ...eligible, purpose: undefined }).canExecute).toBe(false);
    expect(showsExecutionArea({ purpose: "coding", isDurableThread: true })).toBe(false);
    expect(showsExecutionArea({ purpose: "navigator", isDurableThread: true })).toBe(true);
  });

  it("never offers it in a draft conversation", () => {
    // A draft has no durable thread id, so there is nothing the server could
    // resolve a project or a proposal from.
    expect(executeProposalAvailability({ ...eligible, isDurableThread: false })).toEqual({
      canExecute: false,
      blockedReason: "draft-conversation",
    });
    expect(showsExecutionArea({ purpose: "navigator", isDurableThread: false })).toBe(false);
  });

  it("waits for the turn to settle, and for a proposal to exist", () => {
    expect(executeProposalAvailability({ ...eligible, latestTurnSettled: false })).toEqual({
      canExecute: false,
      blockedReason: "proposal-not-settled",
    });
    expect(executeProposalAvailability({ ...eligible, proposal: null })).toEqual({
      canExecute: false,
      blockedReason: "no-proposal",
    });
  });

  it("does not offer a second run for a proposal that already has one", () => {
    expect(executeProposalAvailability({ ...eligible, executionCount: 1 })).toEqual({
      canExecute: false,
      blockedReason: "already-executed",
    });
  });

  it("does not offer a run for a proposal a coding thread already implemented", () => {
    expect(
      executeProposalAvailability({
        ...eligible,
        proposal: proposal({ implementedAt: "2026-02-01T00:00:00.000Z" }),
      }).blockedReason,
    ).toBe("already-implemented");
    expect(
      executeProposalAvailability({
        ...eligible,
        proposal: proposal({ implementationThreadId: "thread-coding-9" }),
      }).blockedReason,
    ).toBe("already-implemented");
  });

  it("withholds the action while the last attempt's outcome is unknown", () => {
    // A lost response is not proof the server did nothing. Offering Execute
    // again here is how one intent becomes two Reviewer sessions.
    expect(executeProposalAvailability({ ...eligible, lastAttemptMayHaveStarted: true })).toEqual({
      canExecute: false,
      blockedReason: "outcome-unknown",
    });
  });

  it("reports an in-flight request as its own reason, not as unavailable", () => {
    // The button stays on screen and goes pending; it must not vanish mid-press.
    expect(executeProposalAvailability({ ...eligible, executing: true })).toEqual({
      canExecute: false,
      blockedReason: "executing",
    });
  });
});

/* ------------------------------------------------------------- request */

describe("the request", () => {
  it("carries the environment wrapper and two ids, and nothing forgeable", () => {
    const request = buildExecuteProposalRequest({
      environmentId: ENVIRONMENT_ID,
      threadId: THREAD_ID,
      proposedPlanId: PLAN_ID,
    });
    expect(request).toEqual({
      environmentId: ENVIRONMENT_ID,
      input: { threadId: THREAD_ID, proposedPlanId: PLAN_ID },
    });
    // Enumerated, so a field added later has to be a deliberate decision here.
    expect(Object.keys(request).toSorted()).toEqual(["environmentId", "input"]);
    expect(Object.keys(request.input).toSorted()).toEqual(["proposedPlanId", "threadId"]);
    for (const forbidden of [
      "objective",
      "projectPath",
      "runId",
      "newRun",
      "policy",
      "ownerPolicy",
      "permissionMode",
      "safetyLimit",
    ]) {
      expect(Object.hasOwn(request.input, forbidden)).toBe(false);
    }
  });
});

/* ------------------------------------------------------- reconciliation */

describe("local and durable links", () => {
  it("shows the just-returned link before the read model has it", () => {
    const fresh = link({ runId: "run-77" });
    expect(reconcileExecutionLinks([], [fresh])).toEqual([fresh]);
    expect(localLinkIsDurable([], fresh)).toBe(false);
  });

  it("collapses to one entry once the identical durable link appears", () => {
    const fresh = link({ runId: "run-77" });
    // Same proposal, same run — the same execution, recorded twice. The durable
    // one wins and there is exactly one card.
    const durable = [link({ runId: "run-77", createdAt: "2026-03-01T10:00:01.000Z" })];
    const reconciled = reconcileExecutionLinks(durable, [fresh]);
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toBe(durable[0]);
    expect(localLinkIsDurable(durable, fresh)).toBe(true);
  });

  it("keeps a different run for the same proposal rather than swallowing it", () => {
    const durable = [link({ runId: "run-a" })];
    expect(
      reconcileExecutionLinks(durable, [link({ runId: "run-b" })]).map((e) => e.runId),
    ).toEqual(["run-a", "run-b"]);
  });

  it("groups links under their own proposal, in association order", () => {
    const grouped = groupExecutionsByProposal([
      link({ runId: "run-a", proposedPlanId: "plan-1" }),
      link({ runId: "run-b", proposedPlanId: "plan-2" }),
      link({ runId: "run-c", proposedPlanId: "plan-1" }),
    ]);
    expect(grouped.get("plan-1")?.map((entry) => entry.runId)).toEqual(["run-a", "run-c"]);
    expect(grouped.get("plan-2")?.map((entry) => entry.runId)).toEqual(["run-b"]);
    expect(grouped.get("plan-3")).toBeUndefined();
  });
});

/* --------------------------------------------------------- observation */

describe("the observation boundary", () => {
  const none = Symbol("no-query");

  it("asks for no run list at all when the conversation has executed nothing", () => {
    // THE FIRST PEER LOOP QUERY STARTS THE BRIDGE. Not called, not merely
    // ignored: an install that never executes anything never spawns it.
    const runsAtomFor = vi.fn(() => Symbol("runs"));
    expect(
      selectNavigatorRunListAtom({
        environmentId: ENVIRONMENT_ID,
        linkCount: 0,
        runsAtomFor,
        none,
      }),
    ).toBe(none);
    expect(runsAtomFor).not.toHaveBeenCalled();
  });

  it("asks for no run list when there is no environment to ask", () => {
    const runsAtomFor = vi.fn(() => Symbol("runs"));
    expect(
      selectNavigatorRunListAtom({ environmentId: null, linkCount: 3, runsAtomFor, none }),
    ).toBe(none);
    expect(runsAtomFor).not.toHaveBeenCalled();
  });

  it("reads exactly one list, keyed to the conversation's own environment", () => {
    // Run ids are Peer Loop's and are per-machine. Another environment's list
    // would match this link against a stranger's run.
    const runs = Symbol("runs");
    const runsAtomFor = vi.fn(() => runs);
    expect(
      selectNavigatorRunListAtom({
        environmentId: ENVIRONMENT_ID,
        linkCount: 1,
        runsAtomFor,
        none,
      }),
    ).toBe(runs);
    expect(runsAtomFor).toHaveBeenCalledTimes(1);
    expect(runsAtomFor).toHaveBeenCalledWith(ENVIRONMENT_ID);
  });
});

/* -------------------------------------------------------- child cards */

describe("child execution cards", () => {
  const described = (input: {
    readonly runs?: ReadonlyArray<PeerLoopRunSummary>;
    readonly unreadable?: ReadonlyArray<string>;
  }) =>
    describeExecution({
      link: link({ runId: "run-1" }),
      runs: input.runs ?? [],
      unreadable: input.unreadable ?? [],
      nowMs: NOW_MS,
    });

  it("reads an active run from Peer Loop's structured summary", () => {
    const presentation = described({ runs: [summary()] });
    expect(presentation.status).toMatchObject({
      kind: "summary",
      iteration: 3,
      updatedAt: "2026-03-01T10:05:00.000Z",
    });
    expect(presentation.status.kind === "summary" && presentation.status.attention.key).toBe(
      "running",
    );
  });

  it("uses the shared helper for OWNER_REQUIRED rather than a label of its own", () => {
    const presentation = described({
      runs: [
        summary({
          state: "owner_required",
          haltReason: { kind: "OWNER_REQUIRED", message: "Which database?" },
        }),
      ],
    });
    expect(presentation.status.kind === "summary" && presentation.status.attention).toMatchObject({
      key: "owner-decision",
      actionable: true,
      detail: "Which database?",
    });
  });

  it("calls a working run with no live writer interrupted, not busy", () => {
    const presentation = described({ runs: [summary({ liveWriter: null })] });
    expect(presentation.status.kind === "summary" && presentation.status.attention.key).toBe(
      "driver-missing",
    );
  });

  it("reads failed and done from the run state", () => {
    expect(
      describeExecution({
        link: link({ runId: "run-1" }),
        runs: [summary({ state: "error" })],
        unreadable: [],
        nowMs: NOW_MS,
      }).status,
    ).toMatchObject({ kind: "summary", attention: { key: "failed" } });
    expect(
      describeExecution({
        link: link({ runId: "run-1" }),
        runs: [summary({ state: "done" })],
        unreadable: [],
        nowMs: NOW_MS,
      }).status,
    ).toMatchObject({ kind: "summary", attention: { key: "done" } });
  });

  it("says the status is unavailable rather than inventing one", () => {
    // A run T3 Code cannot see is not a run that is idle, finished or failed.
    expect(described({ runs: [summary({ runId: "run-other" })] }).status).toEqual({
      kind: "unavailable",
    });
  });

  it("says so explicitly when Peer Loop reports the run unreadable", () => {
    expect(described({ unreadable: ["run-1"] }).status).toEqual({ kind: "unreadable" });
  });

  it("keeps the link's own recording time, which is not the run's", () => {
    expect(described({}).linkedAt).toBe("2026-03-01T10:00:00.000Z");
    expect(described({}).runId).toBe("run-1");
  });
});

/* ------------------------------------------------------------ failures */

describe("coordination failures", () => {
  const coordination = (
    reason: (typeof PEER_LOOP_EXECUTION_FAILURE_REASONS)[number],
    overrides: { readonly runId?: string | null; readonly mayHaveStarted?: boolean } = {},
  ) =>
    new PeerLoopExecutionCoordinationError({
      reason,
      detail: "internal detail",
      threadId: THREAD_ID,
      proposedPlanId: PLAN_ID,
      runId: overrides.runId ?? null,
      mayHaveStarted: overrides.mayHaveStarted ?? false,
    });

  it("has bounded owner wording for every reason the contract can produce", () => {
    // The list is the contract's own, so a new reason fails here rather than
    // reaching an owner as `undefined`.
    for (const reason of PEER_LOOP_EXECUTION_FAILURE_REASONS) {
      const failure = describeCoordinationError(coordination(reason));
      expect(failure.presentation.title.length, reason).toBeGreaterThan(0);
      expect(failure.presentation.detail, reason).not.toBeNull();
      expect((failure.presentation.detail ?? "").length, reason).toBeLessThan(400);
      // A coordination reason is not a Peer Loop refusal code and is not
      // dressed as one.
      expect(failure.presentation.code, reason).toBeNull();
    }
  });

  it("says a run exists, names it, and says not to press Execute again", () => {
    const failure = describeCoordinationError(
      coordination("link-not-confirmed", { runId: "run-77", mayHaveStarted: true }),
    );
    expect(failure.mayHaveStarted).toBe(true);
    expect(failure.presentation.mayHaveApplied).toBe(true);
    expect(failure.presentation.tone).toBe("danger");
    // Exact and structured, so recovery is a link rather than retyping an id
    // read out of a sentence.
    expect(failure.inspectorRunId).toBe("run-77");
    expect(failure.presentation.detail).toContain("Do not press Execute again");
  });

  it("points an already-executed proposal at the run it already has", () => {
    const failure = describeCoordinationError(
      coordination("proposal-already-executed", { runId: "run-12" }),
    );
    expect(failure.inspectorRunId).toBe("run-12");
    expect(failure.mayHaveStarted).toBe(false);
    expect(failure.presentation.detail).toContain("Open that execution");
  });

  it("says plainly that nothing started when nothing did", () => {
    for (const reason of [
      "navigator-thread-not-found",
      "not-a-navigator-thread",
      "proposal-not-found",
      "proposal-already-implemented",
      "project-not-found",
      "coordination-failed",
    ] as const) {
      const failure = describeCoordinationError(coordination(reason));
      expect(failure.mayHaveStarted, reason).toBe(false);
      expect(failure.presentation.detail ?? "", reason).toMatch(/othing was started/u);
    }
  });
});

describe("Peer Loop's own failures on this call", () => {
  it("keeps the refusal code and the run a duplicate refusal names", () => {
    const failure = describePeerLoopExecutionError(
      new PeerLoopCommandRefusedError({
        code: "PROJECT_HAS_UNFINISHED_RUN",
        detail: "run-5 is still going",
        data: { runId: "run-5" },
      }),
    );
    expect(failure.presentation.code).toBe("PROJECT_HAS_UNFINISHED_RUN");
    expect(failure.inspectorRunId).toBe("run-5");
    expect(failure.mayHaveStarted).toBe(false);
  });

  it("keeps a timeout's may-have-applied meaning", () => {
    const failure = describePeerLoopExecutionError(
      new PeerLoopTimeoutError({
        method: "peer-loop/execute-proposal",
        timeoutMs: 30_000,
        mayHaveApplied: true,
      }),
    );
    expect(failure.presentation.mayHaveApplied).toBe(true);
    expect(failure.mayHaveStarted).toBe(true);
    expect(failure.presentation.detail).toContain("Nothing was retried");
  });
});

/* ------------------------------------------------ ambiguous failures */

describe("a failure nothing typed explains", () => {
  it("says the result is unknown rather than that nothing started", () => {
    expect(EXECUTION_RESULT_UNKNOWN.mayHaveStarted).toBe(true);
    expect(EXECUTION_RESULT_UNKNOWN.presentation.mayHaveApplied).toBe(true);
    expect(EXECUTION_RESULT_UNKNOWN.presentation.detail).toContain(
      "cannot say whether a run started",
    );
    expect(EXECUTION_RESULT_UNKNOWN.presentation.detail).toContain("Nothing was retried");
    // Bounded and generic: no cause, no exception text, no transport detail.
    expect((EXECUTION_RESULT_UNKNOWN.presentation.detail ?? "").length).toBeLessThan(400);
    expect(EXECUTION_RESULT_UNKNOWN.presentation.code).toBeNull();
  });

  it("sends the owner to the inspector index when there is no run to name", () => {
    expect(inspectorTargetFor(EXECUTION_RESULT_UNKNOWN)).toEqual({ kind: "index" });
  });

  it("names the run when the failure knew one", () => {
    expect(
      inspectorTargetFor(
        describeCoordinationError(
          new PeerLoopExecutionCoordinationError({
            reason: "link-not-confirmed",
            detail: "internal",
            threadId: THREAD_ID,
            proposedPlanId: PLAN_ID,
            runId: "run-77",
            mayHaveStarted: true,
          }),
        ),
      ),
    ).toEqual({ kind: "run", runId: "run-77" });
  });

  it("sends the owner nowhere when the failure proves nothing started", () => {
    // A typed pre-start coordination refusal is authoritative: there is no run
    // to look at, and the owner may safely press Execute again once the cause
    // is fixed.
    const failure = describeCoordinationError(
      new PeerLoopExecutionCoordinationError({
        reason: "project-not-found",
        detail: "internal",
        threadId: THREAD_ID,
        proposedPlanId: PLAN_ID,
        runId: null,
        mayHaveStarted: false,
      }),
    );
    expect(inspectorTargetFor(failure)).toEqual({ kind: "none" });
    expect(
      executeProposalAvailability({
        ...eligible,
        lastAttemptMayHaveStarted: failure.mayHaveStarted,
      }).canExecute,
    ).toBe(true);
  });
});

/* ------------------------------------------- conditional snapshot read */

describe("when a structured snapshot is worth reading", () => {
  const statusFor = (run: PeerLoopRunSummary) =>
    describeExecution({
      link: link({ runId: "run-1" }),
      runs: [run],
      unreadable: [],
      nowMs: NOW_MS,
    }).status;

  it("reads one for DONE and for OWNER_REQUIRED", () => {
    expect(executionSnapshotIsUseful(statusFor(summary({ state: "done" })))).toBe(true);
    expect(executionSnapshotIsUseful(statusFor(summary({ state: "owner_required" })))).toBe(true);
  });

  it("reads none for an ordinary working run, or a driverless or failed one", () => {
    // One `run.attach` per historical child card, for information nobody asked
    // for, is exactly what this avoids.
    expect(executionSnapshotIsUseful(statusFor(summary()))).toBe(false);
    expect(executionSnapshotIsUseful(statusFor(summary({ liveWriter: null })))).toBe(false);
    expect(executionSnapshotIsUseful(statusFor(summary({ state: "error" })))).toBe(false);
    expect(executionSnapshotIsUseful(statusFor(summary({ state: "interrupted" })))).toBe(false);
    expect(executionSnapshotIsUseful(statusFor(summary({ state: "paused" })))).toBe(false);
  });

  it("reads none for a run the list does not carry at all", () => {
    expect(
      executionSnapshotIsUseful(
        describeExecution({
          link: link({ runId: "run-1" }),
          runs: [],
          unreadable: [],
          nowMs: NOW_MS,
        }).status,
      ),
    ).toBe(false);
  });

  it("never asks for a snapshot atom it does not want", () => {
    const none = Symbol("no-query");
    const snapshotAtomFor = vi.fn(() => Symbol("snapshot"));
    expect(
      selectNavigatorSnapshotAtom({
        environmentId: ENVIRONMENT_ID,
        runId: "run-1",
        wanted: false,
        snapshotAtomFor,
        none,
      }),
    ).toBe(none);
    expect(
      selectNavigatorSnapshotAtom({
        environmentId: null,
        runId: "run-1",
        wanted: true,
        snapshotAtomFor,
        none,
      }),
    ).toBe(none);
    expect(snapshotAtomFor).not.toHaveBeenCalled();
  });

  it("keys the snapshot by environment and run, so two copies share one", () => {
    const snapshot = Symbol("snapshot");
    const snapshotAtomFor = vi.fn(() => snapshot);
    const read = () =>
      selectNavigatorSnapshotAtom({
        environmentId: ENVIRONMENT_ID,
        runId: "run-1",
        wanted: true,
        snapshotAtomFor,
        none: Symbol("no-query"),
      });
    expect(read()).toBe(snapshot);
    expect(read()).toBe(snapshot);
    expect(snapshotAtomFor).toHaveBeenCalledWith(ENVIRONMENT_ID, "run-1");
  });
});

/* --------------------------------------------------- structured detail */

describe("the structured block under a child card", () => {
  const statusFor = (run: PeerLoopRunSummary) =>
    describeExecution({
      link: link({ runId: "run-1" }),
      runs: [run],
      unreadable: [],
      nowMs: NOW_MS,
    }).status;

  const ready = (
    decision: PeerLoopRunStateFile["lastReviewerDecision"],
    repo: PeerLoopRunStateFile["repo"] = null,
  ): NavigatorExecutionSnapshot => ({
    status: "ready",
    state: {
      schemaVersion: 1,
      runId: "run-1",
      projectPath: "/repos/demo",
      state: "done",
      iteration: 5,
      createdAt: "2026-03-01T09:00:00.000Z",
      updatedAt: "2026-03-01T10:05:00.000Z",
      ownerPolicyText: "",
      builderSessionId: null,
      reviewerThreadId: null,
      repo,
      lastBuilderTask: "do not read me",
      lastBuilderReport: "do not read me either",
      lastReviewerDecision: decision,
      queuedOwnerMessages: [],
      inFlight: null,
      haltReason: null,
      stopRequested: false,
      adapters,
      safetyLimit: null,
      lastSequence: 20,
    } as PeerLoopRunStateFile,
  });

  it("has nothing to add for an ordinary working run", () => {
    expect(
      describeExecutionDetail({ status: statusFor(summary()), snapshot: NO_EXECUTION_SNAPSHOT }),
    ).toEqual({ kind: "none" });
  });

  it("never describes a driverless or interrupted run as asking a question", () => {
    // The realistic mistake: "needs attention" collapsing into "needs an
    // answer". A run nobody is driving is not a run with a question.
    for (const run of [
      summary({ liveWriter: null }),
      summary({ state: "interrupted" }),
      summary({ state: "error" }),
    ]) {
      const detail = describeExecutionDetail({
        status: statusFor(run),
        snapshot: ready({
          decision: "OWNER_REQUIRED",
          summary: "s",
          ownerQuestion: "q",
          whyOwnerIsRequired: "w",
          options: ["a"],
        }),
      });
      expect(detail).toEqual({ kind: "none" });
    }
  });

  it("says the details are loading, then that they are unavailable", () => {
    const done = statusFor(summary({ state: "done" }));
    expect(
      describeExecutionDetail({ status: done, snapshot: { status: "loading", state: null } }),
    ).toEqual({ kind: "loading" });
    expect(
      describeExecutionDetail({ status: done, snapshot: { status: "failed", state: null } }),
    ).toEqual({ kind: "unavailable" });
  });

  it("foregrounds the structured DONE summary, final state and HEAD", () => {
    const detail = describeExecutionDetail({
      status: statusFor(summary({ state: "done" })),
      snapshot: ready(
        { decision: "DONE", summary: "Backfill shipped.", finalState: "Green on main." },
        {
          head: "abc123def456",
          branch: "main",
          worktreeDigest: null,
          isGitRepo: true,
          capturedAt: "2026-03-01T10:05:00.000Z",
        },
      ),
    });
    expect(detail).toEqual({
      kind: "completion",
      completion: { summary: "Backfill shipped.", finalState: "Green on main." },
      // Peer Loop's own recorded HEAD. Nothing walks git from the browser.
      head: "abc123def456",
      branch: "main",
    });
  });

  it("keeps DONE and says the completion summary is missing", () => {
    expect(
      describeExecutionDetail({
        status: statusFor(summary({ state: "done" })),
        snapshot: ready(null),
      }),
    ).toEqual({ kind: "completion-missing" });
  });

  it("shows the structured owner question, why, and bounded options", () => {
    const detail = describeExecutionDetail({
      status: statusFor(summary({ state: "owner_required" })),
      snapshot: ready({
        decision: "OWNER_REQUIRED",
        summary: "Blocked on a choice.",
        ownerQuestion: "Which database should the backfill target?",
        whyOwnerIsRequired: "Both are in use and only you know which is canonical.",
        options: ["Primary", "Replica"],
      }),
    });
    expect(detail).toEqual({
      kind: "owner-required",
      decision: {
        question: "Which database should the backfill target?",
        why: "Both are in use and only you know which is canonical.",
        options: ["Primary", "Replica"],
      },
    });
  });

  it("says so when Peer Loop is waiting and recorded no question", () => {
    expect(
      describeExecutionDetail({
        status: statusFor(summary({ state: "owner_required" })),
        snapshot: ready({ decision: "CONTINUE", summary: "s", builderTask: "t" }),
      }),
    ).toEqual({ kind: "owner-required-missing" });
  });
});
