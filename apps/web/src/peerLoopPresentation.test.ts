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

import {
  describeControls,
  describeDetail,
  describeError,
  describeEvent,
  describeRunAttention,
  describeTransport,
  describeViewAttention,
  existingRunIdFromRefusal,
  groupRuns,
  parseSafetyLimit,
  projectLabel,
  validateStartRun,
  PEER_LOOP_EVENT_DETAIL_CHARS,
} from "./peerLoopPresentation";

const adapters = {
  reviewer: "codex",
  reviewerVersion: null,
  builder: "claude-code",
  builderVersion: null,
} as const;

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
    liveWriter: null,
    liveInThisBridge: false,
    ...overrides,
  }) as PeerLoopRunSummary;

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

const viewWith = (
  state: PeerLoopRunStateFile,
  control: { available: boolean; resumable: boolean; reason?: string } = {
    available: true,
    resumable: false,
  },
): PeerLoopRunView =>
  applyPeerLoopSubscriptionEvent(emptyPeerLoopRunView("run-1"), {
    kind: "run-attached",
    runId: "run-1",
    snapshot: {
      runId: "run-1",
      state,
      control: {
        available: control.available,
        reason: (control.reason ??
          (control.available ? "live_in_this_bridge" : "held_by_other_process")) as never,
        liveWriter: null,
        resumable: control.resumable,
      },
      eventHighWaterMark: 5,
      replayFromSeq: 0,
      live: true,
    },
  });

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

describe("Peer Loop controls", () => {
  it("offers nothing before a snapshot has arrived", () => {
    const controls = describeControls(emptyPeerLoopRunView("run-1"));
    expect(controls).toMatchObject({
      canSendOwnerMessage: false,
      canPause: false,
      canResume: false,
      canRecover: false,
    });
  });

  it("greys everything out when another process holds the project", () => {
    const controls = describeControls(
      viewWith(runState(), { available: false, resumable: true, reason: "held_by_other_process" }),
    );
    expect(controls.canSendOwnerMessage).toBe(false);
    expect(controls.canPause).toBe(false);
    expect(controls.canResume).toBe(false);
    expect(controls.unavailableReason).toContain("Another Peer Loop process");
  });

  it("offers resume only when Peer Loop says the run is resumable", () => {
    expect(
      describeControls(
        viewWith(runState({ state: "paused" }), { available: true, resumable: true }),
      ).canResume,
    ).toBe(true);
    expect(
      describeControls(
        viewWith(runState({ state: "paused" }), { available: true, resumable: false }),
      ).canResume,
    ).toBe(false);
  });

  it("offers recovery only for an interrupted run", () => {
    expect(describeControls(viewWith(runState({ state: "interrupted" }))).canRecover).toBe(true);
    expect(describeControls(viewWith(runState({ state: "paused" }))).canRecover).toBe(false);
  });

  it("offers nothing that changes a finished run", () => {
    const controls = describeControls(viewWith(runState({ state: "done" })));
    expect(controls.canSendOwnerMessage).toBe(false);
    expect(controls.canPause).toBe(false);
    expect(controls.canRecover).toBe(false);
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
