/**
 * Agent Runs - the operator-facing view of an external `agent-orchestrator`.
 *
 * T3Code *observes* the orchestrator; it never owns its lifecycle. Everything
 * in this module is therefore read-only and derived from durable evidence the
 * orchestrator has already written to disk. Nothing here is a projection of
 * what an agent might be thinking: a field is either backed by a persisted
 * fact or it is `null`.
 *
 * The vocabulary deliberately mirrors the orchestrator's own state machine
 * rather than inventing a parallel one — an operator who reads `HUMAN_REQUIRED`
 * in T3Code and `HUMAN_REQUIRED` in a terminal must be looking at one fact.
 *
 * @module AgentRuns
 */
import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/* ----------------------------------------------------------------- states */

/**
 * The orchestrator's run states, verbatim.
 *
 * Kept as a literal union so a state this build has never heard of fails
 * validation loudly at the boundary instead of rendering as a blank badge.
 */
export const AGENT_RUN_STATES = [
  "CREATED",
  "WORKER_RUNNING",
  "AWAITING_REVIEW",
  "REVIEWER_RUNNING",
  "REWORK_REQUESTED",
  "FINAL_VALIDATION",
  "INTERRUPTED",
  "RECOVERY_REQUIRED",
  "COMPLETED",
  "HUMAN_REQUIRED",
  "FAILED",
  "MAX_CYCLES_REACHED",
  "TIMED_OUT",
] as const;

export const AgentRunState = Schema.Literals(AGENT_RUN_STATES);
export type AgentRunState = typeof AgentRunState.Type;

/** States from which the orchestrator will not move on its own. */
export const AGENT_RUN_TERMINAL_STATES = [
  "COMPLETED",
  "HUMAN_REQUIRED",
  "FAILED",
  "MAX_CYCLES_REACHED",
  "TIMED_OUT",
] as const satisfies readonly AgentRunState[];

/**
 * Terminal states that mean "a human has to look at this".
 *
 * `COMPLETED` is terminal but not attention-worthy in the same way, which is
 * why the badge and the alert treat these separately.
 */
export const AGENT_RUN_ATTENTION_STATES = [
  "HUMAN_REQUIRED",
  "RECOVERY_REQUIRED",
  "FAILED",
  "MAX_CYCLES_REACHED",
  "TIMED_OUT",
] as const satisfies readonly AgentRunState[];

export function isAgentRunTerminal(state: AgentRunState): boolean {
  return (AGENT_RUN_TERMINAL_STATES as readonly AgentRunState[]).includes(state);
}

export function needsAgentRunAttention(state: AgentRunState): boolean {
  return (AGENT_RUN_ATTENTION_STATES as readonly AgentRunState[]).includes(state);
}

/**
 * Operator phrasing for a state.
 *
 * Presentation only — the raw state travels alongside it so technical details
 * never have to be reverse-engineered from a label.
 */
export function agentRunStateLabel(state: AgentRunState): string {
  switch (state) {
    case "CREATED":
      return "Preparing";
    case "WORKER_RUNNING":
      return "Claude working";
    case "AWAITING_REVIEW":
      return "Awaiting review";
    case "REVIEWER_RUNNING":
      return "Codex reviewing";
    case "REWORK_REQUESTED":
      return "Rework queued";
    case "FINAL_VALIDATION":
      return "Final validation";
    case "INTERRUPTED":
      return "Interrupted";
    case "RECOVERY_REQUIRED":
      return "Recovery required";
    case "COMPLETED":
      return "Completed";
    case "HUMAN_REQUIRED":
      return "Human required";
    case "FAILED":
      return "Failed";
    case "MAX_CYCLES_REACHED":
      return "Needs review";
    case "TIMED_OUT":
      return "Timed out";
  }
}

export type AgentRunTone = "running" | "success" | "attention" | "failure" | "idle";

export function agentRunStateTone(state: AgentRunState): AgentRunTone {
  switch (state) {
    case "WORKER_RUNNING":
    case "REVIEWER_RUNNING":
    case "FINAL_VALIDATION":
      return "running";
    case "COMPLETED":
      return "success";
    case "HUMAN_REQUIRED":
    case "RECOVERY_REQUIRED":
    case "MAX_CYCLES_REACHED":
      return "attention";
    case "FAILED":
    case "TIMED_OUT":
      return "failure";
    case "CREATED":
    case "AWAITING_REVIEW":
    case "REWORK_REQUESTED":
    case "INTERRUPTED":
      return "idle";
  }
}

/* ------------------------------------------------------------------ roles */

