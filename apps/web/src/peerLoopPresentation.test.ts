import type {
  PeerLoopEvent,
  PeerLoopHaltKind,
  PeerLoopRunStateFile,
  PeerLoopRunSummary,
} from "@t3tools/contracts";
import {
  PeerLoopCommandRefusedError,
  PeerLoopTimeoutError,
  PeerLoopUnavailableError,
} from "@t3tools/contracts";
import {
  applyPeerLoopSubscriptionEvent,
  emptyPeerLoopRunView,
  type PeerLoopRunView,
} from "@t3tools/client-runtime/state/peer-loop-reducer";
import { describe, expect, it } from "vite-plus/test";

import { resolveEffectiveProject } from "./components/peerLoop/PeerLoopStartRun";
import {
  describeCompletion,
  describeControls,
  describeDetail,
  describeError,
  describeEvent,
  describeFailureEvidence,
  describeFinalState,
  describeOwnerDecision,
  describeRunAttention,
  describeTransport,
  describeViewAttention,
  existingRunIdFromRefusal,
  groupRuns,
  parseSafetyLimit,
  pauseTakesEffectLater,
  projectLabel,
  validateStartRun,
  PEER_LOOP_COMPLETION_SUMMARY_CHARS,
  PEER_LOOP_EVENT_DETAIL_CHARS,
  PEER_LOOP_EVIDENCE_CHARS,
  PEER_LOOP_FINAL_STATE_CHARS,
  PEER_LOOP_OWNER_OPTION_LIMIT,
  PEER_LOOP_OWNER_TEXT_CHARS,
} from "./peerLoopPresentation";

const adapters = {
  reviewer: "codex",
  reviewerVersion: null,
  builder: "claude-code",
  builderVersion: null,
} as const;

/**
 * The lease Peer Loop reports for a run something is actually driving.
 *
 * A working *state* and a working *run* are not the same fact, and the fixtures
 * below keep them apart deliberately: a run state file says the Builder was
 * working when it was last written, and only this says anybody still is.
 */
const liveWriter = (isThisProcess = true): PeerLoopRunSummary["liveWriter"] =>
  ({
    pid: 4242,
    host: "this-mac",
    command: "start",
    runId: "run-1",
    acquiredAt: "2026-08-09T00:00:00.000Z",
    renewedAt: "2026-08-09T00:05:00.000Z",
    isThisProcess,
  }) as NonNullable<PeerLoopRunSummary["liveWriter"]>;

/** A genuinely live working run: Peer Loop's state says working, and so does its lease. */
const summary = (overrides: Partial<PeerLoopRunSummary> = {}): PeerLoopRunSummary =>
  ({
    runId: "run-1",
    projectPath: "/repos/demo",
    state: "builder_working",
    iteration: 2,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:05:00.000Z",
    haltReason: null,
    inFlight: null,
    queuedOwnerMessages: 0,
    lastSequence: 5,
    awaitingOwnerObjective: false,
    adapters,
    liveWriter: liveWriter(),
    liveInThisBridge: true,
    ...overrides,
  }) as PeerLoopRunSummary;

/** The same run after whatever was driving it went away. Nothing else differs. */
const driverless = (overrides: Partial<PeerLoopRunSummary> = {}): PeerLoopRunSummary =>
  summary({ liveWriter: null, liveInThisBridge: false, ...overrides });

const runState = (overrides: Partial<PeerLoopRunStateFile> = {}): PeerLoopRunStateFile =>
  ({
    schemaVersion: 1,
    runId: "run-1",
    projectPath: "/repos/demo",
    state: "builder_working",
    iteration: 3,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:05:00.000Z",
    ownerPolicyText: "OWNER POLICY",
    builderSessionId: null,
    reviewerThreadId: null,
    repo: null,
    lastBuilderTask: "Write NOTES.md. Then STOP.",
    lastBuilderReport: null,
    lastReviewerDecision: null,
    queuedOwnerMessages: [],
    inFlight: null,
    haltReason: null,
    stopRequested: false,
    adapters,
    safetyLimit: null,
    lastSequence: 5,
    ...overrides,
  }) as PeerLoopRunStateFile;

const event = (kind: string, payload: Record<string, unknown> = {}): PeerLoopEvent =>
  ({
    runId: "run-1",
    seq: 1,
    ts: "2026-08-09T00:00:00.000Z",
    type: kind,
    actor: "system",
    iteration: 1,
    payload: { kind, ...payload },
  }) as PeerLoopEvent;

