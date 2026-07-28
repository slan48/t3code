import type {
  AgentRunCheck,
  AgentRunCycle,
  AgentRunDetail,
  AgentRunReview,
  AgentRunTimelineEntry,
} from "@t3tools/contracts";
import { agentRunStateLabel } from "@t3tools/contracts";

import { describeProcess, elapsedMillis, formatDuration, phaseStatusLabel } from "./agentRunFormat";

/**
 * A run, rendered as Markdown for a human to paste somewhere else.
 *
 * The point is transport. A run detail spans several screens, and the previous
 * way to get it to another reader — a reviewer, ChatGPT, a colleague — was a
 * stack of screenshots, which is exactly the copy friction the cockpit existed
 * to remove.
 *
 * Two rules make the output trustworthy:
 *
 *   1. It is built from the **normalized run model**, never from the DOM. What
 *      is currently expanded or collapsed on screen has no bearing on the
 *      report, so two people copying the same run get the same bytes.
 *   2. It carries **no evidence the UI does not already hold**. Check output
 *      arrives here having already passed the adapter's redaction and length
 *      bounds, and nothing here reads a file or calls anything. If a secret
 *      cannot reach the screen it cannot reach the clipboard.
 *
 * Pure and synchronous, so the interesting cases are unit-testable without a
 * clipboard, a browser, or a server.
 */