/** Who, if anyone, the run is currently waiting on. */
export const AgentRunActiveRole = Schema.Literals([
  "worker",
  "reviewer",
  "validation",
  "final_validation",
  "none",
]);
export type AgentRunActiveRole = typeof AgentRunActiveRole.Type;

/** Per-phase status shown in the run detail's phase stack. */
export const AgentRunPhaseStatus = Schema.Literals([
  "pending",
  "running",
  "passed",
  "failed",
  "escalated",
  "rework",
  "skipped",
  "unknown",
]);
export type AgentRunPhaseStatus = typeof AgentRunPhaseStatus.Type;

/* --------------------------------------------------------------- liveness */

/**
 * What can be said about the process that owns this run.
 *
 * `alive` is deliberately nullable: on another host a pid means nothing, and
 * claiming "not running" there would be a guess dressed as a fact. The UI
 * distinguishes *process alive* from *progress proven* and never conflates
 * the two.
 */
export const AgentRunProcess = Schema.Struct({
  /** True when a run lock file exists at all. */
  lockHeld: Schema.Boolean,
  pid: Schema.NullOr(PositiveInt),
  hostname: Schema.NullOr(Schema.String),
  /** The lock's coarse self-description, e.g. `WORKER_RUNNING`. Never secrets. */
  lockState: Schema.NullOr(Schema.String),
  acquiredAt: Schema.NullOr(IsoDateTime),
  /** Whether the lock was taken on the machine this server runs on. */
  sameHost: Schema.Boolean,
  /**
   * Liveness of `pid`, or null when it cannot be established (no lock, or a
   * lock from another host / another boot).
   */
  alive: Schema.NullOr(Schema.Boolean),
  /** A detached orchestrator leads its own process group. Informational. */
  detached: Schema.NullOr(Schema.Boolean),
  /**
   * Set when the persisted state claims an agent is in flight but the owning
   * process is provably gone. This is exactly the failure mode that used to be
   * invisible without a terminal.
   */
  inconsistent: Schema.Boolean,
});
export type AgentRunProcess = typeof AgentRunProcess.Type;

/**
 * Evidence that the run is *moving*, as opposed to merely being alive.
 *
 * Every field names the artifact it came from, because "last activity" is a
 * claim that is only worth as much as its source.
 */
export const AgentRunActivity = Schema.Struct({
  /** Newest durable evidence of any kind. */
  lastActivityAt: Schema.NullOr(IsoDateTime),
  /** What produced it: an event, a journal entry, or a stream write. */
  lastActivitySource: Schema.NullOr(
    Schema.Literals(["event", "attempt-journal", "attempt-stream", "run-snapshot"]),
  ),
  /** Newest mtime among the active attempt's captured streams. */
  lastStreamWriteAt: Schema.NullOr(IsoDateTime),
  /** Bytes captured so far from the active attempt's stdout, when readable. */
  streamBytes: Schema.NullOr(NonNegativeInt),
  /**
   * Files changed in the run's workspace.
   *
   * From the orchestrator's own record once a cycle has completed; from a
   * throttled read-only `git status` while a worker is still running. Null
   * when neither source can answer.
   */
  filesChanged: Schema.NullOr(NonNegativeInt),
  filesChangedAt: Schema.NullOr(IsoDateTime),
  filesChangedSource: Schema.NullOr(Schema.Literals(["run-record", "workspace-probe"])),
});
export type AgentRunActivity = typeof AgentRunActivity.Type;

/* ------------------------------------------------------------ human input */

/**
 * Why a run stopped for a human, and what decision is being asked for.
 *
 * `source` is the honesty valve. A `packet` was written by the orchestrator
 * for exactly this purpose. `derived` is assembled by T3Code from a reviewer
 * verdict and a run outcome that predate the packet — real facts, but not a
 * decision request anyone authored. Historical runs are never rewritten to
 * look like they had one.
 */
export const AgentRunHumanRequired = Schema.Struct({
  present: Schema.Boolean,
  source: Schema.Literals(["packet", "derived", "none"]),
  /** e.g. `ESCALATED`, `RECOVERY_REQUIRED`, `MAX_CYCLES_REACHED`. */
  reasonCode: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String),
  decisionNeeded: Schema.NullOr(Schema.String),
  /** Only ever what a reviewer actually offered. Never invented. */
  options: Schema.Array(Schema.String),
  evidence: Schema.Array(Schema.String),
  createdAt: Schema.NullOr(IsoDateTime),
});
export type AgentRunHumanRequired = typeof AgentRunHumanRequired.Type;

/* ------------------------------------------------------------------ runs */

