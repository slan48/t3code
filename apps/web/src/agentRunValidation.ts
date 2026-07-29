import type {
  AgentRunCycle,
  AgentRunDetail,
  AgentRunValidationReport,
  AgentRunValidationStage,
} from "@t3tools/contracts";

/**
 * Which validation result is *the* result, and which are history.
 *
 * One semantic phase can be validated several times. The accepted real run
 * validated `post_worker` seven times in one cycle, because an evidence
 * recovery legitimately reran the checks after the reviewer was found to have
 * judged on missing evidence. All seven are true; only the last one is the
 * answer to "did post-worker validation pass?".
 *
 * Showing all of them side by side was actively misleading — it read as though
 * the run had validated seven separate things — while showing only the last
 * would have buried the cycle-1 format failure that explains why the run took
 * two cycles at all. So: latest is promoted, earlier runs are kept and
 * counted, and failures among them stay findable.
 *
 * Pure, so the ordering rules are testable without a browser.
 */

/** Display order: the order the engine actually runs them in. */
const STAGE_ORDER: readonly AgentRunValidationStage[] = [
  "pre_worker",
  "post_worker",
  "pre_review",
  "final",
];

export const VALIDATION_STAGE_LABELS: Readonly<Record<AgentRunValidationStage, string>> = {
  pre_worker: "Pre-worker preparation",
  post_worker: "Post-worker validation",
  pre_review: "Pre-review evidence",
  final: "Final validation",
};

export interface ValidationPhaseView {
  readonly stage: AgentRunValidationStage;
  readonly cycle: number;
  /** The authoritative result for this phase. */
  readonly latest: AgentRunValidationReport;
  /** Earlier runs of the same phase, newest first. */
  readonly previous: readonly AgentRunValidationReport[];
  /** True when any earlier run failed — worth surfacing even though it is old. */
  readonly hasEarlierFailure: boolean;
}

/**
 * Newest last. A report with no clock sorts oldest: an artifact we cannot place
 * in time must never outrank one we can.
 */
function byRanAt(left: AgentRunValidationReport, right: AgentRunValidationReport): number {
  if (left.ranAt === right.ranAt) return left.artifact.localeCompare(right.artifact);
  if (left.ranAt === null) return -1;
  if (right.ranAt === null) return 1;
  return left.ranAt.localeCompare(right.ranAt);
}

export function groupValidationByPhase(cycle: AgentRunCycle): readonly ValidationPhaseView[] {
  const byStage = new Map<AgentRunValidationStage, AgentRunValidationReport[]>();
  for (const report of cycle.validation) {
    const bucket = byStage.get(report.stage);
    if (bucket === undefined) byStage.set(report.stage, [report]);
    else bucket.push(report);
  }

  const views: ValidationPhaseView[] = [];
  for (const stage of STAGE_ORDER) {
    const reports = byStage.get(stage);
    if (reports === undefined || reports.length === 0) continue;
    const sorted = [...reports].sort(byRanAt);
    const latest = sorted.at(-1)!;
    const previous = sorted.slice(0, -1).toReversed();
    views.push({
      stage,
      cycle: cycle.number,
      latest,
      previous,
      hasEarlierFailure: previous.some((report) => report.passed === false),
    });
  }
  return views;
}

/**
 * Failures worth remembering after the run moved on.
 *
 * A phase that failed and was later rerun to green still explains the shape of
 * the run — the cycle-1 format failure is why there was a cycle 2 — so it is
 * collected across every cycle rather than only from the latest one.
 */
export interface NotableValidationFailure {
  readonly cycle: number;
  readonly stage: AgentRunValidationStage;
  readonly report: AgentRunValidationReport;
  readonly failedCheckIds: readonly string[];
  /** True when a later run of the same phase in the same cycle passed. */
  readonly supersededByPass: boolean;
}

export function notableValidationFailures(
  detail: AgentRunDetail,
): readonly NotableValidationFailure[] {
  const failures: NotableValidationFailure[] = [];
  for (const cycle of detail.cycles) {
    for (const phase of groupValidationByPhase(cycle)) {
      const all = [phase.latest, ...phase.previous];
      for (const report of all) {
        if (report.passed !== false) continue;
        failures.push({
          cycle: cycle.number,
          stage: phase.stage,
          report,
          failedCheckIds: report.checks
            .filter((check) => check.passed === false)
            .map((check) => check.id),
          supersededByPass: phase.latest.passed === true && report !== phase.latest,
        });
      }
    }
  }
  return failures;
}

/** How many validation runs happened in total, across every phase and cycle. */
export function totalValidationRuns(detail: AgentRunDetail): number {
  return detail.cycles.reduce((total, cycle) => total + cycle.validation.length, 0);
}

export function describeReportOutcome(report: AgentRunValidationReport): string {
  const total = report.checks.length;
  const passed = report.checks.filter((check) => check.passed === true).length;
  if (total === 0) return report.passed === true ? "passed" : "no checks recorded";
  return `${passed} / ${total} passed`;
}