/**
 * The lease that comes with each control snapshot.
 *
 * Peer Loop reports one whenever a process holds the project — this bridge or
 * another — and reports none once nothing does. Deriving it from the reason
 * here keeps every fixture a snapshot the bridge could actually send.
 */
const writerFor = (reason: string): PeerLoopRunSummary["liveWriter"] => {
  if (reason === "live_in_this_bridge") return liveWriter(true);
  if (reason === "held_by_other_process") return liveWriter(false);
  return null;
};

const viewWith = (
  state: PeerLoopRunStateFile,
  control: {
    readonly available: boolean;
    readonly resumable: boolean;
    readonly reason?: string;
  } = { available: true, resumable: false },
): PeerLoopRunView => {
  const reason =
    control.reason ?? (control.available ? "live_in_this_bridge" : "held_by_other_process");
  return applyPeerLoopSubscriptionEvent(emptyPeerLoopRunView("run-1"), {
    kind: "run-attached",
    runId: "run-1",
    snapshot: {
      runId: "run-1",
      state,
      control: {
        available: control.available,
        reason: reason as never,
        liveWriter: writerFor(reason),
        resumable: control.resumable,
      },
      eventHighWaterMark: 5,
      replayFromSeq: 0,
      live: true,
    },
  });
};

describe("Peer Loop transport presentation", () => {
  it("says a machine has no Peer Loop rather than calling it a failure", () => {
    const presented = describeTransport(
      { state: "unavailable", changedAt: "", detail: null, protocolVersion: null },
      false,
    );
    expect(presented.label).toContain("not set up");
    expect(presented.tone).toBe("neutral");
  });

  it("keeps every transport state distinguishable", () => {
    const states = ["unavailable", "starting", "connected", "interrupted", "stopped"] as const;
    const labels = states.map(
      (state) =>
        describeTransport({ state, changedAt: "", detail: null, protocolVersion: null }, true)
          .label,
    );
    expect(new Set(labels).size).toBe(states.length);
  });

  it("passes the server's own detail through untouched", () => {
    const presented = describeTransport(
      {
        state: "unavailable",
        changedAt: "",
        detail: "a Peer Loop executable path must be absolute",
        protocolVersion: null,
      },
      true,
    );
    expect(presented.detail).toBe("a Peer Loop executable path must be absolute");
  });
});

