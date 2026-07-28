import type {
  AgentRunCycle,
  AgentRunDetail,
  AgentRunSummary,
  AgentRunTimelineEntry,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildAgentRunMarkdown } from "./agentRunReport";

/**
 * The report is a transport format, so the tests care about two things: that
 * everything a second reader needs survives the trip, and that nothing which
 * must not leave the machine does.
 */

const NOW = Date.parse("2026-07-28T22:00:00.000Z");

const summary = (overrides: Partial<AgentRunSummary> = {}): AgentRunSummary =>
  ({
    id: "run-20260728-182828-e6e45ff9",
    project: "ExtractoPro Content Ops",
    title: "Implement Phase 1D Sprint 1",
    workOrderId: "content-ops-phase-1d-sprint-1",
    state: "HUMAN_REQUIRED",
    terminal: true,
    attentionRequired: true,
    currentCycle: 1,
    maxCycles: 2,
    activeRole: "none",
    startedAt: "2026-07-28T18:28:30.142Z",
    updatedAt: "2026-07-28T18:54:46.348Z",
    finishedAt: "2026-07-28T18:54:46.360Z",
    workerExecutionCount: 1,
    reviewerExecutionCount: 1,
    terminalReason: "ESCALATED",
    humanRequired: {
      present: true,
      source: "derived",
      reasonCode: "ESCALATED",
      summary: "Contract ambiguity is an explicit stop condition.",
      decisionNeeded: "Decide whether the added test files are authorized.",
      options: [],
      evidence: ["format:check failed on two files", "A12 remains incomplete"],
      createdAt: "2026-07-28T18:54:46.360Z",
    },
    process: {
      lockHeld: false,
      pid: null,
      hostname: null,
      lockState: null,
      acquiredAt: null,
      sameHost: false,
      alive: null,
      detached: null,
      inconsistent: false,
    },
    activity: {
      lastActivityAt: "2026-07-28T18:54:46.348Z",
      lastActivitySource: "event",
      lastStreamWriteAt: null,
      streamBytes: null,
      filesChanged: 7,
      filesChangedAt: "2026-07-28T18:54:46.335Z",
      filesChangedSource: "run-record",
    },
    ...overrides,
  }) as AgentRunSummary;

const cycle = (overrides: Partial<AgentRunCycle> = {}): AgentRunCycle =>
  ({
    number: 1,
    startedAt: "2026-07-28T18:28:30.168Z",
    finishedAt: "2026-07-28T18:54:46.335Z",
    workerStatus: "passed",
    validationStatus: "failed",
    reviewerStatus: "escalated",
    finalValidationStatus: "skipped",
    workerSummary: "Implemented the composition module.",
    changedFiles: ["src/db/schema.ts", "src/modules/article-composition/domain.ts"],
    executions: [],
    review: {
      cycle: 1,
      verdict: "ESCALATE",
      summary: "The Work Order is internally contradictory about test-file changes.",
      requiredChanges: [],
      blockingReason: "Contract ambiguity is an explicit stop condition.",
      evidence: ["format:check failed", "A12 incomplete"],
    },
    validation: [
      {
        stage: "post_worker",
        cycle: 1,
        ranAt: "2026-07-28T18:53:52.055Z",
        passed: false,
        checks: [
          {
            id: "typecheck",
            name: "typecheck",
            outcome: "PASSED",
            passed: true,
            durationMs: 19_000,
            exitCode: 0,
            failureDetail: null,
          },
          {
            id: "format-check",
            name: "format:check",
            outcome: "CHECK_FAILED",
            passed: false,
            durationMs: 6_000,
            exitCode: 1,
            failureDetail:
              "[warn] src/application/article-composition.ts\n[warn] Code style issues",
          },
        ],
      },
    ],
    finalGate: null,
    ...overrides,
  }) as AgentRunCycle;

const timeline: readonly AgentRunTimelineEntry[] = [
  {
    at: "2026-07-28T18:28:34.602Z",
    kind: "worker",
    title: "Claude started",
    detail: "worker=claude-code attempt=1",
    cycle: 1,
    tone: "running",
    source: "events",
  },
  {
    at: "2026-07-28T18:54:46.348Z",
    kind: "reviewer",
    title: "Codex escalated",
    detail: null,
    cycle: 1,
    tone: "attention",
    source: "events",
  },
];