/** Fence a block safely even when the content itself contains backticks. */
function fence(content: string, language = ""): string {
  const longestRun = [...content.matchAll(/`+/g)].reduce(
    (longest, match) => Math.max(longest, match[0].length),
    0,
  );
  const ticks = "`".repeat(Math.max(3, longestRun + 1));
  return `${ticks}${language}\n${content.trimEnd()}\n${ticks}`;
}

/** A block of prose under a label, omitted entirely when there is nothing to say. */
function section(label: string, value: string | null): readonly string[] {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) return [];
  return [`**${label}:**`, "", trimmed, ""];
}

function bulletList(label: string, items: readonly string[]): readonly string[] {
  if (items.length === 0) return [];
  return [`**${label}:**`, "", ...items.map((item) => `- ${collapse(item)}`), ""];
}

/** Fold hard-wrapped prose into one line so list items stay readable. */
function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function field(label: string, value: string | null): readonly string[] {
  return value === null || value.length === 0 ? [] : [`- **${label}:** ${value}`];
}

/**
 * What, if anything, is running right now.
 *
 * Keeps the distinction the UI makes: an active role is not the same claim as
 * a live process, and a reader of the report needs to know which one is being
 * asserted.
 */
function describeAgentsActive(detail: AgentRunDetail): string {
  const { summary } = detail;
  if (summary.activeRole === "none") {
    return summary.terminal ? "none (run is terminal)" : "none";
  }
  const who =
    summary.activeRole === "worker"
      ? `worker (${detail.agents.worker})`
      : summary.activeRole === "reviewer"
        ? `reviewer (${detail.agents.reviewer})`
        : summary.activeRole === "validation"
          ? "deterministic validation"
          : "final acceptance gate";
  return `${who} — ${describeProcess(summary.process).label.toLowerCase()}`;
}

/* ------------------------------------------------------------- validation */

function renderCheck(check: AgentRunCheck): readonly string[] {
  const duration = check.durationMs === null ? "" : ` (${formatDuration(check.durationMs)})`;
  const mark = check.passed === true ? "PASSED" : check.passed === false ? "FAILED" : "UNKNOWN";
  const lines = [`- \`${check.id}\` — ${mark}${duration}`];

  // Only failures carry their output. A passing `git diff` check would other-
  // wise drown the report in the entire diff for no diagnostic value, which is
  // the same reason the UI keeps it off screen.
  if (check.passed !== true && check.failureDetail !== null) {
    lines.push("", fence(check.failureDetail), "");
  }
  return lines;
}

function renderValidation(cycle: AgentRunCycle): readonly string[] {
  const reports = cycle.validation.filter((report) => report.stage !== "final");
  if (reports.length === 0) return [];

  const lines: string[] = ["#### Validation", ""];
  for (const report of reports) {
    lines.push(`Stage: \`${report.stage}\` — ${describePassed(report.passed)}`, "");
    for (const check of report.checks) lines.push(...renderCheck(check));
    lines.push("");
  }
  return lines;
}

function describePassed(passed: boolean | null): string {
  return passed === null ? "unknown" : passed ? "passed" : "failed";
}

/* -------------------------------------------------------------- reviewer */

function renderReview(review: AgentRunReview, reviewerId: string): readonly string[] {
  return [
    `#### Reviewer — ${reviewerId}`,
    "",
    `Verdict: **${review.verdict}**`,
    "",
    ...section("Summary", review.summary),
    ...section("Blocking reason", review.blockingReason),
    ...bulletList("Required changes", review.requiredChanges),
    ...bulletList("Evidence", review.evidence),
  ];
}

/* ---------------------------------------------------------------- cycles */

function renderCycle(cycle: AgentRunCycle, detail: AgentRunDetail): readonly string[] {
  const lines: string[] = [`### Cycle ${cycle.number}`, ""];

  lines.push(
    `#### Worker — ${detail.agents.worker}`,
    "",
    `Outcome: ${phaseStatusLabel(cycle.workerStatus)}`,
    "",
    ...section("Summary", cycle.workerSummary),
  );

  if (cycle.changedFiles.length > 0) {
    lines.push(...bulletList(`Files changed (${cycle.changedFiles.length})`, cycle.changedFiles));
  }

  lines.push(...renderValidation(cycle));

  if (cycle.review !== null) {
    lines.push(...renderReview(cycle.review, detail.agents.reviewer));
  } else {
    lines.push(`#### Reviewer — ${detail.agents.reviewer}`, "", "No review recorded.", "");
  }

  return lines;
}

/* ------------------------------------------------------ final validation */

function renderFinalValidation(detail: AgentRunDetail): readonly string[] {
  const gates = detail.cycles
    .filter((cycle) => cycle.finalGate !== null)
    .map((cycle) => ({ cycle, gate: cycle.finalGate! }));
  const finalStageReports = detail.cycles.flatMap((cycle) =>
    cycle.validation.filter((report) => report.stage === "final"),
  );
  if (gates.length === 0 && finalStageReports.length === 0) return [];

  const lines: string[] = ["## Final validation", ""];

  for (const { cycle, gate } of gates) {
    lines.push(
      `Cycle ${cycle.number} — ${gate.passed ? "passed" : "failed"} at ${gate.ranAt}`,
      "",
      // Check ids are rendered as code everywhere else in the report; keeping
      // that consistent is what lets a reader scan for one by eye.
      ...bulletList(
        "Checks run",
        gate.checksRun.map((id) => `\`${id}\``),
      ),
    );
    for (const failure of gate.failures) lines.push(...renderCheck(failure));
    lines.push("");
  }

  for (const report of finalStageReports) {
    lines.push(`Cycle ${report.cycle} — ${describePassed(report.passed)}`, "");
    for (const check of report.checks) lines.push(...renderCheck(check));
    lines.push("");
  }

  return lines;
}

/* -------------------------------------------------------------- timeline */

function renderTimeline(entries: readonly AgentRunTimelineEntry[]): readonly string[] {
  if (entries.length === 0) return ["## Timeline", "", "No recorded events.", ""];
  return [
    "## Timeline",
    "",
    ...entries.map((entry) => {
      const cycle = entry.cycle === null ? "" : ` [cycle ${entry.cycle}]`;
      const detail = entry.detail === null ? "" : ` — ${collapse(entry.detail)}`;
      return `- \`${entry.at}\`${cycle} ${entry.title}${detail}`;
    }),
    "",
  ];
}

/* --------------------------------------------------------- human required */

function renderHumanRequired(detail: AgentRunDetail): readonly string[] {
  const { humanRequired } = detail.summary;
  if (!humanRequired.present) return [];

  const provenance =
    humanRequired.source === "packet"
      ? "durable packet recorded by the orchestrator"
      : "derived by T3 Code from the reviewer verdict and run outcome (this run predates structured decision packets)";

  return [
    "## Human input required",
    "",
    ...field("Reason code", humanRequired.reasonCode),
    ...field("Source", provenance),
    ...field("Recorded at", humanRequired.createdAt),
    "",
    ...section("Why the run stopped", humanRequired.summary),
    ...section("Decision needed", humanRequired.decisionNeeded),
    ...bulletList("Options", humanRequired.options),
    ...bulletList("Relevant evidence", humanRequired.evidence),
    `Agents currently running: ${describeAgentsActive(detail)}`,
    "",
  ];
}

/* -------------------------------------------------------------- technical */

function renderTechnical(detail: AgentRunDetail): readonly string[] {
  const { summary, workspace } = detail;
  const process = summary.process;

  return [
    "## Technical details",
    "",
    ...field("Run id", summary.id),
    ...field("Work order", summary.workOrderId),
    ...field("Worker adapter", detail.agents.worker),
    ...field("Reviewer adapter", detail.agents.reviewer),
    ...field("Base commit", workspace.baseSha),
    ...field("Branch", workspace.branch),
    ...field("Worktree", workspace.worktreePath),
    ...field("Repository", workspace.repositoryPath),
    ...field(
      "Worker executions",
      `${summary.workerExecutionCount}${
        detail.limits.maxWorkerExecutions === null ? "" : ` / ${detail.limits.maxWorkerExecutions}`
      }`,
    ),
    ...field(
      "Reviewer executions",
      `${summary.reviewerExecutionCount}${
        detail.limits.maxReviewerExecutions === null
          ? ""
          : ` / ${detail.limits.maxReviewerExecutions}`
      }`,
    ),
    ...field("Interruptions", `${detail.interruptions} (resumed ${detail.resumes}×)`),
    ...field(
      "Run lock",
      process.lockHeld
        ? `pid ${process.pid ?? "?"} on ${process.hostname ?? "?"} (${process.lockState ?? "?"})`
        : "not held",
    ),
    ...field("Last durable activity", summary.activity.lastActivityAt),
    ...field("Last activity source", summary.activity.lastActivitySource),
    ...(detail.degraded.length > 0 ? ["", ...bulletList("Evidence gaps", detail.degraded)] : []),
    "",
  ];
}

/* ----------------------------------------------------------------- entry */

export interface BuildAgentRunMarkdownOptions {
  /** Wall clock, injected so an in-flight run's duration is deterministic in tests. */
  readonly nowMs: number;
}

/**
 * Render a complete run report.
 *
 * Ordered the way the surface is: what needs a human first, then what
 * happened, then the identifiers. A reader who stops after the first screen
 * still has the part that required them.
 */
export function buildAgentRunMarkdown(
  detail: AgentRunDetail,
  options: BuildAgentRunMarkdownOptions,
): string {
  const { summary } = detail;
  const duration = formatDuration(
    elapsedMillis(summary.startedAt, summary.finishedAt, options.nowMs),
  );

  const lines: string[] = [
    "# Agent Run Report",
    "",
    ...field("Run", summary.id),
    ...field("Project", summary.project),
    ...field("Title", summary.title),
    ...field("State", `${summary.state} (${agentRunStateLabel(summary.state)})`),
    ...field("Cycle", `${summary.currentCycle} / ${summary.maxCycles}`),
    ...field("Started", summary.startedAt),
    ...field("Updated", summary.updatedAt),
    ...field("Finished", summary.finishedAt),
    ...field("Duration", duration),
    ...field("Terminal reason", summary.terminalReason),
    ...field("Agents active", describeAgentsActive(detail)),
    "",
    ...section("Objective", detail.objective),
    ...renderHumanRequired(detail),
  ];

  if (detail.cycles.length > 0) {
    lines.push("## Cycles", "");
    for (const cycle of detail.cycles) lines.push(...renderCycle(cycle, detail));
  }

  lines.push(...renderFinalValidation(detail));
  lines.push(...renderTimeline(detail.timeline));
  lines.push(...renderTechnical(detail));

  // Collapse the blank lines the section helpers leave behind, so the result
  // reads as hand-written Markdown rather than as generated output.
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}