describe("Peer Loop attention", () => {
  it("gives every halt kind its own words", () => {
    const kinds: readonly PeerLoopHaltKind[] = [
      "OWNER_REQUIRED",
      "OWNER_OBJECTIVE_REQUIRED",
      "CAPACITY_EXHAUSTED",
      "AUTH_REQUIRED",
      "TRANSPORT_INTERRUPTED",
      "AMBIGUOUS_INTERRUPTED_TURN",
      "OWNER_PAUSED",
      "SAFETY_LIMIT",
      "SYSTEM_BLOCKED",
      "CAPABILITY_MISMATCH",
    ];
    const keys = kinds.map(
      (kind) =>
        describeRunAttention(
          summary({ state: "paused", haltReason: { kind, message: `halted: ${kind}` } }),
        ).key,
    );
    // Distinct where the fix is distinct. Only the "this build cannot run it"
    // kinds share a key, and there is one of those in this list.
    expect(new Set(keys).size).toBe(kinds.length);
    expect(keys[0]).toBe("owner-decision");
    expect(keys[2]).toBe("capacity-exhausted");
    expect(keys[3]).toBe("auth-required");
    expect(keys[4]).toBe("transport-interrupted");
    expect(keys[6]).toBe("paused");
    expect(keys[7]).toBe("safety-limit");
  });

  it("carries Peer Loop's own message rather than inventing one", () => {
    const presented = describeRunAttention(
      summary({
        state: "paused",
        haltReason: { kind: "AUTH_REQUIRED", message: "claude: run `claude login`" },
      }),
    );
    expect(presented.detail).toBe("claude: run `claude login`");
  });

  it("treats an interrupted run as needing an explicit choice", () => {
    const presented = describeRunAttention(summary({ state: "interrupted" }));
    expect(presented.key).toBe("recovery-required");
    expect(presented.actionable).toBe(true);
    expect(presented.tone).toBe("danger");
  });

  it("calls a working state with no live writer interrupted, not working", () => {
    // The state file was written mid-turn and never updated again, because
    // whatever was writing it went away. Peer Loop reports that as no live
    // writer, and a "Working" badge on it would be a lie that hides a run
    // nothing will ever move.
    for (const state of ["builder_working", "reviewer_working"] as const) {
      const presented = describeRunAttention(driverless({ state }));
      expect(presented.key).toBe("driver-missing");
      expect(presented.actionable).toBe(true);
      expect(presented.label).toContain("Interrupted");
      expect(presented.label).toContain("no Reviewer or Builder running");
    }
  });

  it("leaves a working run with a live writer working", () => {
    for (const state of ["builder_working", "reviewer_working"] as const) {
      const presented = describeRunAttention(summary({ state }));
      expect(presented.key).toBe("running");
      expect(presented.actionable).toBe(false);
    }
  });

  it("does not call a run another process is driving interrupted", () => {
    // Not ours to command is not the same as not running. Peer Loop allows one
    // live writer per repository, and someone else holding it means the run is
    // moving — just not from here.
    const presented = describeRunAttention(
      summary({ state: "builder_working", liveWriter: liveWriter(false), liveInThisBridge: false }),
    );
    expect(presented.key).toBe("running");
    expect(presented.actionable).toBe(false);
  });

  it("reads the driver off the control snapshot on an attached run, not off the clock", () => {
    const stale = describeViewAttention(viewWith(runState({ state: "builder_working" }), STOPPED));
    expect(stale.key).toBe("driver-missing");
    expect(stale.actionable).toBe(true);

    // Live here, and live elsewhere, are both live.
    expect(describeViewAttention(viewWith(runState({ state: "builder_working" }), LIVE)).key).toBe(
      "running",
    );
    expect(describeViewAttention(viewWith(runState({ state: "builder_working" }), HELD)).key).toBe(
      "running",
    );
  });

  it("does not guess at a driver it has no snapshot of", () => {
    // No control snapshot yet. Silence is not evidence that nothing is running,
    // so the run keeps reading as working until Peer Loop says otherwise.
    const noControl: PeerLoopRunView = {
      ...emptyPeerLoopRunView("run-1"),
      state: runState({ state: "builder_working" }),
    };
    expect(noControl.control).toBe(null);
    expect(describeViewAttention(noControl).key).toBe("running");
  });

  it("does not ask for attention while an agent is working or the run is paused", () => {
    expect(describeRunAttention(summary({ state: "builder_working" })).actionable).toBe(false);
    expect(
      describeRunAttention(
        summary({ state: "paused", haltReason: { kind: "OWNER_PAUSED", message: "paused" } }),
      ).actionable,
    ).toBe(false);
  });

  it("shows DONE over whatever the run last halted on", () => {
    const presented = describeRunAttention(
      summary({ state: "done", haltReason: { kind: "OWNER_PAUSED", message: "was paused" } }),
    );
    expect(presented.key).toBe("done");
    expect(presented.tone).toBe("success");
  });

  it("reads DONE off Peer Loop's outcome on the detail view", () => {
    const view = applyPeerLoopSubscriptionEvent(viewWith(runState()), {
      kind: "run-finished",
      runId: "run-1",
      outcome: { kind: "done", finalState: "clean", summary: "All done." },
      state: null,
      reason: "terminal",
    });
    const presented = describeViewAttention(view);
    expect(presented.key).toBe("done");
    expect(presented.detail).toBe("All done.");
  });

  it("says nothing at all about a run it has no snapshot for", () => {
    expect(describeViewAttention(emptyPeerLoopRunView("run-1")).key).toBe("none");
  });
});

