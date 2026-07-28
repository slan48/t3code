/**
 * Turning orchestrator artifacts into an operator's answer.
 *
 * Pure functions only — every input is passed in, nothing is read here. That
 * is what makes the interesting cases (a dead process still claiming
 * `WORKER_RUNNING`, a historical run with no decision packet, a validation
 * artifact that will not parse) testable without staging a filesystem.
 *
 * The governing rule is that the UI must be able to answer six questions in
 * three seconds — is it working, who, is it progressing, did it finish, does
 * it need me, what does it need — and must never answer any of them with a
 * number it made up. Where evidence is missing the projection says `null` and
 * lets the surface say "unknown".
 *
 * @module AgentRunsProjection
 */
import type {
  AgentRunActivity,
  AgentRunActiveRole,
  AgentRunCheck,
  AgentRunCycle,
  AgentRunDetail,
  AgentRunExecution,
  AgentRunHumanRequired,
  AgentRunPhaseStatus,
  AgentRunProcess,
  AgentRunReview,
  AgentRunState,
  AgentRunSummary,
  AgentRunTimelineEntry,
  AgentRunValidationReport,
  AgentRunValidationStage,
  AgentRunWorkspace,
} from "@t3tools/contracts";
import { AGENT_RUN_STATES, isAgentRunTerminal, needsAgentRunAttention } from "@t3tools/contracts";

import {
  deriveJournalStatus,
  failureTail,
  type OrchestratorCheckResult,
  type OrchestratorCycle,
  type OrchestratorEvent,
  type OrchestratorJournalEntry,
  type OrchestratorLockRecord,
  type OrchestratorRunRecord,
  type OrchestratorValidationReport,
  type OrchestratorWorkOrder,
} from "./Artifacts.ts";

/* ------------------------------------------------------------------ input */

/** One attempt directory, already read. */
export interface AttemptEvidence {
  readonly cycle: number;
  readonly attemptId: string;
  readonly entries: readonly OrchestratorJournalEntry[];
  /** Newest mtime across the attempt's captured streams, if any exist. */
  readonly streamWriteAt: string | null;
  /** Total bytes captured, if the streams could be stat'd. */
  readonly streamBytes: number | null;
}

export interface ValidationEvidence {
  readonly cycle: number;
  readonly stage: AgentRunValidationStage;
  readonly report: OrchestratorValidationReport;
  /** File mtime, used when the report itself carries no timestamp. */
  readonly writtenAt: string | null;
}

/** What a liveness probe was able to establish about the lock's owner. */
export interface LivenessEvidence {
  readonly sameHost: boolean;
  /** Null when liveness cannot be established (other host, other boot). */
  readonly alive: boolean | null;
  readonly detached: boolean | null;
}

export interface WorkspaceProbe {
  readonly filesChanged: number;
  readonly at: string;
}

export interface RunEvidence {
  readonly run: OrchestratorRunRecord;
  readonly workOrder: OrchestratorWorkOrder | null;
  readonly events: readonly OrchestratorEvent[];
  readonly attempts: readonly AttemptEvidence[];
  readonly validation: readonly ValidationEvidence[];
  readonly lock: OrchestratorLockRecord | null;
  readonly liveness: LivenessEvidence;
  readonly workspaceProbe: WorkspaceProbe | null;
  /** Non-fatal gaps in the evidence, reported rather than hidden. */
  readonly degraded: readonly string[];
}

/* ---------------------------------------------------------------- states */

const IN_FLIGHT_STATES = new Set<AgentRunState>(["WORKER_RUNNING", "REVIEWER_RUNNING"]);

/**
 * Map a persisted state string onto the state machine this build knows.
 *
 * An unrecognised state is not silently coerced — the caller reports the run
 * as unreadable, which is honest, instead of inventing a phase for it.
 */
export function parseRunState(value: string): AgentRunState | null {
  return (AGENT_RUN_STATES as readonly string[]).includes(value) ? (value as AgentRunState) : null;
}