const detail = (overrides: Partial<AgentRunDetail> = {}): AgentRunDetail =>
  ({
    summary: summary(),
    objective: "Implement Phase 1D Sprint 1 — Article composition foundation.",
    workspace: {
      strategy: "git-worktree",
      branch: "orchestrator/extractopro-content-ops/run-20260728-182828-e6e45ff9",
      baseSha: "fa82be694f777dba68567d802421e579ad05fcf5",
      worktreePath: "/Users/x/.orchestrator/worktrees/run-20260728-182828-e6e45ff9",
      repositoryPath: "/Users/x/extractopro-content-ops",
    },
    cycles: [cycle()],
    timeline,
    agents: { worker: "claude-code", reviewer: "codex" },
    limits: { maxWorkerExecutions: 2, maxReviewerExecutions: 2 },
    interruptions: 0,
    resumes: 0,
    degraded: [],
    ...overrides,
  }) as AgentRunDetail;

describe("buildAgentRunMarkdown", () => {
  it("reports a HUMAN_REQUIRED run with everything a second reader needs", () => {
    const md = buildAgentRunMarkdown(detail(), { nowMs: NOW });

    expect(md).toContain("# Agent Run Report");
    expect(md).toContain("**Run:** run-20260728-182828-e6e45ff9");
    expect(md).toContain("**State:** HUMAN_REQUIRED (Human required)");
    expect(md).toContain("**Cycle:** 1 / 2");
    expect(md).toContain("**Terminal reason:** ESCALATED");
    expect(md).toContain("## Human input required");
    expect(md).toContain("**Reason code:** ESCALATED");
    expect(md).toContain("Contract ambiguity is an explicit stop condition.");
    expect(md).toContain("Decide whether the added test files are authorized.");
    expect(md).toContain("- A12 remains incomplete");
    // The question a reader asks immediately after "it stopped".
    expect(md).toContain("Agents currently running: none (run is terminal)");
  });

  it("labels a derived packet as derived, and a durable one as durable", () => {
    expect(buildAgentRunMarkdown(detail(), { nowMs: NOW })).toContain(
      "predates structured decision packets",
    );

    const withPacket = detail({
      summary: summary({
        humanRequired: {
          present: true,
          source: "packet",
          reasonCode: "ESCALATED",
          summary: "Reviewer escalated.",
          decisionNeeded: "Authorize the test files, or revert them?",
          options: ["authorize", "revert"],
          evidence: [],
          createdAt: "2026-07-28T18:54:46.360Z",
        },
      }),
    });
    const md = buildAgentRunMarkdown(withPacket, { nowMs: NOW });
    expect(md).toContain("durable packet recorded by the orchestrator");
    expect(md).not.toContain("predates structured decision packets");
    expect(md).toContain("- authorize");
    expect(md).toContain("- revert");
  });

  it("omits the human-input section entirely for a completed run", () => {
    const md = buildAgentRunMarkdown(
      detail({
        summary: summary({
          state: "COMPLETED",
          terminalReason: "OBJECTIVE_DONE",
          attentionRequired: false,
          humanRequired: {
            present: false,
            source: "none",
            reasonCode: null,
            summary: null,
            decisionNeeded: null,
            options: [],
            evidence: [],
            createdAt: null,
          },
        }),
      }),
      { nowMs: NOW },
    );

    expect(md).not.toContain("## Human input required");
    expect(md).toContain("**State:** COMPLETED (Completed)");
    expect(md).toContain("## Cycles");
  });

  it("reports a failed run", () => {
    const md = buildAgentRunMarkdown(
      detail({
        summary: summary({
          state: "FAILED",
          terminalReason: "WORKER_ERROR",
          humanRequired: {
            present: true,
            source: "derived",
            reasonCode: "WORKER_ERROR",
            summary: "The worker exited with status AGENT_ERROR.",
            decisionNeeded: null,
            options: [],
            evidence: [],
            createdAt: "2026-07-28T18:54:46.360Z",
          },
        }),
      }),
      { nowMs: NOW },
    );

    expect(md).toContain("**State:** FAILED (Failed)");
    expect(md).toContain("**Reason code:** WORKER_ERROR");
    expect(md).toContain("The worker exited with status AGENT_ERROR.");
  });

  it("renders every cycle of a multi-cycle run in order", () => {
    const md = buildAgentRunMarkdown(
      detail({
        summary: summary({ currentCycle: 2, state: "COMPLETED" }),
        cycles: [
          cycle({ number: 1, reviewerStatus: "rework" }),
          cycle({
            number: 2,
            workerSummary: "Addressed both requested changes.",
            review: {
              cycle: 2,
              verdict: "OBJECTIVE_DONE",
              summary: "Both addressed.",
              requiredChanges: [],
              blockingReason: null,
              evidence: [],
            },
            finalGate: {
              cycle: 2,
              ranAt: "2026-07-28T19:25:00.000Z",
              passed: true,
              checksRun: ["lint", "unit"],
              failures: [],
            },
          }),
        ],
      }),
      { nowMs: NOW },
    );

    expect(md).toContain("### Cycle 1");
    expect(md).toContain("### Cycle 2");
    expect(md.indexOf("### Cycle 1")).toBeLessThan(md.indexOf("### Cycle 2"));
    expect(md).toContain("Addressed both requested changes.");
    expect(md).toContain("## Final validation");
    expect(md).toContain("Cycle 2 — passed at 2026-07-28T19:25:00.000Z");
    expect(md).toContain("- `lint`");
  });

  it("includes the output of a failing check and omits it for a passing one", () => {
    const md = buildAgentRunMarkdown(detail(), { nowMs: NOW });

    expect(md).toContain("- `format-check` — FAILED (6s)");
    expect(md).toContain("[warn] Code style issues");
    expect(md).toContain("- `typecheck` — PASSED (19s)");
  });

  it("never carries the output of a passing check, however large", () => {
    const noisy = detail({
      cycles: [
        cycle({
          validation: [
            {
              stage: "post_worker",
              cycle: 1,
              ranAt: "2026-07-28T18:53:52.055Z",
              passed: true,
              checks: [
                {
                  id: "git-diff",
                  name: "git diff",
                  outcome: "PASSED",
                  passed: true,
                  durationMs: 21,
                  exitCode: 0,
                  // The adapter never populates this for a passing check; if a
                  // future change did, the report must still not print it.
                  failureDetail: "diff --git a/very/large/file.ts THOUSANDS OF LINES",
                },
              ],
            },
          ],
        }),
      ],
    });

    const md = buildAgentRunMarkdown(noisy, { nowMs: NOW });
    expect(md).toContain("- `git-diff` — PASSED");
    expect(md).not.toContain("THOUSANDS OF LINES");
  });

  it("carries the reviewer verdict, blocking reason, changes and evidence", () => {
    const md = buildAgentRunMarkdown(
      detail({
        cycles: [
          cycle({
            review: {
              cycle: 1,
              verdict: "REWORK",
              summary: "Two things to fix.",
              requiredChanges: ["Handle the empty case", "Name the constant"],
              blockingReason: null,
              evidence: ["unit test t/x failed"],
            },
          }),
        ],
      }),
      { nowMs: NOW },
    );

    expect(md).toContain("#### Reviewer — codex");
    expect(md).toContain("Verdict: **REWORK**");
    expect(md).toContain("- Handle the empty case");
    expect(md).toContain("- unit test t/x failed");
  });

  it("carries the durable timeline verbatim and invents nothing", () => {
    const md = buildAgentRunMarkdown(detail(), { nowMs: NOW });

    expect(md).toContain("## Timeline");
    expect(md).toContain("- `2026-07-28T18:28:34.602Z` [cycle 1] Claude started");
    expect(md).toContain("Codex escalated");
    // Two events in, two events out.
    const timelineSection = md.slice(md.indexOf("## Timeline"), md.indexOf("## Technical details"));
    expect(timelineSection.match(/^- `/gm)).toHaveLength(2);
  });

  it("carries the technical identity in its own section", () => {
    const md = buildAgentRunMarkdown(detail(), { nowMs: NOW });
    const technical = md.slice(md.indexOf("## Technical details"));

    expect(technical).toContain("**Work order:** content-ops-phase-1d-sprint-1");
    expect(technical).toContain("**Worker adapter:** claude-code");
    expect(technical).toContain("**Reviewer adapter:** codex");
    expect(technical).toContain("**Base commit:** fa82be694f777dba68567d802421e579ad05fcf5");
    expect(technical).toContain("**Worker executions:** 1 / 2");
    expect(technical).toContain("**Interruptions:** 0 (resumed 0×)");
    expect(technical).toContain("**Run lock:** not held");
    // Paths are allowed, but only down here.
    expect(technical).toContain("/extractopro-content-ops");
    expect(md.slice(0, md.indexOf("## Technical details"))).not.toContain(
      "/extractopro-content-ops",
    );
  });

  it("degrades cleanly when optional evidence is missing", () => {
    const sparse = detail({
      objective: null,
      cycles: [],
      timeline: [],
      workspace: {
        strategy: null,
        branch: null,
        baseSha: null,
        worktreePath: null,
        repositoryPath: null,
      },
      limits: { maxWorkerExecutions: null, maxReviewerExecutions: null },
      summary: summary({
        finishedAt: null,
        terminalReason: null,
        humanRequired: {
          present: false,
          source: "none",
          reasonCode: null,
          summary: null,
          decisionNeeded: null,
          options: [],
          evidence: [],
          createdAt: null,
        },
      }),
    });

    const md = buildAgentRunMarkdown(sparse, { nowMs: NOW });

    expect(md).toContain("# Agent Run Report");
    expect(md).toContain("No recorded events.");
    expect(md).not.toContain("## Cycles");
    expect(md).not.toContain("## Final validation");
    // No stray labels for absent values, and no literal null/undefined anywhere.
    expect(md).not.toContain("null");
    expect(md).not.toContain("undefined");
    expect(md).not.toContain("**Branch:**");
  });

  it("does not leak secrets that the model never carried", () => {
    // The adapter redacts before anything reaches the client, so the report's
    // job is simply not to reintroduce a raw source. Assert on the whole
    // document rather than a section, since a leak anywhere is a leak.
    const md = buildAgentRunMarkdown(detail(), { nowMs: NOW });

    for (const forbidden of [
      "TEST_DATABASE_URL=",
      "postgres://",
      "Bearer ",
      "sk-",
      "ghp_",
      "AKIA",
      "PRIVATE KEY",
    ]) {
      expect(md).not.toContain(forbidden);
    }
  });

  it("stays valid Markdown when evidence contains backticks", () => {
    const tricky = detail({
      cycles: [
        cycle({
          validation: [
            {
              stage: "post_worker",
              cycle: 1,
              ranAt: "2026-07-28T18:53:52.055Z",
              passed: false,
              checks: [
                {
                  id: "unit",
                  name: "unit",
                  outcome: "CHECK_FAILED",
                  passed: false,
                  durationMs: 100,
                  exitCode: 1,
                  failureDetail: "expected ```fenced``` output",
                },
              ],
            },
          ],
        }),
      ],
    });

    const md = buildAgentRunMarkdown(tricky, { nowMs: NOW });
    // The fence must be longer than the longest backtick run it contains, or
    // the block would terminate early and the rest of the report would break.
    expect(md).toContain("````\nexpected ```fenced``` output\n````");
  });

  it("reads as a document, not as generated output", () => {
    const md = buildAgentRunMarkdown(detail(), { nowMs: NOW });

    expect(md.startsWith("# Agent Run Report\n")).toBe(true);
    expect(md.endsWith("\n")).toBe(true);
    // No runs of blank lines, and no trailing whitespace on any line.
    expect(md).not.toMatch(/\n{3,}/);
    expect(md).not.toMatch(/[ \t]+$/m);
    expect(md).toMatch(/^## Cycles$/m);
  });

  it("reports elapsed time for a run still in flight", () => {
    const running = detail({
      summary: summary({
        state: "WORKER_RUNNING",
        terminal: false,
        finishedAt: null,
        activeRole: "worker",
        startedAt: "2026-07-28T21:50:00.000Z",
        process: {
          lockHeld: true,
          pid: 4242,
          hostname: "mac",
          lockState: "WORKER_RUNNING",
          acquiredAt: "2026-07-28T21:50:00.000Z",
          sameHost: true,
          alive: true,
          detached: true,
          inconsistent: false,
        },
      }),
    });

    const md = buildAgentRunMarkdown(running, { nowMs: NOW });
    expect(md).toContain("**Duration:** 10m 00s");
    expect(md).toContain("**Agents active:** worker (claude-code) — process alive (detached)");
  });
});