describe("Peer Loop run grouping", () => {
  it("puts what needs a person first, then what is moving, then history", () => {
    const groups = groupRuns([
      summary({ runId: "working", state: "builder_working" }),
      summary({ runId: "done", state: "done" }),
      summary({ runId: "asking", state: "owner_required" }),
      summary({ runId: "failed", state: "error" }),
      summary({ runId: "interrupted", state: "interrupted" }),
    ]);

    expect(groups.attention.map((run) => run.runId).sort()).toEqual(["asking", "interrupted"]);
    expect(groups.active.map((run) => run.runId)).toEqual(["working"]);
    expect(groups.recent.map((run) => run.runId).sort()).toEqual(["done", "failed"]);
  });

  it("orders each group by recency", () => {
    const groups = groupRuns([
      summary({ runId: "older", updatedAt: "2026-08-09T00:01:00.000Z" }),
      summary({ runId: "newer", updatedAt: "2026-08-09T00:09:00.000Z" }),
    ]);
    expect(groups.active.map((run) => run.runId)).toEqual(["newer", "older"]);
  });

  it("puts a working run with no live writer under what needs you", () => {
    const groups = groupRuns([
      summary({ runId: "live", state: "builder_working" }),
      driverless({ runId: "stale-builder", state: "builder_working" }),
      driverless({ runId: "stale-reviewer", state: "reviewer_working" }),
    ]);
    expect(groups.attention.map((run) => run.runId).sort()).toEqual([
      "stale-builder",
      "stale-reviewer",
    ]);
    expect(groups.active.map((run) => run.runId)).toEqual(["live"]);
  });

  it("counts a paused run as active, not as attention", () => {
    const groups = groupRuns([
      summary({
        runId: "paused",
        state: "paused",
        haltReason: { kind: "OWNER_PAUSED", message: "paused" },
      }),
    ]);
    expect(groups.attention).toEqual([]);
    expect(groups.active.map((run) => run.runId)).toEqual(["paused"]);
  });

  it("names a project by its directory, not its whole path", () => {
    expect(projectLabel("/Users/x/code/demo")).toBe("demo");
    expect(projectLabel("/Users/x/code/demo/")).toBe("demo");
    expect(projectLabel("C:\\code\\demo")).toBe("demo");
    expect(projectLabel("")).toBe("");
  });
});

describe("Peer Loop event rendering", () => {
  it("renders a recognised event concisely", () => {
    expect(describeEvent(event("run_started")).title).toBe("Run started");
    expect(
      describeEvent(event("reviewer_decision", { decision: "CONTINUE", summary: "Looks fine." })),
    ).toMatchObject({ title: "Reviewer decided: CONTINUE", detail: "Looks fine." });
    expect(describeEvent(event("builder_task", { task: "Write NOTES.md." })).detail).toBe(
      "Write NOTES.md.",
    );
  });

  it("marks a failure differently from a note", () => {
    expect(describeEvent(event("builder_failure", { message: "timed out" })).tone).toBe("warning");
    expect(describeEvent(event("notice", { message: "hi" })).tone).toBe("neutral");
  });

  it("keeps an unfamiliar event legible instead of dumping it", () => {
    const presented = describeEvent(
      event("some_future_kind", {
        note: "a short string",
        count: 3,
        enabled: true,
        missing: null,
        items: [1, 2, 3],
        nested: { deep: { deeper: "x" } },
      }),
    );
    expect(presented.title).toBe("Peer Loop: some_future_kind");
    expect(presented.detail).toContain("note: a short string");
    expect(presented.detail).toContain("count: 3");
    expect(presented.detail).toContain("items: 3 item(s)");
    // The nested object is acknowledged, never serialised.
    expect(presented.detail).toContain("nested: …");
    expect(presented.detail).not.toContain("deeper");
  });

  it("truncates a very long value rather than wrapping a phone in it", () => {
    const presented = describeEvent(event("notice", { message: "x".repeat(5_000) }));
    expect(presented.detail?.length).toBeLessThanOrEqual(PEER_LOOP_EVENT_DETAIL_CHARS);
    expect(presented.detail?.endsWith("…")).toBe(true);
  });

  it("shows an unfamiliar event with no payload fields as just its kind", () => {
    const presented = describeEvent(event("bare_future_kind"));
    expect(presented.title).toBe("Peer Loop: bare_future_kind");
    expect(presented.detail).toBe(null);
  });
});

/** The three control snapshots Peer Loop actually produces, named. */
const LIVE = { available: true, reason: "live_in_this_bridge", resumable: false } as const;
const LIVE_RESUMABLE = { available: true, reason: "live_in_this_bridge", resumable: true } as const;
const HELD = { available: false, reason: "held_by_other_process", resumable: false } as const;
const STOPPED = { available: false, reason: "not_attached", resumable: true } as const;
const STOPPED_FINAL = { available: false, reason: "not_attached", resumable: false } as const;