export function activeRoleFor(state: AgentRunState): AgentRunActiveRole {
  switch (state) {
    case "WORKER_RUNNING":
      return "worker";
    case "REVIEWER_RUNNING":
      return "reviewer";
    /**
     * The gap between a finished worker and a started reviewer is not idle
     * time: it is where the deterministic checks run. Naming it `validation`
     * is what stops the UI from showing a blank phase for the minute the
     * gate takes.
     */
    case "AWAITING_REVIEW":
      return "validation";
    case "FINAL_VALIDATION":
      return "final_validation";
    default:
      return "none";
  }
}

/* --------------------------------------------------------------- process */

/**
 * What can honestly be said about the process behind this run.
 *
 * The `inconsistent` flag is the whole point of the exercise: a run whose
 * snapshot says `WORKER_RUNNING` while its owner is provably gone is the exact
 * failure that previously required a terminal to notice.
 */
export function projectProcess(evidence: RunEvidence, state: AgentRunState): AgentRunProcess {
  const { lock, liveness } = evidence;
  const terminal = isAgentRunTerminal(state);
  const claimsInFlight = IN_FLIGHT_STATES.has(state);

  if (lock === null) {
    return {
      lockHeld: false,
      pid: null,
      hostname: null,
      lockState: null,
      acquiredAt: null,
      sameHost: false,
      alive: null,
      detached: null,
      // No lock while an agent is supposedly in flight means the owner is gone.
      inconsistent: claimsInFlight && !terminal,
    };
  }

  return {
    lockHeld: true,
    pid: lock.pid,
    hostname: lock.hostname,
    lockState: lock.state,
    acquiredAt: lock.acquiredAt,
    sameHost: liveness.sameHost,
    alive: liveness.alive,
    detached: liveness.detached,
    inconsistent: claimsInFlight && !terminal && liveness.alive === false,
  };
}

/* -------------------------------------------------------------- activity */

function maxIso(values: readonly (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const value of values) {
    if (value === null || value === undefined || value.length === 0) continue;
    if (best === null || value > best) best = value;
  }
  return best;
}

/**
 * The newest durable evidence that this run moved, and what produced it.
 *
 * Ordered by how much a source proves. A stream write means the agent emitted
 * bytes; a journal entry means it crossed a lifecycle boundary; a run-snapshot
 * timestamp means only that something was persisted. Naming the source is not
 * decoration — "last activity 34s ago" is worth knowing only alongside what
 * kind of activity it was.
 */
export function projectActivity(evidence: RunEvidence, state: AgentRunState): AgentRunActivity {
  const { run, events, attempts, workspaceProbe } = evidence;

  const lastEventAt = maxIso(events.map((event) => event.at));
  const lastJournalAt = maxIso(
    attempts.flatMap((attempt) => attempt.entries.map((entry) => entry.at)),
  );
  const lastStreamWriteAt = maxIso(attempts.map((attempt) => attempt.streamWriteAt));

  const streamBytes = attempts.reduce<number | null>((total, attempt) => {
    if (attempt.streamBytes === null) return total;
    return (total ?? 0) + attempt.streamBytes;
  }, null);

  const lastActivityAt = maxIso([lastStreamWriteAt, lastJournalAt, lastEventAt, run.updatedAt]);
  const lastActivitySource: AgentRunActivity["lastActivitySource"] =
    lastActivityAt === null
      ? null
      : lastActivityAt === lastStreamWriteAt
        ? "attempt-stream"
        : lastActivityAt === lastJournalAt
          ? "attempt-journal"
          : lastActivityAt === lastEventAt
            ? "event"
            : "run-snapshot";

  const recorded = recordedChangedFiles(run, state);
  const files =
    workspaceProbe !== null
      ? {
          filesChanged: workspaceProbe.filesChanged,
          filesChangedAt: workspaceProbe.at,
          filesChangedSource: "workspace-probe" as const,
        }
      : recorded !== null
        ? {
            filesChanged: recorded.count,
            filesChangedAt: recorded.at,
            filesChangedSource: "run-record" as const,
          }
        : { filesChanged: null, filesChangedAt: null, filesChangedSource: null };

  return {
    lastActivityAt,
    lastActivitySource,
    lastStreamWriteAt,
    streamBytes,
    ...files,
  };
}

