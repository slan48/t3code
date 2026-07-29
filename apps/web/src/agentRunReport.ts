import type {
  AgentRunCheck,
  AgentRunCycle,
  AgentRunDetail,
  AgentRunReview,
  AgentRunTimelineEntry,
} from "@t3tools/contracts";
import { agentRunStateLabel } from "@t3tools/contracts";

import {
  describeAgentsRunning,
  describeGuidance,
  formatExecutionBudget,
} from "./agentRunAttention";
import { describeProcess, elapsedMillis, formatDuration, phaseStatusLabel } from "./agentRunFormat";
import {
  describeReportOutcome,
  groupValidationByPhase,
  notableValidationFailures,
  VALIDATION_STAGE_LABELS,
} from "./agentRunValidation";

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
  const phases = groupValidationByPhase(cycle).filter((phase) => phase.stage !== "final");
  if (phases.length === 0) return [];

  const lines: string[] = ["#### Validation", ""];
  for (const phase of phases) {
    lines.push(
      `**${VALIDATION_STAGE_LABELS[phase.stage]}** — ${describePassed(phase.latest.passed)} (${describeReportOutcome(phase.latest)})`,
      "",
    );
    for (const check of phase.latest.checks) lines.push(...renderCheck(check));

    // The history is counted, not reprinted. An evidence recovery reran this
    // phase seven times in the real run; three identical copies of the same
    // nine green checks is not information, it is padding that pushes the
    // reviewer's actual verdict off the reader's first screen.
    if (phase.previous.length > 0) {
      lines.push(
        "",
        `_${phase.previous.length} earlier run${phase.previous.length === 1 ? "" : "s"} of this phase${
          phase.hasEarlierFailure
            ? ", including a failure — see Notable earlier events"
            : ", all superseded"
        }._`,
      );
    }
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
    ...field("Worker attempts", `${summary.executions.worker.attempts}`),
    ...field("Worker provider executions", formatExecutionBudget(summary.executions.worker)),
    ...field("Reviewer attempts", `${summary.executions.reviewer.attempts}`),
    ...field("Reviewer provider executions", formatExecutionBudget(summary.executions.reviewer)),
    ...field(
      "Base authorization",
      `worker ${detail.limits.maxWorkerExecutions ?? "—"}, reviewer ${detail.limits.maxReviewerExecutions ?? "—"}`,
    ),
    ...field("Attention kind", summary.attention.kind),
    ...field("Last durable event seq", `${summary.lastEventSeq}`),
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

/* ------------------------------------------------------------- at a glance */

/**
 * The answer, before the evidence.
 *
 * A reader pasting this into a chat wants the verdict in the first screen:
 * did it finish, how much authorization did it spend, did the gates pass. Each
 * line is the canonical projection, not a recount — in particular the
 * executions are provider executions against the effective limit, never
 * allocated attempts against the base one.
 */
function renderAtAGlance(detail: AgentRunDetail): readonly string[] {
  const { summary } = detail;
  const guidance = describeGuidance(summary);

  const latest = (stage: "post_worker" | "pre_review") => {
    for (let index = detail.cycles.length - 1; index >= 0; index -= 1) {
      const cycle = detail.cycles[index];
      if (cycle === undefined) continue;
      const phase = groupValidationByPhase(cycle).find((entry) => entry.stage === stage);
      if (phase !== undefined) {
        return `${describePassed(phase.latest.passed).toUpperCase()} (${describeReportOutcome(phase.latest)}, cycle ${cycle.number})`;
      }
    }
    return null;
  };

  const lastReview = detail.cycles.toReversed().find((cycle) => cycle.review !== null)?.review;
  const lastGate = detail.cycles.toReversed().find((cycle) => cycle.finalGate !== null)?.finalGate;

  return [
    "## At a glance",
    "",
    ...field("Worker provider executions", formatExecutionBudget(summary.executions.worker)),
    ...field("Reviewer provider executions", formatExecutionBudget(summary.executions.reviewer)),
    ...field("Latest post-worker validation", latest("post_worker")),
    ...field("Latest pre-review evidence", latest("pre_review")),
    ...field("Reviewer final verdict", lastReview?.verdict ?? null),
    ...field(
      "Final validation",
      lastGate === undefined || lastGate === null
        ? null
        : `${lastGate.passed ? "PASS" : "FAIL"}, ${
            lastGate.checksRun.length - lastGate.failures.length
          } / ${lastGate.checksRun.length}`,
    ),
    ...field("Attention", `${summary.attention.kind} — ${guidance.headline}`),
    ...field("Agents", describeAgentsRunning(detail)),
    "",
  ];
}

/* --------------------------------------------------- notable earlier events */

/**
 * The story behind a run that did not go straight through.
 *
 * Without this, a report of the accepted run reads as though everything passed
 * first time — the escalation, the unusable review, the refused attempt and the
 * recovery all vanish into a green summary. Each line is derived from a durable
 * fact: a recorded verdict, a failed validation report, or an attempt that was
 * allocated and never spent.
 */
function renderNotableEvents(detail: AgentRunDetail): readonly string[] {
  const notes: string[] = [];

  for (const cycle of detail.cycles) {
    if (cycle.review !== null && cycle.review.verdict !== "OBJECTIVE_DONE") {
      notes.push(
        `Cycle ${cycle.number}: reviewer returned ${cycle.review.verdict}${
          cycle.review.blockingReason === null ? "" : ` — ${collapse(cycle.review.blockingReason)}`
        }`,
      );
    }
  }

  for (const failure of notableValidationFailures(detail)) {
    notes.push(
      `Cycle ${failure.cycle}: ${VALIDATION_STAGE_LABELS[failure.stage]} failed${
        failure.failedCheckIds.length === 0 ? "" : ` (${failure.failedCheckIds.join(", ")})`
      }${failure.supersededByPass ? ", later rerun and passed" : ""}`,
    );
  }

  const reviewerGap =
    detail.summary.executions.reviewer.attempts -
    detail.summary.executions.reviewer.providerExecutions;
  if (reviewerGap > 0) {
    notes.push(
      `${reviewerGap} reviewer attempt${reviewerGap === 1 ? "" : "s"} refused before any process started (no provider execution spent)`,
    );
  }

  // Orchestrator-side recoveries, in the engine's own words. These are why a
  // finished run can hold a wider reviewer authorization than its Work Order
  // asked for, and a reader who does not see them will question the accounting.
  for (const recovery of detail.evidenceRecoveries) {
    const parts = ["Orchestrator recovery"];
    if (recovery.supersededReason !== null) parts.push(`superseded ${recovery.supersededReason}`);
    if (recovery.authorizedBy !== null) parts.push(`authorized by ${recovery.authorizedBy}`);
    if (recovery.additionalReviewerExecutions > 0) {
      parts.push(`+${recovery.additionalReviewerExecutions} reviewer execution`);
    }
    notes.push(
      `${parts.join(" · ")}${recovery.note === null ? "" : ` — ${collapse(recovery.note)}`}`,
    );
  }

  const base = detail.limits.maxReviewerExecutions;
  const effective = detail.summary.executions.reviewer.effectiveLimit;
  if (base !== null && effective !== null && effective > base) {
    notes.push(`Reviewer authorization widened from ${base} to ${effective} by durable grant`);
  }

  if (detail.interruptions > 0 || detail.resumes > 0) {
    notes.push(`Run was interrupted ${detail.interruptions}× and resumed ${detail.resumes}×`);
  }

  if (notes.length === 0) return [];
  return ["## Notable earlier events", "", ...notes.map((note) => `- ${note}`), ""];
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
    ...renderAtAGlance(detail),
    ...section("Objective", detail.objective),
    ...renderHumanRequired(detail),
    ...renderNotableEvents(detail),
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