/**
 * Provider executions against the effective authorization.
 *
 * `providerExecutions` counts attempts that reached the spawn boundary (or ran
 * in-process and produced a result). `attempts` counts every attempt the engine
 * allocated, including any refused before a process existed — those cost
 * nothing and must not be shown as agent runs. `effectiveLimit` is the Work
 * Order's ceiling plus any durable grants, which is why it can exceed the
 * number the run was originally authorized for.
 *
 * The orchestrator defines these semantics; see its
 * docs/UNATTENDED-RUN-INVARIANTS.md. This projection mirrors them and must not
 * invent a second rule.
 */
export const AgentRunExecutionBudget = Schema.Struct({
  providerExecutions: NonNegativeInt,
  attempts: NonNegativeInt,
  /** Null when the run was authorized without a ceiling. */
  effectiveLimit: Schema.NullOr(NonNegativeInt),
});
export type AgentRunExecutionBudget = typeof AgentRunExecutionBudget.Type;

/**
 * Why a run wants a human, classified rather than left to prose.
 *
 * A product decision and an orchestrator recovery both used to render as
 * "human input required", which tells an operator nothing about who has to do
 * what. `run-failed` is separate again: it may need investigation, but it is
 * not a decision anyone is blocking.
 */
export const AgentRunAttentionKind = Schema.Literals([
  "none",
  "product-decision",
  "orchestrator-recovery",
  "run-failed",
]);
export type AgentRunAttentionKind = typeof AgentRunAttentionKind.Type;

export const AgentRunAttention = Schema.Struct({
  kind: AgentRunAttentionKind,
  /** True only for states a human is actively blocking. Drives the badge. */
  actionable: Schema.Boolean,
  /** One line an operator can act on. Never a raw state name. */
  summary: Schema.String,
});
export type AgentRunAttention = typeof AgentRunAttention.Type;

export const AgentRunSummary = Schema.Struct({
  id: TrimmedNonEmptyString,
  project: Schema.String,
  /**
   * A short, scannable name for the run.
   *
   * Work orders in the wild carry a multi-paragraph `objective` and no title,
   * so this is its opening sentence, bounded. The full text travels on the
   * detail, where there is room to read it.
   */
  title: Schema.String,
  workOrderId: Schema.String,
  state: AgentRunState,
  terminal: Schema.Boolean,
  /** True while the run still needs a human's attention. */
  attentionRequired: Schema.Boolean,
  currentCycle: NonNegativeInt,
  maxCycles: PositiveInt,
  activeRole: AgentRunActiveRole,
  startedAt: IsoDateTime,
  updatedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  /**
   * Attempts allocated, per role. Kept for technical detail — it is NOT the
   * number an operator should read as "how many times an agent ran".
   */
  workerExecutionCount: NonNegativeInt,
  reviewerExecutionCount: NonNegativeInt,
  /** Provider executions against the effective authorization, per role. */
  executions: Schema.Struct({
    worker: AgentRunExecutionBudget,
    reviewer: AgentRunExecutionBudget,
  }),
  /** What kind of attention this run needs, if any. */
  attention: AgentRunAttention,
  /**
   * Sequence number of the newest durable orchestrator event.
   *
   * Notification identity is built on this, so a client can tell "the same
   * outcome I already announced" from "the run moved again". Durable and
   * monotonic; never a client-side timestamp.
   */
  lastEventSeq: NonNegativeInt,
  /** Terminal outcome reason, e.g. `ESCALATED`. Null while non-terminal. */
  terminalReason: Schema.NullOr(Schema.String),
  humanRequired: AgentRunHumanRequired,
  process: AgentRunProcess,
  activity: AgentRunActivity,
});
export type AgentRunSummary = typeof AgentRunSummary.Type;

/** Where the run executes. Path-bearing, so the UI keeps it in details. */
export const AgentRunWorkspace = Schema.Struct({
  strategy: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  baseSha: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  repositoryPath: Schema.NullOr(Schema.String),
});
export type AgentRunWorkspace = typeof AgentRunWorkspace.Type;

/* ------------------------------------------------------------ validation */

export const AgentRunCheck = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  outcome: Schema.String,
  passed: Schema.NullOr(Schema.Boolean),
  durationMs: Schema.NullOr(NonNegativeInt),
  exitCode: Schema.NullOr(Schema.Int),
  /**
   * A bounded, redacted tail of the failing command's output.
   *
   * Only populated for checks that failed, and only after redaction — a diff
   * or a test log is exactly where a stray credential shows up.
   */
  failureDetail: Schema.NullOr(Schema.String),
});
export type AgentRunCheck = typeof AgentRunCheck.Type;