function recordedChangedFiles(
  run: OrchestratorRunRecord,
  _state: AgentRunState,
): { count: number; at: string } | null {
  const cycles = run.cycles ?? [];
  for (let index = cycles.length - 1; index >= 0; index -= 1) {
    const cycle = cycles[index];
    if (cycle?.changedFiles === undefined) continue;
    return {
      count: cycle.changedFiles.length,
      at: cycle.finishedAt ?? cycle.startedAt,
    };
  }
  return null;
}

/* --------------------------------------------------------- human required */

/**
 * Why the run stopped, and what it is asking of a human.
 *
 * A purpose-built packet is used verbatim when one exists. Otherwise the
 * fields are assembled from the reviewer's own words and the run's outcome and
 * marked `derived`, so the surface can say "open the evidence" rather than
 * pretending a decision request was authored. Options are never invented: if
 * no reviewer offered any, the list is empty.
 */
export function projectHumanRequired(
  evidence: RunEvidence,
  state: AgentRunState,
): AgentRunHumanRequired {
  const { run } = evidence;
  const packet = run.humanRequired;

  if (packet !== undefined) {
    return {
      present: true,
      source: "packet",
      reasonCode: packet.reasonCode,
      summary: packet.summary,
      decisionNeeded: packet.decisionNeeded,
      options: packet.options ?? [],
      evidence: packet.evidenceRefs ?? [],
      createdAt: packet.createdAt,
    };
  }

  if (state === "RECOVERY_REQUIRED" && run.recovery !== undefined) {
    return {
      present: true,
      source: "derived",
      reasonCode: "RECOVERY_REQUIRED",
      summary: run.recovery.reason,
      decisionNeeded:
        `Decide whether attempt ${run.recovery.attemptId} (cycle ${run.recovery.cycle}) ` +
        "may be retried or must be abandoned.",
      options: [],
      evidence: [],
      createdAt: run.recovery.detectedAt,
    };
  }

  if (!needsAgentRunAttention(state)) {
    return {
      present: false,
      source: "none",
      reasonCode: null,
      summary: null,
      decisionNeeded: null,
      options: [],
      evidence: [],
      createdAt: null,
    };
  }

  const outcome = run.outcome;
  const review = lastReview(run);
  return {
    present: true,
    source: "derived",
    reasonCode: outcome?.reason ?? state,
    summary: outcome?.message ?? review?.summary ?? null,
    // Never fabricated. A historical run that recorded no decision request
    // gets a null here and the surface tells the operator to open the evidence.
    decisionNeeded: review?.blockingReason ?? null,
    options: [],
    evidence: review?.evidence ?? [],
    createdAt: outcome?.at ?? run.finishedAt ?? null,
  };
}

function lastReview(run: OrchestratorRunRecord) {
  const cycles = run.cycles ?? [];
  for (let index = cycles.length - 1; index >= 0; index -= 1) {
    const review = cycles[index]?.review;
    if (review !== undefined) return review;
  }
  return undefined;
}

/* --------------------------------------------------------------- summary */

