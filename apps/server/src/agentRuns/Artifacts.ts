/**
 * The on-disk contract of an external `agent-orchestrator` home.
 *
 * This module is the *only* place in T3Code that knows what an orchestrator
 * writes to disk. Everything above it consumes the normalized `@t3tools/contracts`
 * shapes, so a change to `run.json` lands here and nowhere else.
 *
 * Two rules govern the schemas below:
 *
 *   1. They are **lenient about what they don't know** and strict about what
 *      they do. A newer orchestrator that adds a field must not blank the
 *      operator's screen; a corrupt file must not be rendered as fact.
 *   2. They are **read-only**. Nothing in this directory opens a file for
 *      writing, and nothing constructs a path from data an agent produced.
 *
 * @module AgentRunsArtifacts
 */
import * as Schema from "effect/Schema";

/* ------------------------------------------------------------------ paths */

export const ORCHESTRATOR_RUNS_DIR = "runs";
export const ORCHESTRATOR_LOCKS_DIR = "locks";
export const RUN_FILE = "run.json";
export const WORK_ORDER_FILE = "work-order.json";
export const EVENTS_FILE = "events.jsonl";
export const ATTEMPTS_DIR = "attempts";
export const ATTEMPT_JOURNAL_FILE = "journal.jsonl";

/**
 * Run and attempt identifiers, as the orchestrator mints them.
 *
 * These patterns are the containment primitive: an id that does not match is
 * never joined into a path, so `..`, absolute paths, and separator injection
 * cannot be expressed in the first place.
 */
export const RUN_ID_PATTERN = /^run-\d{8}-\d{6}-[0-9a-f]{8}$/;
export const ATTEMPT_ID_PATTERN = /^(worker|reviewer)-\d{2,}$/;
export const CYCLE_DIR_PATTERN = /^cycle-\d{3,}$/;

export function isRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}

export function isAttemptId(value: string): boolean {
  return ATTEMPT_ID_PATTERN.test(value);
}

export function cycleDirName(cycleNumber: number): string {
  if (!Number.isInteger(cycleNumber) || cycleNumber < 1) {
    throw new RangeError(`cycle must be a positive integer, received ${cycleNumber}`);
  }
  return `cycle-${String(cycleNumber).padStart(3, "0")}`;
}

/**
 * Validation artifacts are named after their stage, with `_` becoming `-`, and
 * a retried stage gets an `attempt-N` infix so history is never overwritten.
 */
export function validationArtifactNames(stage: string): readonly string[] {
  const base = `validation.${stage.replace(/_/g, "-")}`;
  return [`${base}.json`, `${base}.attempt-2.json`, `${base}.attempt-3.json`];
}

/* --------------------------------------------------------------- helpers */

/** A field the orchestrator may omit, may null, and may fill. */
const Nullish = <A, I, R>(schema: Schema.Codec<A, I, R>) => Schema.optional(Schema.NullOr(schema));

const Str = Schema.String;
const Num = Schema.Number;

/* ------------------------------------------------------------- run record */

export const OrchestratorExecution = Schema.Struct({
  role: Schema.Literals(["worker", "reviewer"]),
  agentId: Str,
  attempt: Num,
  attemptId: Nullish(Str),
  pid: Nullish(Num),
  signal: Nullish(Str),
  providerSessionId: Nullish(Str),
  startedAt: Str,
  finishedAt: Str,
  durationMs: Num,
  timeoutMs: Nullish(Num),
  status: Str,
  exitCode: Nullish(Num),
  artifacts: Schema.optional(Schema.Array(Str)),
  issues: Schema.optional(Schema.Array(Str)),
});
export type OrchestratorExecution = typeof OrchestratorExecution.Type;

export const OrchestratorReview = Schema.Struct({
  verdict: Str,
  summary: Schema.optional(Str),
  requiredChanges: Schema.optional(Schema.Array(Str)),
  blockingReason: Nullish(Str),
  evidence: Schema.optional(Schema.Array(Str)),
});
export type OrchestratorReview = typeof OrchestratorReview.Type;

export const OrchestratorGateFailure = Schema.Struct({
  id: Str,
  name: Schema.optional(Str),
  outcome: Schema.optional(Str),
  exitCode: Nullish(Num),
  detail: Nullish(Str),
  tail: Schema.optional(Str),
});
export type OrchestratorGateFailure = typeof OrchestratorGateFailure.Type;

export const OrchestratorFinalGate = Schema.Struct({
  ranAt: Str,
  passed: Schema.Boolean,
  checksRun: Schema.optional(Schema.Array(Str)),
  failures: Schema.optional(Schema.Array(OrchestratorGateFailure)),
});
export type OrchestratorFinalGate = typeof OrchestratorFinalGate.Type;

export const OrchestratorCycle = Schema.Struct({
  number: Num,
  startedAt: Str,
  finishedAt: Nullish(Str),
  executions: Schema.optional(Schema.Array(OrchestratorExecution)),
  workerSummary: Nullish(Str),
  changedFiles: Schema.optional(Schema.Array(Str)),
  review: Schema.optional(OrchestratorReview),
  finalGate: Schema.optional(OrchestratorFinalGate),
});
export type OrchestratorCycle = typeof OrchestratorCycle.Type;