export const AGENT_RUN_VALIDATION_STAGES = [
  "pre_worker",
  "post_worker",
  "pre_review",
  "final",
] as const;
export const AgentRunValidationStage = Schema.Literals(AGENT_RUN_VALIDATION_STAGES);
export type AgentRunValidationStage = typeof AgentRunValidationStage.Type;

export const AgentRunValidationReport = Schema.Struct({
  stage: AgentRunValidationStage,
  cycle: PositiveInt,
  /**
   * The artifact this report came from.
   *
   * One semantic phase can be validated more than once — an evidence recovery
   * legitimately reruns the checks — so a stage alone does not identify a
   * report. Carried so the surface can show the latest authoritative result
   * and still let an operator find the earlier ones.
   */
  artifact: Schema.String,
  ranAt: Schema.NullOr(IsoDateTime),
  passed: Schema.NullOr(Schema.Boolean),
  checks: Schema.Array(AgentRunCheck),
});
export type AgentRunValidationReport = typeof AgentRunValidationReport.Type;

/** The acceptance gate that settles an approving reviewer's claim. */
export const AgentRunFinalGate = Schema.Struct({
  cycle: PositiveInt,
  ranAt: IsoDateTime,
  passed: Schema.Boolean,
  checksRun: Schema.Array(Schema.String),
  failures: Schema.Array(AgentRunCheck),
});
export type AgentRunFinalGate = typeof AgentRunFinalGate.Type;

/* -------------------------------------------------------------- reviewer */

export const AgentRunReview = Schema.Struct({
  cycle: PositiveInt,
  verdict: Schema.String,
  summary: Schema.String,
  requiredChanges: Schema.Array(Schema.String),
  blockingReason: Schema.NullOr(Schema.String),
  evidence: Schema.Array(Schema.String),
});
export type AgentRunReview = typeof AgentRunReview.Type;

/* ---------------------------------------------------------------- cycles */

export const AgentRunExecution = Schema.Struct({
  role: Schema.Literals(["worker", "reviewer"]),
  agentId: Schema.String,
  attempt: PositiveInt,
  attemptId: Schema.NullOr(Schema.String),
  status: Schema.String,
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime,
  durationMs: NonNegativeInt,
  exitCode: Schema.NullOr(Schema.Int),
  /** Never rendered prominently; a pid is a technical detail. */
  pid: Schema.NullOr(PositiveInt),
  issues: Schema.Array(Schema.String),
});
export type AgentRunExecution = typeof AgentRunExecution.Type;

export const AgentRunCycle = Schema.Struct({
  number: PositiveInt,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  workerStatus: AgentRunPhaseStatus,
  validationStatus: AgentRunPhaseStatus,
  reviewerStatus: AgentRunPhaseStatus,
  finalValidationStatus: AgentRunPhaseStatus,
  workerSummary: Schema.NullOr(Schema.String),
  changedFiles: Schema.Array(Schema.String),
  executions: Schema.Array(AgentRunExecution),
  review: Schema.NullOr(AgentRunReview),
  validation: Schema.Array(AgentRunValidationReport),
  finalGate: Schema.NullOr(AgentRunFinalGate),
});
export type AgentRunCycle = typeof AgentRunCycle.Type;

/* -------------------------------------------------------------- timeline */

export const AgentRunTimelineKind = Schema.Literals([
  "run",
  "worker",
  "validation",
  "reviewer",
  "final_gate",
  "files",
  "human",
  "recovery",
]);
export type AgentRunTimelineKind = typeof AgentRunTimelineKind.Type;

/**
 * One durable fact, placed on a clock.
 *
 * Every entry is built from something already written down: a run event, an
 * attempt journal entry, a validation artifact, a reviewer result. No entry is
 * synthesised to make the timeline look continuous.
 */
export const AgentRunTimelineEntry = Schema.Struct({
  at: IsoDateTime,
  kind: AgentRunTimelineKind,
  title: Schema.String,
  detail: Schema.NullOr(Schema.String),
  cycle: Schema.NullOr(PositiveInt),
  tone: Schema.Literals(["neutral", "success", "attention", "failure", "running"]),
  /** Which artifact this came from, for the technical-details disclosure. */
  source: Schema.Literals(["events", "attempt-journal", "validation", "reviewer", "run-record"]),
});
export type AgentRunTimelineEntry = typeof AgentRunTimelineEntry.Type;

/* ---------------------------------------------------------------- detail */

/**
 * A human-authorized recovery from an orchestrator-side failure.
 *
 * Distinct from a product decision: the engine, not the work, was what went
 * wrong. Recorded so a finished run can still explain why its reviewer
 * authorization is wider than the Work Order asked for, and why a verdict was
 * set aside and retaken.
 */