export function projectSummary(evidence: RunEvidence, state: AgentRunState): AgentRunSummary {
  const { run, workOrder } = evidence;
  const cycles = run.cycles ?? [];
  const executions = cycles.flatMap((cycle) => cycle.executions ?? []);

  return {
    id: run.id,
    project: run.project,
    title: deriveTitle(workOrder, run.workOrderId),
    workOrderId: run.workOrderId,
    state,
    terminal: isAgentRunTerminal(state),
    attentionRequired: needsAgentRunAttention(state),
    currentCycle: cycles.length,
    maxCycles: Math.max(1, Math.trunc(run.maxCycles)),
    activeRole: isAgentRunTerminal(state) ? "none" : activeRoleFor(state),
    startedAt: run.createdAt,
    updatedAt: run.updatedAt,
    finishedAt: run.finishedAt ?? null,
    workerExecutionCount: executions.filter((entry) => entry.role === "worker").length,
    reviewerExecutionCount: executions.filter((entry) => entry.role === "reviewer").length,
    terminalReason: run.outcome?.reason ?? null,
    humanRequired: projectHumanRequired(evidence, state),
    process: projectProcess(evidence, state),
    activity: projectActivity(evidence, state),
  };
}

/** How long a derived title may run before it stops being scannable. */
const MAX_TITLE_CHARS = 110;

/**
 * A name short enough to read in a list.
 *
 * Real work orders carry no title and a multi-paragraph `objective`, so the
 * opening paragraph is used, unwrapped and bounded. Rendering the whole
 * objective as a title is what turns a run list into a wall of prose — the
 * full text is still carried on the detail, where it belongs.
 */
export function deriveTitle(workOrder: OrchestratorWorkOrder | null, workOrderId: string): string {
  const explicit = workOrder?.title?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;

  const objective = workOrder?.objective?.trim();
  if (objective === undefined || objective.length === 0) return workOrderId;

  // Hard-wrapped prose: the first blank line ends the opening statement, and
  // single newlines inside it are wrapping, not structure.
  const firstParagraph =
    objective
      .split(/\n\s*\n/)[0]
      ?.replace(/\s+/g, " ")
      .trim() ?? "";
  if (firstParagraph.length === 0) return workOrderId;
  return firstParagraph.length <= MAX_TITLE_CHARS
    ? firstParagraph
    : `${firstParagraph.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`;
}

/* ---------------------------------------------------------------- phases */

function verdictPhaseStatus(verdict: string): AgentRunPhaseStatus {
  switch (verdict) {
    case "OBJECTIVE_DONE":
      return "passed";
    case "REWORK":
      return "rework";
    case "ESCALATE":
      return "escalated";
    default:
      return "unknown";
  }
}

function workerPhaseStatus(
  cycle: OrchestratorCycle,
  isLast: boolean,
  state: AgentRunState,
): AgentRunPhaseStatus {
  const workers = (cycle.executions ?? []).filter((entry) => entry.role === "worker");
  if (workers.some((entry) => entry.status === "OK")) return "passed";
  if (isLast && state === "WORKER_RUNNING") return "running";
  if (workers.length === 0) return "pending";
  return "failed";
}

function reviewerPhaseStatus(
  cycle: OrchestratorCycle,
  isLast: boolean,
  state: AgentRunState,
): AgentRunPhaseStatus {
  if (cycle.review !== undefined) return verdictPhaseStatus(cycle.review.verdict);
  if (isLast && state === "REVIEWER_RUNNING") return "running";
  const reviewers = (cycle.executions ?? []).filter((entry) => entry.role === "reviewer");
  if (reviewers.length > 0) return "failed";
  return "pending";
}

function validationPhaseStatus(
  reports: readonly AgentRunValidationReport[],
  isLast: boolean,
  state: AgentRunState,
): AgentRunPhaseStatus {
  const postWorker = reports.filter((report) => report.stage === "post_worker");
  if (postWorker.length > 0) {
    return postWorker.every((report) => report.passed === true) ? "passed" : "failed";
  }
  if (isLast && state === "AWAITING_REVIEW") return "running";
  return "pending";
}

function finalValidationPhaseStatus(
  cycle: OrchestratorCycle,
  isLast: boolean,
  state: AgentRunState,
): AgentRunPhaseStatus {
  if (cycle.finalGate !== undefined) return cycle.finalGate.passed ? "passed" : "failed";
  if (isLast && state === "FINAL_VALIDATION") return "running";
  // The gate only ever runs behind an approving reviewer; anything else never
  // reaches it, and calling that "pending" would imply a step still to come.
  if (cycle.review !== undefined && cycle.review.verdict !== "OBJECTIVE_DONE") return "skipped";
  return "pending";
}

