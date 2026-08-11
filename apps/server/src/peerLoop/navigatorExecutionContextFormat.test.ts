/**
 * What a Navigator turn is allowed to be told about its own runs.
 *
 * The two failures this guards are opposite in shape. One is a context that
 * says too much — a machine path, an adapter identity, an unbounded Builder
 * report — reaching a provider on every turn. The other is a context that
 * invents: a lifecycle state for a run Peer Loop is not listing, or a
 * "what happened" assembled out of prose nobody structured.
 */
import type {
  OrchestrationPeerLoopExecution,
  OrchestrationProposedPlanId,
  PeerLoopRunStateFile,
  PeerLoopRunSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  detailFromSnapshot,
  factsFromSummary,
  NAVIGATOR_CONTEXT_FINAL_STATE_CHARS,
  NAVIGATOR_CONTEXT_HEADING,
  NAVIGATOR_CONTEXT_MAX_ATTACHMENTS,
  NAVIGATOR_CONTEXT_MAX_CHARS,
  NAVIGATOR_CONTEXT_MAX_LINKS,
  NAVIGATOR_CONTEXT_OPTION_LIMIT,
  NAVIGATOR_CONTEXT_QUESTION_CHARS,
  NAVIGATOR_CONTEXT_SUMMARY_CHARS,
  NAVIGATOR_CONTEXT_TRUNCATION_MARKER,
  renderNavigatorExecutionContext,
  selectAttachTargets,
  selectRecentExecutionLinks,
  shouldAttachForFacts,
  type NavigatorExecutionEntry,
} from "./navigatorExecutionContextFormat.ts";

const link = (input: {
  readonly runId: string;
  readonly createdAt: string;
  readonly proposedPlanId?: string;
}): OrchestrationPeerLoopExecution => ({
  runId: input.runId,
  proposedPlanId: (input.proposedPlanId ?? "plan-1") as OrchestrationProposedPlanId,
  createdAt: input.createdAt,
});

const summary = (overrides: Partial<PeerLoopRunSummary> = {}): PeerLoopRunSummary => ({
  runId: "run-77",
  projectPath: "/Users/owner/repos/demo",
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
    reviewerVersion: "1.2.3",
    builder: "claude-code",
    builderVersion: "9.9.9",
  },
  liveWriter: {
    pid: 4242,
    host: "workstation.local",
    command: "start",
    runId: "run-77",
    acquiredAt: "2026-03-01T09:00:00.000Z",
    renewedAt: "2026-03-01T10:05:00.000Z",
    isThisProcess: true,
  },
  liveInThisBridge: true,
  ...overrides,
});