describe("Peer Loop controls", () => {
  it("offers nothing before a snapshot has arrived", () => {
    expect(describeControls(emptyPeerLoopRunView("run-1"))).toMatchObject({
      canSendOwnerMessage: false,
      canPause: false,
      canResume: false,
      canRecover: false,
      resumeBeforeRecover: false,
    });
  });

  it("offers the live controls when this bridge is the writer", () => {
    expect(describeControls(viewWith(runState(), LIVE))).toMatchObject({
      canSendOwnerMessage: true,
      canPause: true,
      canResume: false,
      canRecover: false,
      unavailableReason: null,
    });
  });

  it("keeps a run held by another process entirely read-only", () => {
    const controls = describeControls(viewWith(runState(), HELD));
    expect(controls).toMatchObject({
      canSendOwnerMessage: false,
      canPause: false,
      canResume: false,
      canRecover: false,
    });
    expect(controls.unavailableReason).toContain("Another Peer Loop process");
  });

  it("offers Resume on a stopped resumable run even though control is unavailable", () => {
    // `available: false` with `not_attached` is the ordinary snapshot of a run
    // nobody is driving. Reading it as "nothing is possible" would leave every
    // stopped run permanently unstartable.
    const controls = describeControls(viewWith(runState({ state: "paused" }), STOPPED));
    expect(controls.canResume).toBe(true);
    expect(controls.canSendOwnerMessage).toBe(false);
    expect(controls.canPause).toBe(false);
    expect(controls.canRecover).toBe(false);
    expect(controls.unavailableReason).toContain("not driving this run");
  });

  it("tells an interrupted stopped run to resume before it can recover", () => {
    const controls = describeControls(viewWith(runState({ state: "interrupted" }), STOPPED));
    expect(controls.canResume).toBe(true);
    expect(controls.canRecover).toBe(false);
    expect(controls.resumeBeforeRecover).toBe(true);
  });

  it("offers recovery once the interrupted run is live", () => {
    const controls = describeControls(viewWith(runState({ state: "interrupted" }), LIVE));
    expect(controls.canRecover).toBe(true);
    expect(controls.resumeBeforeRecover).toBe(false);
    // Nothing else, because the queue is not read until the turn is resolved.
    expect(controls.canSendOwnerMessage).toBe(false);
    expect(controls.canPause).toBe(false);
  });

  it("offers resume on a live run only when Peer Loop says it is resumable", () => {
    expect(
      describeControls(viewWith(runState({ state: "paused" }), LIVE_RESUMABLE)).canResume,
    ).toBe(true);
    expect(describeControls(viewWith(runState({ state: "paused" }), LIVE)).canResume).toBe(false);
  });

  it("offers nothing that changes a finished run, whoever holds it", () => {
    for (const control of [LIVE, LIVE_RESUMABLE, STOPPED, STOPPED_FINAL, HELD]) {
      const controls = describeControls(viewWith(runState({ state: "done" }), control));
      expect(controls.canSendOwnerMessage).toBe(false);
      expect(controls.canPause).toBe(false);
      expect(controls.canResume).toBe(false);
      expect(controls.canRecover).toBe(false);
      expect(controls.resumeBeforeRecover).toBe(false);
    }
  });

  it("says a pause on a working run lands at a boundary", () => {
    expect(pauseTakesEffectLater(viewWith(runState({ state: "builder_working" }), LIVE))).toBe(
      true,
    );
    expect(pauseTakesEffectLater(viewWith(runState({ state: "idle" }), LIVE))).toBe(false);
  });
});