/* ------------------------------------------------------------ validation */

export function projectCheck(check: OrchestratorCheckResult): AgentRunCheck {
  return {
    id: check.id,
    name: check.name ?? check.id,
    outcome: check.outcome ?? (check.passed === true ? "PASSED" : "UNKNOWN"),
    passed: check.passed ?? null,
    durationMs: check.durationMs ?? null,
    exitCode: check.exitCode ?? null,
    failureDetail: failureTail(check),
  };
}

function projectValidationReport(evidence: ValidationEvidence): AgentRunValidationReport {
  const checks = (evidence.report.checks ?? []).map(projectCheck);
  return {
    stage: evidence.stage,
    cycle: evidence.cycle,
    ranAt: evidence.report.checks?.[0]?.startedAt ?? evidence.writtenAt,
    passed: checks.length === 0 ? null : checks.every((check) => check.passed === true),
    checks,
  };
}

/* ---------------------------------------------------------------- cycles */

function projectExecution(
  execution: OrchestratorCycle["executions"] extends undefined
    ? never
    : NonNullable<OrchestratorCycle["executions"]>[number],
): AgentRunExecution {
  return {
    role: execution.role,
    agentId: execution.agentId,
    attempt: Math.max(1, Math.trunc(execution.attempt)),
    attemptId: execution.attemptId ?? null,
    status: execution.status,
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt,
    durationMs: Math.max(0, Math.trunc(execution.durationMs)),
    exitCode: execution.exitCode ?? null,
    pid: execution.pid ?? null,
    issues: execution.issues ?? [],
  };
}

function projectReview(cycle: OrchestratorCycle): AgentRunReview | null {
  if (cycle.review === undefined) return null;
  return {
    cycle: cycle.number,
    verdict: cycle.review.verdict,
    summary: cycle.review.summary ?? "",
    requiredChanges: cycle.review.requiredChanges ?? [],
    blockingReason: cycle.review.blockingReason ?? null,
    evidence: cycle.review.evidence ?? [],
  };
}

export function projectCycles(
  evidence: RunEvidence,
  state: AgentRunState,
): readonly AgentRunCycle[] {
  const cycles = evidence.run.cycles ?? [];
  return cycles.map((cycle, index) => {
    const isLast = index === cycles.length - 1;
    const validation = evidence.validation
      .filter((entry) => entry.cycle === cycle.number)
      .map(projectValidationReport);

    return {
      number: cycle.number,
      startedAt: cycle.startedAt,
      finishedAt: cycle.finishedAt ?? null,
      workerStatus: workerPhaseStatus(cycle, isLast, state),
      validationStatus: validationPhaseStatus(validation, isLast, state),
      reviewerStatus: reviewerPhaseStatus(cycle, isLast, state),
      finalValidationStatus: finalValidationPhaseStatus(cycle, isLast, state),
      workerSummary: cycle.workerSummary ?? null,
      changedFiles: cycle.changedFiles ?? [],
      executions: (cycle.executions ?? []).map(projectExecution),
      review: projectReview(cycle),
      validation,
      finalGate:
        cycle.finalGate === undefined
          ? null
          : {
              cycle: cycle.number,
              ranAt: cycle.finalGate.ranAt,
              passed: cycle.finalGate.passed,
              checksRun: cycle.finalGate.checksRun ?? [],
              failures: (cycle.finalGate.failures ?? []).map((failure) => ({
                id: failure.id,
                name: failure.name ?? failure.id,
                outcome: failure.outcome ?? "FAILED",
                passed: false,
                durationMs: null,
                exitCode: failure.exitCode ?? null,
                failureDetail: failureDetailFromGate(failure.detail, failure.tail),
              })),
            },
    };
  });
}