const stateFile = (overrides: Partial<PeerLoopRunStateFile> = {}): PeerLoopRunStateFile =>
  ({
    schemaVersion: 1,
    runId: "run-77",
    projectPath: "/Users/owner/repos/demo",
    state: "done",
    iteration: 5,
    createdAt: "2026-03-01T09:00:00.000Z",
    updatedAt: "2026-03-01T10:05:00.000Z",
    ownerPolicyText: "owner policy prose that must never be forwarded",
    builderSessionId: null,
    reviewerThreadId: null,
    repo: null,
    lastBuilderTask: "BUILDER TASK PROSE",
    lastBuilderReport: "BUILDER REPORT PROSE",
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

const entry = (overrides: Partial<NavigatorExecutionEntry> = {}): NavigatorExecutionEntry => ({
  runId: "run-77",
  proposedPlanId: "plan-1",
  linkedAt: "2026-03-01T10:00:00.000Z",
  facts: factsFromSummary(summary()),
  unreadable: false,
  detail: { kind: "none" },
  ...overrides,
});

/* ---------------------------------------------------------------- facts */

describe("the facts a run contributes", () => {
  it("is exactly the enumerated set, and nothing else from the summary", () => {
    // The narrowing IS the sanitization. A field excluded by remembering not
    // to print it is a field somebody prints in six months.
    const facts = factsFromSummary(summary());
    expect(Object.keys(facts).toSorted()).toEqual([
      "haltKind",
      "hasLiveWriter",
      "iteration",
      "liveWriterIsThisBridge",
      "queuedOwnerMessages",
      "state",
      "updatedAt",
    ]);
    const serialized = JSON.stringify(facts);
    for (const leaked of [
      "/Users/owner",
      "workstation.local",
      "4242",
      "codex",
      "claude-code",
      "1.2.3",
    ]) {
      expect(serialized, leaked).not.toContain(leaked);
    }
  });

  it("reports a halt kind without Peer Loop's free-text message", () => {
    const facts = factsFromSummary(
      summary({
        state: "owner_required",
        haltReason: { kind: "OWNER_REQUIRED", message: "which database, exactly?" },
      }),
    );
    expect(facts.haltKind).toBe("OWNER_REQUIRED");
    expect(JSON.stringify(facts)).not.toContain("which database");
  });

  it("distinguishes no writer, this bridge, and another process", () => {
    expect(factsFromSummary(summary({ liveWriter: null })).hasLiveWriter).toBe(false);
    expect(factsFromSummary(summary()).liveWriterIsThisBridge).toBe(true);
    const other = factsFromSummary(summary({ liveInThisBridge: false }));
    expect(other.hasLiveWriter).toBe(true);
    expect(other.liveWriterIsThisBridge).toBe(false);
  });
});

/* ------------------------------------------------------------ selection */

describe("choosing which links to describe", () => {
  it("takes the newest first, with the run id as a stable tie-break", () => {
    const selected = selectRecentExecutionLinks([
      link({ runId: "run-b", createdAt: "2026-03-01T10:00:00.000Z" }),
      link({ runId: "run-old", createdAt: "2026-02-01T10:00:00.000Z" }),
      link({ runId: "run-a", createdAt: "2026-03-01T10:00:00.000Z" }),
    ]);
    // Same instant, so the tie-break decides — and decides the same way every
    // turn, which is what stops the context reordering under a model's nose.
    expect(selected.map((each) => each.runId)).toEqual(["run-a", "run-b", "run-old"]);
  });

  it("stops at the link limit", () => {
    const many = Array.from({ length: 25 }, (_, index) =>
      link({
        runId: `run-${String(index).padStart(2, "0")}`,
        createdAt: `2026-03-${String(index + 1).padStart(2, "0")}T10:00:00.000Z`,
      }),
    );
    const selected = selectRecentExecutionLinks(many);
    expect(selected).toHaveLength(NAVIGATOR_CONTEXT_MAX_LINKS);
    expect(selected[0]?.runId).toBe("run-24");
    expect(selected.at(-1)?.runId).toBe("run-17");
  });

  it("does not mutate the caller's array", () => {
    const links = [
      link({ runId: "run-a", createdAt: "2026-01-01T00:00:00.000Z" }),
      link({ runId: "run-b", createdAt: "2026-03-01T00:00:00.000Z" }),
    ];
    selectRecentExecutionLinks(links);
    expect(links.map((each) => each.runId)).toEqual(["run-a", "run-b"]);
  });
});

describe("choosing which runs get a second read", () => {
  it("attaches only for DONE and OWNER_REQUIRED", () => {
    for (const state of ["done", "owner_required"] as const) {
      expect(shouldAttachForFacts(factsFromSummary(summary({ state }))), state).toBe(true);
    }
    for (const state of [
      "idle",
      "reviewer_working",
      "builder_working",
      "paused",
      "interrupted",
      "error",
    ] as const) {
      // An ordinary active run has nothing extra worth a bridge request, and
      // one per historical card is how a turn gets slow.
      expect(shouldAttachForFacts(factsFromSummary(summary({ state }))), state).toBe(false);
    }
    expect(shouldAttachForFacts(null)).toBe(false);
  });

  it("takes the most recent qualifying runs, up to the attachment limit", () => {
    const entries = Array.from({ length: 10 }, (_, index) => ({
      runId: `run-${String(index)}`,
      facts: factsFromSummary(summary({ state: index % 2 === 0 ? "done" : "builder_working" })),
    }));
    const targets = selectAttachTargets(entries);
    expect(targets).toHaveLength(NAVIGATOR_CONTEXT_MAX_ATTACHMENTS);
    // List order is already newest-first, so "first qualifying four" is the
    // four most recent qualifying runs.
    expect(targets).toEqual(["run-0", "run-2", "run-4", "run-6"]);
  });
});

/* --------------------------------------------------------- attachment */

describe("the structured detail in a snapshot", () => {
  it("takes only the Reviewer's DONE fields and the recorded repo ref", () => {
    const detail = detailFromSnapshot({
      state: stateFile({
        lastReviewerDecision: {
          decision: "DONE",
          summary: "Backfill shipped.",
          finalState: "Green on main.",
        },
        repo: {
          head: "abc123def456",
          branch: "main",
          worktreeDigest: "digest",
          isGitRepo: true,
          capturedAt: "2026-03-01T10:05:00.000Z",
        },
      }),
      expected: "done",
    });
    expect(detail).toEqual({
      kind: "done",
      summary: "Backfill shipped.",
      finalState: "Green on main.",
      head: "abc123def456",
      branch: "main",
    });
  });

  it("never reads a Builder report, task or owner policy to manufacture one", () => {
    // All three are on the same object, all three are prose, and none of them
    // is a structured answer to "what happened".
    const detail = detailFromSnapshot({ state: stateFile(), expected: "done" });
    expect(detail).toEqual({ kind: "unavailable" });
    expect(JSON.stringify(detail)).not.toContain("BUILDER");
  });

  it("takes only the structured owner question, reason and options", () => {
    const detail = detailFromSnapshot({
      state: stateFile({
        state: "owner_required",
        lastReviewerDecision: {
          decision: "OWNER_REQUIRED",
          summary: "Blocked.",
          ownerQuestion: "Which database should the backfill target?",
          whyOwnerIsRequired: "Both are in use.",
          options: ["Primary", "Replica"],
        },
      }),
      expected: "owner-required",
    });
    expect(detail).toEqual({
      kind: "owner-required",
      question: "Which database should the backfill target?",
      why: "Both are in use.",
      options: ["Primary", "Replica"],
    });
  });

  it("refuses a decision of the wrong kind rather than reinterpreting it", () => {
    const continueDecision = stateFile({
      lastReviewerDecision: { decision: "CONTINUE", summary: "s", builderTask: "t" },
    });
    expect(detailFromSnapshot({ state: continueDecision, expected: "done" })).toEqual({
      kind: "unavailable",
    });
    expect(detailFromSnapshot({ state: continueDecision, expected: "owner-required" })).toEqual({
      kind: "unavailable",
    });
  });

  it("bounds every Reviewer field and the option list", () => {
    const long = "x".repeat(5_000);
    const done = detailFromSnapshot({
      state: stateFile({
        lastReviewerDecision: { decision: "DONE", summary: long, finalState: long },
        repo: {
          head: long,
          branch: long,
          worktreeDigest: null,
          isGitRepo: true,
          capturedAt: "2026-03-01T10:05:00.000Z",
        },
      }),
      expected: "done",
    });
    expect(done.kind).toBe("done");
    if (done.kind !== "done") return;
    expect(done.summary.length).toBe(NAVIGATOR_CONTEXT_SUMMARY_CHARS);
    expect(done.finalState.length).toBe(NAVIGATOR_CONTEXT_FINAL_STATE_CHARS);
    expect((done.head ?? "").length).toBeLessThanOrEqual(64);

    const owner = detailFromSnapshot({
      state: stateFile({
        lastReviewerDecision: {
          decision: "OWNER_REQUIRED",
          summary: "s",
          ownerQuestion: long,
          whyOwnerIsRequired: long,
          options: Array.from({ length: 40 }, (_, index) => `option ${String(index)}`),
        },
      }),
      expected: "owner-required",
    });
    expect(owner.kind).toBe("owner-required");
    if (owner.kind !== "owner-required") return;
    expect(owner.question.length).toBe(NAVIGATOR_CONTEXT_QUESTION_CHARS);
    expect(owner.why.length).toBe(NAVIGATOR_CONTEXT_QUESTION_CHARS);
    expect(owner.options).toHaveLength(NAVIGATOR_CONTEXT_OPTION_LIMIT);
  });
});

/* -------------------------------------------------------------- render */

describe("the rendered block", () => {
  it("is null when there is nothing to say", () => {
    // Null, not an empty section: a conversation that has launched nothing
    // must be framed exactly as it was before this existed.
    expect(renderNavigatorExecutionContext({ entries: [] })).toBeNull();
  });

  it("says these are observations, and that Navigator changed nothing", () => {
    const rendered = renderNavigatorExecutionContext({ entries: [entry()] }) ?? "";
    expect(rendered.startsWith(NAVIGATOR_CONTEXT_HEADING)).toBe(true);
    expect(rendered).toContain("not authorization");
    expect(rendered).toContain("explain or summarize them for the Owner in plain language");
    expect(rendered).toContain("must");
    expect(rendered).toContain("not claim that you approved, resumed, recovered");
    expect(rendered).toContain("explicit Peer Loop controls");
  });

  it("carries the structured facts and nothing from the summary it dropped", () => {
    const rendered =
      renderNavigatorExecutionContext({
        entries: [
          entry({
            facts: factsFromSummary(
              summary({
                state: "owner_required",
                iteration: 7,
                queuedOwnerMessages: 2,
                haltReason: { kind: "OWNER_REQUIRED", message: "free text" },
              }),
            ),
          }),
        ],
      }) ?? "";
    expect(rendered).toContain("run run-77");
    expect(rendered).toContain("proposal: plan-1");
    expect(rendered).toContain("linked at: 2026-03-01T10:00:00.000Z");
    expect(rendered).toContain("state: owner_required; iteration: 7");
    expect(rendered).toContain("halt: OWNER_REQUIRED; queued owner messages: 2");
    expect(rendered).toContain("live writer: yes (this bridge)");
    for (const leaked of ["/Users/owner", "workstation.local", "free text", "claude-code"]) {
      expect(rendered, leaked).not.toContain(leaked);
    }
  });

  it("says plainly when a linked run is missing from the list, or unreadable", () => {
    const missing = renderNavigatorExecutionContext({ entries: [entry({ facts: null })] }) ?? "";
    expect(missing).toContain("not currently listing this run");
    expect(missing).toContain("Nothing is known about its state");

    const unreadable =
      renderNavigatorExecutionContext({ entries: [entry({ facts: null, unreadable: true })] }) ??
      "";
    expect(unreadable).toContain("could not read this run's record");
  });

  it("degrades to one neutral sentence when Peer Loop could not be read", () => {
    const rendered =
      renderNavigatorExecutionContext({ entries: [], degraded: "status-unavailable" }) ?? "";
    expect(rendered).toContain("Structured execution status is unavailable");
    expect(rendered).toContain("Say so plainly if the Owner asks");

    const noRecords =
      renderNavigatorExecutionContext({ entries: [], degraded: "records-unavailable" }) ?? "";
    expect(noRecords).toContain("Execution records are unavailable");
  });

  it("stays within the total budget, with a marker rather than a silent cut", () => {
    const rendered =
      renderNavigatorExecutionContext({
        entries: Array.from({ length: NAVIGATOR_CONTEXT_MAX_LINKS }, (_, index) =>
          entry({
            runId: `run-${String(index)}`,
            detail: {
              kind: "owner-required",
              question: "q".repeat(NAVIGATOR_CONTEXT_QUESTION_CHARS),
              why: "w".repeat(NAVIGATOR_CONTEXT_QUESTION_CHARS),
              options: Array.from({ length: NAVIGATOR_CONTEXT_OPTION_LIMIT }, () =>
                "o".repeat(200),
              ),
            },
          }),
        ),
      }) ?? "";
    expect(rendered.length).toBeLessThanOrEqual(NAVIGATOR_CONTEXT_MAX_CHARS);
    expect(rendered.endsWith(NAVIGATOR_CONTEXT_TRUNCATION_MARKER)).toBe(true);
  });

  it("numbers entries in the order it was given them", () => {
    const rendered =
      renderNavigatorExecutionContext({
        entries: [entry({ runId: "run-a" }), entry({ runId: "run-b" })],
      }) ?? "";
    expect(rendered.indexOf("1. run run-a")).toBeGreaterThan(-1);
    expect(rendered.indexOf("2. run run-b")).toBeGreaterThan(rendered.indexOf("1. run run-a"));
  });
});