export const OrchestratorWorkspace = Schema.Struct({
  strategy: Schema.optional(Str),
  baseCommitSha: Nullish(Str),
  worktreePath: Nullish(Str),
  branchName: Nullish(Str),
  sourceRepositoryPath: Nullish(Str),
  status: Schema.optional(Str),
});
export type OrchestratorWorkspace = typeof OrchestratorWorkspace.Type;

export const OrchestratorOutcome = Schema.Struct({
  state: Str,
  reason: Str,
  message: Schema.optional(Str),
  verdict: Nullish(Str),
  cyclesUsed: Schema.optional(Num),
  at: Schema.optional(Str),
});
export type OrchestratorOutcome = typeof OrchestratorOutcome.Type;

export const OrchestratorRecovery = Schema.Struct({
  attemptId: Str,
  role: Str,
  cycle: Num,
  detectedAt: Str,
  reason: Str,
  attemptPath: Schema.optional(Str),
});
export type OrchestratorRecovery = typeof OrchestratorRecovery.Type;

/**
 * A durable, purpose-built request for a human decision.
 *
 * Optional because it postdates every historical run. Its absence is a fact
 * the projection reports honestly rather than papering over.
 */
export const OrchestratorHumanRequiredPacket = Schema.Struct({
  reasonCode: Str,
  summary: Str,
  decisionNeeded: Str,
  options: Schema.optional(Schema.Array(Str)),
  evidenceRefs: Schema.optional(Schema.Array(Str)),
  createdAt: Str,
  source: Schema.optional(Str),
});
export type OrchestratorHumanRequiredPacket = typeof OrchestratorHumanRequiredPacket.Type;

export const OrchestratorRunRecord = Schema.Struct({
  schemaVersion: Num,
  id: Str,
  state: Str,
  workOrderId: Str,
  project: Str,
  repositoryPath: Schema.optional(Str),
  maxCycles: Num,
  agents: Schema.optional(Schema.Struct({ worker: Str, reviewer: Str })),
  createdAt: Str,
  updatedAt: Str,
  finishedAt: Nullish(Str),
  cycles: Schema.optional(Schema.Array(OrchestratorCycle)),
  outcome: Schema.optional(OrchestratorOutcome),
  recovery: Schema.optional(OrchestratorRecovery),
  humanRequired: Schema.optional(OrchestratorHumanRequiredPacket),
  workspace: Schema.optional(OrchestratorWorkspace),
  limits: Schema.optional(
    Schema.Struct({
      maxWorkerExecutions: Schema.optional(Num),
      maxReviewerExecutions: Schema.optional(Num),
    }),
  ),
  /**
   * Reviewer executions granted after the fact, when the orchestrator itself
   * failed a review. Read because the effective ceiling is the base plus these:
   * a run can legitimately be authorized for more than its Work Order said.
   */
  evidenceRecoveries: Schema.optional(
    Schema.Array(
      Schema.Struct({
        at: Schema.optional(Str),
        authorizedBy: Schema.optional(Str),
        additionalReviewerExecutions: Schema.optional(Num),
      }),
    ),
  ),
  interruptions: Schema.optional(Num),
  resumes: Schema.optional(Num),
});
export type OrchestratorRunRecord = typeof OrchestratorRunRecord.Type;

/**
 * The newest `run.json` schema this build understands.
 *
 * A higher version is refused rather than half-read: showing three of five
 * fields from a format we do not know is worse than saying so.
 */
export const SUPPORTED_RUN_SCHEMA_VERSION = 1;

/* ----------------------------------------------------------- work order */

export const OrchestratorWorkOrder = Schema.Struct({
  id: Str,
  title: Schema.optional(Str),
  objective: Schema.optional(Str),
});
export type OrchestratorWorkOrder = typeof OrchestratorWorkOrder.Type;

/* ---------------------------------------------------------------- events */

export const OrchestratorEvent = Schema.Struct({
  seq: Num,
  at: Str,
  type: Str,
  from: Schema.optional(Str),
  to: Schema.optional(Str),
  cycle: Nullish(Num),
  detail: Nullish(Str),
});
export type OrchestratorEvent = typeof OrchestratorEvent.Type;

/* --------------------------------------------------------------- journal */

export const OrchestratorJournalEntry = Schema.Struct({
  seq: Num,
  at: Str,
  phase: Str,
  status: Schema.optional(Str),
  commandId: Schema.optional(Str),
  pid: Nullish(Num),
  exitCode: Nullish(Num),
  signal: Nullish(Str),
  detail: Nullish(Str),
});
export type OrchestratorJournalEntry = typeof OrchestratorJournalEntry.Type;