function failureDetailFromGate(detail: string | null | undefined, tail: string | undefined) {
  const raw = [detail ?? "", tail ?? ""].join("\n").trim();
  if (raw.length === 0) return null;
  return failureTail({ id: "gate", passed: false, stdout: raw });
}

/* -------------------------------------------------------------- timeline */

const EVENT_TITLES: Readonly<
  Record<string, { title: string; tone: AgentRunTimelineEntry["tone"] }>
> = {
  WORKER_STARTED: { title: "Claude started", tone: "running" },
  WORKER_SUCCEEDED: { title: "Worker completed", tone: "success" },
  WORKER_FAILED: { title: "Worker failed", tone: "failure" },
  REVIEWER_STARTED: { title: "Codex review started", tone: "running" },
  REVIEW_REWORK: { title: "Codex requested rework", tone: "attention" },
  REVIEW_ESCALATE: { title: "Codex escalated", tone: "attention" },
  REVIEW_OBJECTIVE_DONE: { title: "Codex approved", tone: "success" },
  FINAL_VALIDATION_STARTED: { title: "Final validation started", tone: "running" },
  FINAL_VALIDATION_PASSED: { title: "Final validation passed", tone: "success" },
  FINAL_VALIDATION_FAILED: { title: "Final validation failed", tone: "failure" },
  RUN_COMPLETED: { title: "Run completed", tone: "success" },
  RUN_FAILED: { title: "Run failed", tone: "failure" },
  RECOVERY_REQUIRED: { title: "Recovery required", tone: "attention" },
};

function eventKind(type: string): AgentRunTimelineEntry["kind"] {
  if (type.startsWith("WORKER")) return "worker";
  if (type.startsWith("REVIEW")) return "reviewer";
  if (type.startsWith("FINAL_VALIDATION")) return "final_gate";
  if (type.startsWith("RECOVERY")) return "recovery";
  return "run";
}

/**
 * The run's history, assembled from what was written down.
 *
 * Four independent sources are merged and sorted by their own timestamps: run
 * events, attempt journals, validation artifacts, and reviewer verdicts. No
 * entry is interpolated to fill a gap — a quiet stretch in the timeline is a
 * real quiet stretch, and that is information.
 */
export function projectTimeline(
  evidence: RunEvidence,
  cycles: readonly AgentRunCycle[],
): readonly AgentRunTimelineEntry[] {
  const entries: AgentRunTimelineEntry[] = [];

  for (const event of evidence.events) {
    const known = EVENT_TITLES[event.type];
    entries.push({
      at: event.at,
      kind: eventKind(event.type),
      title: known?.title ?? humanizeToken(event.type),
      detail: truncate(event.detail ?? null, 240),
      cycle: event.cycle ?? null,
      tone: known?.tone ?? "neutral",
      source: "events",
    });
  }

  for (const cycle of cycles) {
    if (cycle.changedFiles.length > 0 && cycle.finishedAt !== null) {
      entries.push({
        at: cycle.finishedAt,
        kind: "files",
        title: `${cycle.changedFiles.length} file${cycle.changedFiles.length === 1 ? "" : "s"} changed`,
        detail: truncate(cycle.changedFiles.slice(0, 8).join(", "), 240),
        cycle: cycle.number,
        tone: "neutral",
        source: "run-record",
      });
    }

    for (const report of cycle.validation) {
      for (const check of report.checks) {
        // A check with no clock cannot be placed on a timeline; it still shows
        // up in the validation panel, which is not time-ordered.
        const at = report.ranAt;
        if (at === null) continue;
        entries.push({
          at,
          kind: "validation",
          title: `${check.name} ${check.passed === true ? "passed" : check.outcome.toLowerCase()}`,
          detail: check.durationMs === null ? null : `${Math.round(check.durationMs / 100) / 10}s`,
          cycle: report.cycle,
          tone: check.passed === true ? "success" : "failure",
          source: "validation",
        });
      }
    }

    if (cycle.review !== null) {
      const finished = lastReviewerFinishedAt(cycle);
      // The events log already records the verdict as a transition. Adding a
      // second row from the reviewer artifact would put the same fact on the
      // timeline twice — the verdict's full text lives in the review panel,
      // which is where an operator reads it anyway.
      const eventCoversVerdict = evidence.events.some(
        (event) => event.type.startsWith("REVIEW") && (event.cycle ?? null) === cycle.number,
      );
      if (finished !== null && !eventCoversVerdict) {
        const changes = cycle.review.requiredChanges.length;
        entries.push({
          at: finished,
          kind: "reviewer",
          title: `${cycle.review.verdict}${changes > 0 ? ` — ${changes} change${changes === 1 ? "" : "s"}` : ""}`,
          detail: truncate(cycle.review.summary, 240),
          cycle: cycle.number,
          tone: cycle.review.verdict === "OBJECTIVE_DONE" ? "success" : "attention",
          source: "reviewer",
        });
      }
    }
  }

  for (const attempt of evidence.attempts) {
    for (const entry of attempt.entries) {
      if (entry.phase !== "SPAWNED" && entry.phase !== "CHILD_EXITED") continue;
      entries.push({
        at: entry.at,
        kind: attempt.attemptId.startsWith("worker") ? "worker" : "reviewer",
        title:
          entry.phase === "SPAWNED"
            ? `${attempt.attemptId} process started`
            : `${attempt.attemptId} process exited`,
        detail: entry.phase === "CHILD_EXITED" ? `exit ${entry.exitCode ?? "?"}` : null,
        cycle: attempt.cycle,
        tone: "neutral",
        source: "attempt-journal",
      });
    }
  }

  return entries.sort((left, right) =>
    left.at === right.at ? left.title.localeCompare(right.title) : left.at.localeCompare(right.at),
  );
}