describe("Peer Loop owner-facing structure", () => {
  const decision = {
    decision: "OWNER_REQUIRED",
    summary: "Needs a product call.",
    ownerQuestion: "Should the export include archived threads?",
    whyOwnerIsRequired: "It changes what leaves the machine.",
    options: ["Include them", "Exclude them"],
  } as const;

  it("reads the escalated question off the durable decision", () => {
    const owner = describeOwnerDecision(
      viewWith(
        runState({ state: "owner_required", lastReviewerDecision: decision } as Partial<
          typeof runState extends (...args: never) => infer R ? R : never
        >),
        LIVE,
      ),
    );
    expect(owner?.question).toBe("Should the export include archived threads?");
    expect(owner?.why).toBe("It changes what leaves the machine.");
    expect(owner?.options).toEqual(["Include them", "Exclude them"]);
  });

  it("has nothing to show when the Reviewer did not escalate", () => {
    expect(describeOwnerDecision(viewWith(runState(), LIVE))).toBe(null);
    expect(describeOwnerDecision(emptyPeerLoopRunView("run-1"))).toBe(null);
  });

  it("bounds a very long question and a long option list", () => {
    const owner = describeOwnerDecision(
      viewWith(
        runState({
          state: "owner_required",
          lastReviewerDecision: {
            decision: "OWNER_REQUIRED",
            summary: "s",
            ownerQuestion: "q".repeat(5_000),
            whyOwnerIsRequired: "w".repeat(5_000),
            options: Array.from({ length: 30 }, (_, index) => `option ${index}`),
          },
        } as never),
        LIVE,
      ),
    );
    expect(owner?.question.length).toBeLessThanOrEqual(PEER_LOOP_OWNER_TEXT_CHARS);
    expect(owner?.why.length).toBeLessThanOrEqual(PEER_LOOP_OWNER_TEXT_CHARS);
    expect(owner?.options.length).toBe(PEER_LOOP_OWNER_OPTION_LIMIT);
  });

  it("keeps the Builder failure Peer Loop recorded, with its reset time or without", () => {
    const withReset = describeFailureEvidence(
      viewWith(
        runState({
          lastBuilderFailure: {
            kind: "CAPACITY_EXHAUSTED",
            source: "result",
            evidence: "usage limit reached",
            resetAt: "2026-08-09T04:00:00.000Z",
          },
        } as never),
        LIVE,
      ),
    );
    expect(withReset).toMatchObject({
      kind: "CAPACITY_EXHAUSTED",
      evidence: "usage limit reached",
      source: "result",
      resetAt: "2026-08-09T04:00:00.000Z",
    });

    const withoutReset = describeFailureEvidence(
      viewWith(
        runState({
          lastBuilderFailure: {
            kind: "AUTH_REQUIRED",
            source: "stderr",
            evidence: "run `claude login`",
            resetAt: null,
          },
        } as never),
        LIVE,
      ),
    );
    // Never invented: the absence is the answer.
    expect(withoutReset?.resetAt).toBe(null);
    expect(withoutReset?.kind).toBe("AUTH_REQUIRED");
  });

  it("bounds the evidence excerpt", () => {
    const failure = describeFailureEvidence(
      viewWith(
        runState({
          lastBuilderFailure: {
            kind: "TRANSPORT_INTERRUPTED",
            source: "transport",
            evidence: "z".repeat(9_000),
            resetAt: null,
          },
        } as never),
        LIVE,
      ),
    );
    expect(failure?.evidence.length).toBeLessThanOrEqual(PEER_LOOP_EVIDENCE_CHARS);
  });

  it("has nothing to show when no Builder failure was recorded", () => {
    expect(describeFailureEvidence(viewWith(runState(), LIVE))).toBe(null);
  });

  it("shows the final state from the outcome, then from the decision", () => {
    const fromOutcome = applyPeerLoopSubscriptionEvent(
      viewWith(runState({ state: "done" }), LIVE),
      {
        kind: "run-finished",
        runId: "run-1",
        outcome: { kind: "done", finalState: "clean worktree", summary: "Done." },
        state: null,
        reason: "terminal",
      },
    );
    expect(describeFinalState(fromOutcome)).toBe("clean worktree");

    expect(
      describeFinalState(
        viewWith(
          runState({
            state: "done",
            lastReviewerDecision: {
              decision: "DONE",
              summary: "Objective met.",
              finalState: "documented and merged",
            },
          } as never),
          STOPPED_FINAL,
        ),
      ),
    ).toBe("documented and merged");

    // Never derived from the state alone.
    expect(describeFinalState(viewWith(runState({ state: "done" }), LIVE))).toBe(null);
  });

  it("summarises a finished run from the outcome, preferring it over the decision", () => {
    const bothPresent = applyPeerLoopSubscriptionEvent(
      viewWith(
        runState({
          state: "done",
          lastReviewerDecision: {
            decision: "DONE",
            summary: "The durable one.",
            finalState: "durable final state",
          },
        } as never),
        LIVE,
      ),
      {
        kind: "run-finished",
        runId: "run-1",
        outcome: { kind: "done", finalState: "live final state", summary: "The live one." },
        state: null,
        reason: "terminal",
      },
    );
    expect(describeCompletion(bothPresent)).toEqual({
      summary: "The live one.",
      finalState: "live final state",
    });

    // Without an outcome, the durable DONE decision is the record.
    expect(
      describeCompletion(
        viewWith(
          runState({
            state: "done",
            lastReviewerDecision: {
              decision: "DONE",
              summary: "Objective met.",
              finalState: "documented and merged",
            },
          } as never),
          STOPPED_FINAL,
        ),
      ),
    ).toEqual({ summary: "Objective met.", finalState: "documented and merged" });
  });

  it("has no completion to show for a run that has not finished, or only says it did", () => {
    expect(describeCompletion(viewWith(runState({ state: "builder_working" }), LIVE))).toBe(null);
    // "done" is that it finished, not how. Nothing is invented to fill the gap.
    expect(describeCompletion(viewWith(runState({ state: "done" }), LIVE))).toBe(null);
    // A CONTINUE decision is not a completion, whatever it says.
    expect(
      describeCompletion(
        viewWith(
          runState({
            lastReviewerDecision: {
              decision: "CONTINUE",
              summary: "Keep going.",
              builderTask: "Write NOTES.md.",
            },
          } as never),
          LIVE,
        ),
      ),
    ).toBe(null);
  });

  it("bounds a long completion summary", () => {
    const view = applyPeerLoopSubscriptionEvent(viewWith(runState({ state: "done" }), LIVE), {
      kind: "run-finished",
      runId: "run-1",
      outcome: { kind: "done", finalState: "f".repeat(2_000), summary: "s".repeat(9_000) },
      state: null,
      reason: "terminal",
    });
    const completion = describeCompletion(view);
    expect(completion?.summary?.length).toBeLessThanOrEqual(PEER_LOOP_COMPLETION_SUMMARY_CHARS);
    expect(completion?.finalState?.length).toBeLessThanOrEqual(PEER_LOOP_FINAL_STATE_CHARS);
  });
});