/**
 * The attempt's status as its journal alone reports it.
 *
 * Mirrors the orchestrator's own derivation, including the part that matters:
 * a claimed spawn with no recorded outcome is `AMBIGUOUS` *on paper*. Whether
 * that means "still running" or "we lost it" is a question only process
 * liveness can answer, and this function deliberately does not guess.
 */
export function deriveJournalStatus(entries: readonly OrchestratorJournalEntry[]): string {
  let claimed = false;
  for (const entry of entries) {
    if (entry.phase === "OUTCOME_RECORDED") return entry.status ?? "AMBIGUOUS";
    if (
      entry.phase === "SPAWN_CLAIMED" ||
      entry.phase === "SPAWNED" ||
      entry.phase === "CHILD_EXITED"
    ) {
      claimed = true;
    }
  }
  return claimed ? "AMBIGUOUS" : "ABANDONED";
}

/* ------------------------------------------------------------ validation */

export const OrchestratorCheckResult = Schema.Struct({
  id: Str,
  name: Schema.optional(Str),
  stage: Schema.optional(Str),
  startedAt: Schema.optional(Str),
  finishedAt: Schema.optional(Str),
  durationMs: Schema.optional(Num),
  exitCode: Nullish(Num),
  outcome: Schema.optional(Str),
  passed: Schema.optional(Schema.Boolean),
  timedOut: Schema.optional(Schema.Boolean),
  stdout: Schema.optional(Str),
  stderr: Schema.optional(Str),
});
export type OrchestratorCheckResult = typeof OrchestratorCheckResult.Type;

export const OrchestratorValidationReport = Schema.Struct({
  stage: Str,
  checks: Schema.optional(Schema.Array(OrchestratorCheckResult)),
});
export type OrchestratorValidationReport = typeof OrchestratorValidationReport.Type;

/* -------------------------------------------------------------- reviewer */

export const OrchestratorReviewerResult = Schema.Struct({
  verdict: Str,
  summary: Schema.optional(Str),
  requiredChanges: Schema.optional(Schema.Array(Str)),
  blockingReason: Nullish(Str),
  evidence: Schema.optional(Schema.Array(Str)),
});
export type OrchestratorReviewerResult = typeof OrchestratorReviewerResult.Type;

/* ------------------------------------------------------------------ lock */

export const OrchestratorLockRecord = Schema.Struct({
  schemaVersion: Num,
  kind: Str,
  resource: Str,
  runId: Str,
  pid: Num,
  processGroupId: Schema.optional(Num),
  hostname: Str,
  bootId: Str,
  acquiredAt: Str,
  state: Str,
});
export type OrchestratorLockRecord = typeof OrchestratorLockRecord.Type;

/* ------------------------------------------------------------- redaction */

/**
 * Patterns that must never reach a browser.
 *
 * The list is intentionally blunt and over-eager. Command output — a diff, a
 * failing integration test, a migration log — is precisely where a connection
 * string or a bearer token shows up, and an over-redacted tail is a far
 * cheaper mistake than a leaked one.
 */
const SECRET_PATTERNS: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  // Any URL carrying inline credentials, e.g. postgres://user:pw@host/db.
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
    replacement: "$1[redacted]@",
  },
  // `*_DATABASE_URL=...` and friends, whose whole value is the credential.
  {
    pattern: /\b([A-Za-z0-9_.-]*(?:DATABASE_URL|DSN|CONNECTION_STRING))\s*[:=]\s*(\S+)/gi,
    replacement: "$1=[redacted]",
  },
  // Authorization headers.
  { pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g, replacement: "$1 [redacted]" },
  // `KEY=value`, `SECRET: value`, `token = value`, in env dumps and logs.
  {
    pattern:
      /\b([A-Za-z0-9_.-]*(?:PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|SESSION_KEY|AUTH)[A-Za-z0-9_.-]*)\s*[:=]\s*("[^"\n]*"|'[^'\n]*'|\S+)/gi,
    replacement: "$1=[redacted]",
  },
  // Well-known key shapes that are self-identifying regardless of context.
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replacement: "[redacted]" },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replacement: "[redacted]" },
  { pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, replacement: "[redacted]" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: "[redacted]" },
  {
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[redacted private key]",
  },
  // JWTs.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replacement: "[redacted]",
  },
];

export function redactSecrets(value: string): string {
  let out = value;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export const MAX_FAILURE_DETAIL_CHARS = 2_000;

/**
 * The end of a failing command's output, redacted and bounded.
 *
 * The tail, not the head: compilers and test runners put the part a human
 * would actually read at the end. Passing checks contribute nothing — their
 * output is bulk (a full `git diff`, for one) with no diagnostic value.
 */
export function failureTail(check: OrchestratorCheckResult): string | null {
  if (check.passed === true) return null;
  const raw = `${check.stderr ?? ""}\n${check.stdout ?? ""}`.trim();
  if (raw.length === 0) return null;
  const redacted = redactSecrets(raw);
  return redacted.length <= MAX_FAILURE_DETAIL_CHARS
    ? redacted
    : `…\n${redacted.slice(-MAX_FAILURE_DETAIL_CHARS)}`;
}