function lastReviewerFinishedAt(cycle: AgentRunCycle): string | null {
  const reviewers = cycle.executions.filter((entry) => entry.role === "reviewer");
  return reviewers.at(-1)?.finishedAt ?? cycle.finishedAt;
}

function humanizeToken(token: string): string {
  const lower = token.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function truncate(value: string | null, max: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/* ---------------------------------------------------------------- detail */

export function projectWorkspace(run: OrchestratorRunRecord): AgentRunWorkspace {
  const workspace = run.workspace;
  return {
    strategy: workspace?.strategy ?? null,
    branch: workspace?.branchName ?? null,
    baseSha: workspace?.baseCommitSha ?? null,
    worktreePath: workspace?.worktreePath ?? null,
    repositoryPath: run.repositoryPath ?? null,
  };
}

export function projectDetail(evidence: RunEvidence, state: AgentRunState): AgentRunDetail {
  const cycles = projectCycles(evidence, state);
  return {
    summary: projectSummary(evidence, state),
    objective: evidence.workOrder?.objective?.trim() ?? null,
    workspace: projectWorkspace(evidence.run),
    cycles,
    timeline: projectTimeline(evidence, cycles),
    agents: {
      worker: evidence.run.agents?.worker ?? "unknown",
      reviewer: evidence.run.agents?.reviewer ?? "unknown",
    },
    limits: {
      maxWorkerExecutions: evidence.run.limits?.maxWorkerExecutions ?? null,
      maxReviewerExecutions: evidence.run.limits?.maxReviewerExecutions ?? null,
    },
    interruptions: evidence.run.interruptions ?? 0,
    resumes: evidence.run.resumes ?? 0,
    degraded: [...evidence.degraded],
  };
}

/**
 * The journal-derived status of the attempt currently in flight, if any.
 *
 * Exported because the detail surface pairs it with process liveness: journal
 * says `AMBIGUOUS`, process says alive, therefore *running* — and journal says
 * `AMBIGUOUS`, process says gone, therefore *lost*.
 */
export function activeAttemptStatus(evidence: RunEvidence): string | null {
  const latest = evidence.attempts.at(-1);
  return latest === undefined ? null : deriveJournalStatus(latest.entries);
}