describe("Peer Loop error presentation", () => {
  it("keeps each structured refusal code distinguishable", () => {
    const codes = [
      "CONTROL_UNAVAILABLE",
      "PROJECT_HAS_UNFINISHED_RUN",
      "REVIEWER_THREAD_BUSY",
      "INVALID_RUN_STATE",
    ] as const;
    const titles = codes.map(
      (code) =>
        describeError(new PeerLoopCommandRefusedError({ code, detail: "because", data: null }))
          .title,
    );
    expect(new Set(titles).size).toBe(codes.length);
    for (const code of codes) {
      expect(
        describeError(new PeerLoopCommandRefusedError({ code, detail: "because", data: null }))
          .code,
      ).toBe(code);
    }
  });

  it("shows an unfamiliar refusal code as itself rather than as a shrug", () => {
    const presented = describeError(
      new PeerLoopCommandRefusedError({
        code: "SOMETHING_NEWER",
        detail: "a future build refused this",
        data: null,
      }),
    );
    expect(presented.code).toBe("SOMETHING_NEWER");
    expect(presented.detail).toBe("a future build refused this");
  });

  it("says a timed-out mutation may already have applied", () => {
    const presented = describeError(
      new PeerLoopTimeoutError({ method: "run.recover", timeoutMs: 30_000, mayHaveApplied: true }),
    );
    expect(presented.mayHaveApplied).toBe(true);
    expect(presented.detail).toContain("may still have accepted");
    expect(presented.detail).toContain("Nothing was retried");
  });

  it("does not claim a read may have applied", () => {
    const presented = describeError(
      new PeerLoopTimeoutError({ method: "runs.list", timeoutMs: 30_000, mayHaveApplied: false }),
    );
    expect(presented.mayHaveApplied).toBe(false);
    expect(presented.detail).not.toContain("may still have accepted");
  });

  it("bounds a refusal detail rather than rendering whatever arrived", () => {
    const presented = describeError(
      new PeerLoopCommandRefusedError({
        code: "INVALID_PARAMS",
        detail: "y".repeat(5_000),
        data: null,
      }),
    );
    expect(presented.detail?.length).toBeLessThanOrEqual(PEER_LOOP_EVENT_DETAIL_CHARS);
  });

  it("keeps an unavailable answer neutral, because it is an answer", () => {
    const presented = describeError(new PeerLoopUnavailableError({ reason: "not installed here" }));
    expect(presented.tone).toBe("neutral");
  });

  it("finds the existing run a duplicate refusal points at", () => {
    expect(
      existingRunIdFromRefusal(
        new PeerLoopCommandRefusedError({
          code: "PROJECT_HAS_UNFINISHED_RUN",
          detail: "already running",
          data: { runId: "run-9", overrideParam: "newRun" },
        }),
      ),
    ).toBe("run-9");
    expect(
      existingRunIdFromRefusal(
        new PeerLoopCommandRefusedError({
          code: "CONTROL_UNAVAILABLE",
          detail: "held",
          data: { runId: "run-9" },
        }),
      ),
    ).toBe(null);
  });
});