export const AgentRunEvidenceRecovery = Schema.Struct({
  at: Schema.NullOr(IsoDateTime),
  authorizedBy: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
  /** Reason of the outcome this recovery superseded, e.g. `REVIEW_UNUSABLE`. */
  supersededReason: Schema.NullOr(Schema.String),
  additionalReviewerExecutions: NonNegativeInt,
});
export type AgentRunEvidenceRecovery = typeof AgentRunEvidenceRecovery.Type;

export const AgentRunDetail = Schema.Struct({
  summary: AgentRunSummary,
  /** The work order's objective in full, unabridged. Null when unreadable. */
  objective: Schema.NullOr(Schema.String),
  workspace: AgentRunWorkspace,
  cycles: Schema.Array(AgentRunCycle),
  timeline: Schema.Array(AgentRunTimelineEntry),
  /** Worker / reviewer adapter identities, e.g. `claude-code` / `codex`. */
  agents: Schema.Struct({ worker: Schema.String, reviewer: Schema.String }),
  limits: Schema.Struct({
    maxWorkerExecutions: Schema.NullOr(PositiveInt),
    maxReviewerExecutions: Schema.NullOr(PositiveInt),
  }),
  interruptions: NonNegativeInt,
  resumes: NonNegativeInt,
  /** Orchestrator-side recoveries a human authorized. Empty for most runs. */
  evidenceRecoveries: Schema.Array(AgentRunEvidenceRecovery),
  /**
   * Non-fatal problems reading this run's evidence, e.g. one unreadable
   * validation artifact. Surfaced rather than swallowed: a gap in the evidence
   * is itself something the operator should know about.
   */
  degraded: Schema.Array(Schema.String),
});
export type AgentRunDetail = typeof AgentRunDetail.Type;

/* ------------------------------------------------------------------- rpc */

export const AgentRunsListInput = Schema.Struct({});
export type AgentRunsListInput = typeof AgentRunsListInput.Type;

/**
 * The list response also reports whether observation is configured at all, so
 * the UI can stay completely out of the way when it is not.
 */
export const AgentRunsListResult = Schema.Struct({
  configured: Schema.Boolean,
  /** Present only for the technical-details disclosure. */
  home: Schema.NullOr(Schema.String),
  runs: Schema.Array(AgentRunSummary),
  /** Runs whose artifacts could not be read, by id. Never silently dropped. */
  unreadable: Schema.Array(Schema.Struct({ id: Schema.String, reason: Schema.String })),
});
export type AgentRunsListResult = typeof AgentRunsListResult.Type;

export const AgentRunsGetInput = Schema.Struct({ runId: TrimmedNonEmptyString });
export type AgentRunsGetInput = typeof AgentRunsGetInput.Type;

export class AgentRunsNotConfiguredError extends Schema.TaggedErrorClass<AgentRunsNotConfiguredError>()(
  "AgentRunsNotConfiguredError",
  {},
) {
  override get message() {
    return "No orchestrator home is configured for this server.";
  }
}

export class AgentRunsNotFoundError extends Schema.TaggedErrorClass<AgentRunsNotFoundError>()(
  "AgentRunsNotFoundError",
  { runId: Schema.String },
) {
  override get message() {
    return `Unknown agent run: ${this.runId}`;
  }
}

export class AgentRunsReadError extends Schema.TaggedErrorClass<AgentRunsReadError>()(
  "AgentRunsReadError",
  { runId: Schema.NullOr(Schema.String), reason: Schema.String },
) {
  override get message() {
    return this.runId === null
      ? `Failed to read orchestrator runs: ${this.reason}`
      : `Failed to read agent run ${this.runId}: ${this.reason}`;
  }
}

export const AgentRunsError = Schema.Union([
  AgentRunsNotConfiguredError,
  AgentRunsNotFoundError,
  AgentRunsReadError,
]);
export type AgentRunsError = typeof AgentRunsError.Type;

export const AGENT_RUNS_WS_METHODS = {
  list: "agentRuns.list",
  get: "agentRuns.get",
} as const;

/**
 * How often the client re-reads run state.
 *
 * The orchestrator writes durable state at agent boundaries, not at video
 * frame rate, so seconds are the right unit. Three seconds keeps "is it still
 * moving?" honest without turning the filesystem into a hot loop.
 */
export const AGENT_RUNS_LIST_POLL_MS = 3_000;
export const AGENT_RUNS_DETAIL_POLL_MS = 3_000;