describe("Peer Loop start validation", () => {
  it("requires a project and an objective", () => {
    expect(validateStartRun({ projectId: null, objective: "", safetyLimit: "" })).toMatchObject({
      ok: false,
      projectError: "Choose a project.",
      objectiveError: "Say what this run should achieve.",
    });
  });

  it("treats a whitespace objective as empty", () => {
    expect(
      validateStartRun({ projectId: "p", objective: "   ", safetyLimit: "" }).objectiveError,
    ).not.toBe(null);
  });

  it("accepts an omitted safety limit and refuses a nonsensical one", () => {
    expect(validateStartRun({ projectId: "p", objective: "go", safetyLimit: "" }).ok).toBe(true);
    expect(validateStartRun({ projectId: "p", objective: "go", safetyLimit: "12" }).ok).toBe(true);
    for (const bad of ["0", "-1", "1.5", "abc", "12x"]) {
      expect(
        validateStartRun({ projectId: "p", objective: "go", safetyLimit: bad }).safetyLimitError,
      ).not.toBe(null);
    }
  });

  it("only sends a safety limit it would accept", () => {
    expect(parseSafetyLimit("")).toBe(undefined);
    expect(parseSafetyLimit("0")).toBe(undefined);
    expect(parseSafetyLimit("1.5")).toBe(undefined);
    expect(parseSafetyLimit("7")).toBe(7);
  });
});

describe("Peer Loop detail summary", () => {
  it("reads the snapshot Peer Loop sent and nothing else", () => {
    const view = viewWith(
      runState({
        state: "builder_working",
        iteration: 4,
        inFlight: {
          actor: "builder",
          startedAt: "2026-08-09T00:04:00.000Z",
          iteration: 4,
          taskDigest: null,
          pid: null,
        },
        lastReviewerDecision: {
          decision: "CONTINUE",
          summary: "Baseline established.",
          builderTask: "Write NOTES.md.",
        },
        queuedOwnerMessages: [
          { id: "m1", text: "keep it local", queuedAt: "2026-08-09T00:03:00.000Z" },
        ],
      } as Partial<PeerLoopRunStateFile>),
    );

    expect(describeDetail(view)).toMatchObject({
      state: "builder_working",
      iteration: 4,
      reviewer: "codex",
      builder: "claude-code",
      inFlightActor: "builder",
      currentTask: "Write NOTES.md. Then STOP.",
      queuedOwnerMessages: 1,
      projectPath: "/repos/demo",
    });
    expect(describeDetail(view).lastDecision).toContain("CONTINUE");
  });

  it("has nothing to say before a snapshot arrives", () => {
    expect(describeDetail(emptyPeerLoopRunView("run-1"))).toMatchObject({
      state: null,
      iteration: null,
      queuedOwnerMessages: 0,
    });
  });
});

describe("Peer Loop start-run project selection", () => {
  const projects = [
    { id: "p1", title: "one", workspaceRoot: "/a" },
    { id: "p2", title: "two", workspaceRoot: "/b" },
  ];

  it("has nothing to select before the project list arrives", () => {
    expect(resolveEffectiveProject([], null)).toBe(null);
    expect(validateStartRun({ projectId: null, objective: "go", safetyLimit: "" }).ok).toBe(false);
  });

  it("adopts the first project the moment the list arrives, with no change event", () => {
    // The form renders once while the atom is still empty and again when it
    // resolves. Seeding state on the first render left the select showing a
    // project the validation did not have, so the button stayed disabled until
    // the owner reselected the option already on screen.
    const chosen = null;
    expect(resolveEffectiveProject([], chosen)).toBe(null);
    const effective = resolveEffectiveProject(projects, chosen);
    expect(effective).toBe("p1");
    expect(
      validateStartRun({ projectId: effective, objective: "go", safetyLimit: "" }),
    ).toMatchObject({ ok: true, projectError: null });
  });

  it("keeps an explicit selection across ordinary list refreshes", () => {
    expect(resolveEffectiveProject(projects, "p2")).toBe("p2");
    // A refresh that returns the same projects in a new array must not snap
    // the owner back to the first one.
    const refreshed = projects.map((project) => ({ ...project }));
    expect(resolveEffectiveProject(refreshed, "p2")).toBe("p2");
  });

  it("falls back to the first project when the chosen one disappears", () => {
    expect(resolveEffectiveProject(projects, "gone")).toBe("p1");
    expect(resolveEffectiveProject([], "p2")).toBe(null);
  });

  it("never displays one project while submitting another", () => {
    // One derived value drives the select, the validation and the submission,
    // so there is no second source that could disagree.
    for (const chosen of [null, "p1", "p2", "gone"]) {
      const effective = resolveEffectiveProject(projects, chosen);
      expect(projects.some((project) => project.id === effective)).toBe(true);
    }
  });
});
