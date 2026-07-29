import type {
  AgentRunCheck,
  AgentRunCycle,
  AgentRunDetail,
  AgentRunReview,
} from "@t3tools/contracts";
import { CheckIcon, CopyIcon } from "lucide-react";
import { memo, useCallback, useState } from "react";

import {
  describeActivity,
  elapsedMillis,
  formatDuration,
  formatRelative,
  QUIET_THRESHOLD_MS,
  quietMillis,
  toneToBadgeVariant,
} from "~/agentRunFormat";
import {
  ATTENTION_LABELS,
  describeAgentsRunning,
  describeAttemptGap,
  describeGuidance,
  formatExecutionBudget,
} from "~/agentRunAttention";
import { buildAgentRunMarkdown } from "~/agentRunReport";
import {
  describeReportOutcome,
  groupValidationByPhase,
  VALIDATION_STAGE_LABELS,
  type ValidationPhaseView,
} from "~/agentRunValidation";
import { useNowMs } from "~/hooks/useNowMs";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  AgentRunPhaseRow,
  AgentRunProcessLine,
  AgentRunStatePill,
  ToneIcon,
  toneTextClass,
} from "./AgentRunPrimitives";
import { AgentRunTimeline } from "./AgentRunTimeline";

/**
 * One run, answered top-down.
 *
 * The order is the operator's order of questions, not the data model's:
 * what needs me → what is happening → what happened → the technical detail
 * nobody wants unless they are debugging the orchestrator itself.
 */
export const AgentRunDetailView = memo(function AgentRunDetailView({
  detail,
}: {
  detail: AgentRunDetail;
}) {
  const nowMs = useNowMs(1_000);
  const { summary } = detail;
  const currentCycle = detail.cycles.at(-1) ?? null;

  return (
    <div className="flex min-w-0 flex-col gap-5 pb-16">
      <header className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="min-w-0 text-base font-semibold text-foreground">{summary.title}</h1>
          <AgentRunStatePill state={summary.state} />
        </div>
        {/*
          The copy action sits on the metadata row rather than beside the
          title. A run title is a full sentence, and on a phone a button
          sharing that line squeezes it into a one-word-per-line column.
        */}
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
          <span className="truncate">{summary.project}</span>
          <span>
            Cycle {summary.currentCycle} / {summary.maxCycles}
          </span>
          <span>
            {summary.terminal ? "Ran" : "Running"}{" "}
            {formatDuration(elapsedMillis(summary.startedAt, summary.finishedAt, nowMs))}
          </span>
          <CopyReportButton detail={detail} />
        </div>
      </header>

      <GuidancePanel detail={detail} />

      {summary.humanRequired.present ? <HumanRequiredPanel detail={detail} /> : null}

      <ExecutionBudgetPanel detail={detail} />

      {detail.objective !== null ? <ObjectivePanel objective={detail.objective} /> : null}

      {!summary.terminal ? <LivePanel detail={detail} nowMs={nowMs} /> : null}

      {currentCycle !== null ? (
        <Panel title={`Cycle ${currentCycle.number}`}>
          <AgentRunPhaseRow
            label={`Worker · ${detail.agents.worker}`}
            status={currentCycle.workerStatus}
            detail={currentCycle.workerSummary}
          />
          <AgentRunPhaseRow label="Validation" status={currentCycle.validationStatus} />
          <AgentRunPhaseRow
            label={`Reviewer · ${detail.agents.reviewer}`}
            status={currentCycle.reviewerStatus}
            detail={currentCycle.review?.summary ?? null}
          />
          <AgentRunPhaseRow label="Final gate" status={currentCycle.finalValidationStatus} />
        </Panel>
      ) : null}

      {detail.cycles.map((cycle) => (
        <CyclePanels key={cycle.number} cycle={cycle} agents={detail.agents} />
      ))}

      <Panel title="Timeline">
        <AgentRunTimeline entries={detail.timeline} />
      </Panel>

      <TechnicalDetails detail={detail} />
    </div>
  );
});

/* --------------------------------------------------------------- guidance */

/**
 * The first thing on the page: is anything expected of me?
 *
 * A product decision, an orchestrator recovery and a failed run all used to
 * render as "human input required", which is three different jobs for
 * potentially three different people wearing one label. They are now visually
 * and verbally distinct, and a run that needs nothing says so rather than
 * leaving the operator to infer it from the absence of a warning.
 */
const GuidancePanel = memo(function GuidancePanel({ detail }: { detail: AgentRunDetail }) {
  const guidance = describeGuidance(detail.summary);
  const agents = describeAgentsRunning(detail);

  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-xl border px-3.5 py-3",
        guidance.actionRequired
          ? "border-warning/50 bg-warning/8"
          : guidance.tone === "failure"
            ? "border-destructive/40 bg-destructive/6"
            : "bg-card",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <ToneIcon
          tone={guidance.tone}
          className={cn("size-4 shrink-0", toneTextClass(guidance.tone))}
        />
        <h2 className={cn("min-w-0 text-sm font-semibold", toneTextClass(guidance.tone))}>
          {guidance.headline}
        </h2>
        {detail.summary.attention.kind !== "none" ? (
          <Badge variant={toneToBadgeVariant(guidance.tone)} size="sm" className="shrink-0">
            {ATTENTION_LABELS[detail.summary.attention.kind]}
          </Badge>
        ) : null}
      </div>
      <p className="min-w-0 break-words text-sm text-muted-foreground">{guidance.detail}</p>
      {/*
        Always stated, in every state. "Is something still running on my
        subscription?" must never be something an operator has to infer.
      */}
      <p className="min-w-0 break-words text-xs text-muted-foreground/90">{agents}</p>
    </section>
  );
});

/* -------------------------------------------------------- execution budget */

/**
 * Provider executions against the authorization actually in force.
 *
 * Promoted out of technical details because it is the number an operator uses
 * to decide whether a run can continue. It previously read "4 / 2" — allocated
 * attempts over the *base* limit — which claimed an overrun that never
 * happened. Attempts are still shown, but as a footnote and only when they
 * differ from executions.
 */
const ExecutionBudgetPanel = memo(function ExecutionBudgetPanel({
  detail,
}: {
  detail: AgentRunDetail;
}) {
  return (
    <Panel title="Provider executions">
      <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:gap-6">
        <BudgetRow
          label={`Worker · ${detail.agents.worker}`}
          budget={detail.summary.executions.worker}
        />
        <BudgetRow
          label={`Reviewer · ${detail.agents.reviewer}`}
          budget={detail.summary.executions.reviewer}
        />
      </div>
    </Panel>
  );
});

function BudgetRow({
  label,
  budget,
}: {
  label: string;
  budget: AgentRunDetail["summary"]["executions"]["worker"];
}) {
  const gap = describeAttemptGap(budget);
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="font-mono text-lg font-semibold text-foreground tabular-nums">
        {formatExecutionBudget(budget)}
      </span>
      {gap !== null ? (
        <span className="min-w-0 break-words text-xs text-muted-foreground">{gap}</span>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ copy report */

/**
 * One click from "this run" to "a message I can paste".
 *
 * The Markdown is built from the normalized run model, not from the page, so
 * what the reader gets does not depend on which panels happened to be expanded
 * when the button was pressed — and the whole run travels, including the parts
 * below the fold that previously needed a second screenshot.
 */
const CopyReportButton = memo(function CopyReportButton({ detail }: { detail: AgentRunDetail }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    const markdown = buildAgentRunMarkdown(detail, { nowMs: Date.now() });
    void writeTextToClipboard(markdown, "run report").then(
      (didCopy) => {
        if (!didCopy) return;
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2_000);
        toastManager.add({
          type: "success",
          title: "Report copied",
          description: `${detail.summary.id} · Markdown`,
          timeout: 4_000,
        });
      },
      (error: unknown) => {
        // A denied clipboard permission or an insecure origin is the common
        // case here, and it is silent unless we say so.
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not copy the report",
            description: error instanceof Error ? error.message : "The clipboard is unavailable.",
          }),
        );
      },
    );
  }, [detail]);

  return (
    <Button
      size="xs"
      variant="outline"
      onClick={handleCopy}
      aria-label="Copy run report as Markdown"
      className="shrink-0"
    >
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      {copied ? "Copied" : "Copy report"}
    </Button>
  );
});

/* ------------------------------------------------------------------ panel */

function Panel({
  title,
  children,
  tone,
}: {
  title: string;
  children: React.ReactNode;
  tone?: "attention";
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col rounded-xl border bg-card px-3 py-3",
        tone === "attention" && "border-warning/40 bg-warning/4",
      )}
    >
      <h2 className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      <div className="flex min-w-0 flex-col">{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------- objective */

/**
 * What the run was authorized to do, in full.
 *
 * Collapsed to a few lines by default: the objective is the context you reach
 * for once, when deciding whether an escalation is reasonable, and it would
 * otherwise push every live fact below the fold.
 */
const ObjectivePanel = memo(function ObjectivePanel({ objective }: { objective: string }) {
  const [open, setOpen] = useState(false);

  return (
    <Panel title="Objective">
      <p
        className={cn(
          "min-w-0 text-sm whitespace-pre-wrap text-muted-foreground",
          !open && "line-clamp-3",
        )}
      >
        {objective}
      </p>
      <Button
        size="xs"
        variant="ghost"
        className="mt-1 self-start"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Show less" : "Show full objective"}
      </Button>
    </Panel>
  );
});

/* --------------------------------------------------------- human required */

/**
 * The decision request, given the most prominent position on the page.
 *
 * When the orchestrator wrote a purpose-built packet, this reads as a question
 * with an answer expected. When the packet predates that capability, it says
 * so and points at the evidence rather than manufacturing a question nobody
 * asked — a historical run is not retroactively given a decision it never had.
 */
const HumanRequiredPanel = memo(function HumanRequiredPanel({
  detail,
}: {
  detail: AgentRunDetail;
}) {
  const { humanRequired, process } = detail.summary;

  // When a reviewer escalates, the run's outcome message *is* its blocking
  // reason, so both fields hold the same sentences. Printing them twice under
  // two headings reads as though there were two separate problems.
  const summaryIsDistinct =
    humanRequired.summary !== null && humanRequired.summary !== humanRequired.decisionNeeded;

  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-warning/50 bg-warning/8 px-3.5 py-3.5">
      <div className="flex items-center gap-2">
        <ToneIcon tone="attention" className="size-4 shrink-0 text-warning-foreground" />
        <h2 className="text-sm font-semibold text-warning-foreground">Human input required</h2>
        {humanRequired.reasonCode !== null ? (
          <Badge variant="warning" size="sm" className="font-mono">
            {humanRequired.reasonCode}
          </Badge>
        ) : null}
      </div>

      {summaryIsDistinct && humanRequired.summary !== null ? (
        <Field label="Why the run stopped" value={humanRequired.summary} />
      ) : null}

      {humanRequired.decisionNeeded !== null ? (
        <Field
          label={summaryIsDistinct ? "Decision needed" : "Why the run stopped, and what it needs"}
          value={humanRequired.decisionNeeded}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          This run recorded no structured decision request. Open the evidence below for details.
        </p>
      )}

      {humanRequired.options.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Options offered</span>
          <ul className="ms-4 list-disc text-sm text-foreground">
            {humanRequired.options.map((option) => (
              <li key={option} className="min-w-0 break-words">
                {option}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {humanRequired.evidence.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Relevant evidence</span>
          <ul className="ms-4 list-disc text-sm text-foreground">
            {humanRequired.evidence.map((item) => (
              <li key={item} className="min-w-0 break-words">
                {item}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/*
        Says the quiet part out loud. "Human required" without this line leaves
        an operator wondering whether an agent is still burning their
        subscription in the background.
      */}
      <div className="flex items-center gap-1.5 border-t border-warning/25 pt-2.5 text-xs text-muted-foreground">
        <ToneIcon tone="idle" className="size-3 shrink-0" />
        {process.lockHeld
          ? "A run lock is still held — see technical details."
          : "No agents are currently running."}
      </div>

      {humanRequired.source === "derived" ? (
        <p className="text-[0.6875rem] text-muted-foreground/80">
          Assembled from the reviewer verdict and run outcome; this run predates structured decision
          packets.
        </p>
      ) : null}
    </section>
  );
});

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <p className="min-w-0 break-words text-sm text-foreground">{value}</p>
    </div>
  );
}

/* ----------------------------------------------------------------- live */

/**
 * What is happening right now, for a run that has not finished.
 *
 * Every line is evidence-backed. When nothing durable has happened for a
 * while, that silence is reported explicitly alongside the liveness of the
 * process — which is precisely the pair of facts that turns a black box into
 * something an operator can reason about.
 */
const LivePanel = memo(function LivePanel({
  detail,
  nowMs,
}: {
  detail: AgentRunDetail;
  nowMs: number;
}) {
  const { summary } = detail;
  const quiet = quietMillis(summary.activity, nowMs);
  const lines = describeActivity(summary.activity, nowMs);

  return (
    <Panel title="Now">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{roleLabel(detail)}</span>
          <Badge variant={toneToBadgeVariant("running")}>
            {formatDuration(elapsedMillis(summary.startedAt, null, nowMs))}
          </Badge>
        </div>

        <AgentRunProcessLine process={summary.process} />

        {lines.map((line) => (
          <span key={line} className="min-w-0 break-words text-xs text-muted-foreground">
            {line}
          </span>
        ))}

        {quiet !== null && quiet > QUIET_THRESHOLD_MS ? (
          <span className={cn("text-xs", toneTextClass("attention"))}>
            No new durable activity for {formatDuration(quiet)}
          </span>
        ) : null}
      </div>
    </Panel>
  );
});

function roleLabel(detail: AgentRunDetail): string {
  switch (detail.summary.activeRole) {
    case "worker":
      return `${detail.agents.worker} working`;
    case "reviewer":
      return `${detail.agents.reviewer} reviewing`;
    case "validation":
      return "Deterministic validation";
    case "final_validation":
      return "Final acceptance gate";
    case "none":
      return "No agent active";
  }
}

/* ---------------------------------------------------------------- cycles */

const CyclePanels = memo(function CyclePanels({
  cycle,
  agents,
}: {
  cycle: AgentRunCycle;
  agents: AgentRunDetail["agents"];
}) {
  const phases = groupValidationByPhase(cycle);

  return (
    <>
      {phases.length > 0 || cycle.finalGate !== null ? (
        <Panel title={`Validation · cycle ${cycle.number}`}>
          <div className="flex min-w-0 flex-col gap-3">
            {phases.map((phase) => (
              <ValidationPhaseBlock key={phase.stage} phase={phase} />
            ))}
          </div>

          {cycle.finalGate !== null ? (
            <div className="mt-3 border-t pt-2">
              <AgentRunPhaseRow
                label="Final acceptance gate"
                status={cycle.finalGate.passed ? "passed" : "failed"}
                detail={`${
                  cycle.finalGate.checksRun.length - cycle.finalGate.failures.length
                } / ${cycle.finalGate.checksRun.length} passed`}
              />
              {cycle.finalGate.failures.map((failure) => (
                <CheckRow key={failure.id} check={failure} />
              ))}
            </div>
          ) : null}
        </Panel>
      ) : null}

      {cycle.review !== null ? (
        <ReviewPanel
          review={cycle.review}
          agentLabel={`${agents.reviewer} · cycle ${cycle.number}`}
        />
      ) : null}
    </>
  );
});

/**
 * One semantic validation phase: the answer, then the history behind it.
 *
 * The latest run is the answer and is always open. Earlier runs of the same
 * phase are counted and collapsed — they are real, and an evidence recovery
 * makes several of them routine, but only one of them is current. A collapsed
 * group that contains a failure says so on its label, so the cycle-1 format
 * failure cannot hide behind a green heading.
 */
const ValidationPhaseBlock = memo(function ValidationPhaseBlock({
  phase,
}: {
  phase: ValidationPhaseView;
}) {
  const [open, setOpen] = useState(false);
  const status =
    phase.latest.passed === null ? "unknown" : phase.latest.passed ? "passed" : "failed";

  return (
    <div className="flex min-w-0 flex-col">
      <AgentRunPhaseRow
        label={VALIDATION_STAGE_LABELS[phase.stage]}
        status={status}
        detail={describeReportOutcome(phase.latest)}
      />
      <div className="flex min-w-0 flex-col divide-y divide-border/50 ps-6">
        {phase.latest.checks.map((check) => (
          <CheckRow key={`${phase.latest.artifact}-${check.id}`} check={check} />
        ))}
      </div>

      {phase.previous.length > 0 ? (
        <div className="ps-6">
          <Button
            size="xs"
            variant="ghost"
            className="mt-1 self-start"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "Hide" : "Show"} previous validation attempts ({phase.previous.length})
            {phase.hasEarlierFailure ? " · includes a failure" : ""}
          </Button>

          {open ? (
            <div className="mt-1 flex min-w-0 flex-col gap-2 border-s ps-3">
              {phase.previous.map((report) => (
                <div key={report.artifact} className="flex min-w-0 flex-col">
                  <span className="text-xs text-muted-foreground">
                    {report.ranAt ?? "time unknown"} · {describeReportOutcome(report)}
                  </span>
                  <span className="font-mono text-[0.6875rem] text-muted-foreground/70">
                    {report.artifact}
                  </span>
                  {report.checks
                    .filter((check) => check.passed === false)
                    .map((check) => (
                      <CheckRow key={`${report.artifact}-${check.id}`} check={check} />
                    ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

/**
 * One deterministic check.
 *
 * Failure output is collapsed by default and bounded when opened. A wall of
 * log lines is not an interface, and the tail is where the actionable part
 * lives anyway.
 */
const CheckRow = memo(function CheckRow({ check }: { check: AgentRunCheck }) {
  const [open, setOpen] = useState(false);
  const tone = check.passed === true ? "success" : check.passed === false ? "failure" : "idle";

  return (
    <div className="flex min-w-0 flex-col py-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <ToneIcon tone={tone} className={cn("size-3.5 shrink-0", toneTextClass(tone))} />
        <span className="min-w-0 flex-1 truncate text-sm text-foreground">{check.name}</span>
        {check.durationMs !== null ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatDuration(check.durationMs)}
          </span>
        ) : null}
        {check.failureDetail !== null ? (
          <Button size="xs" variant="ghost" onClick={() => setOpen((value) => !value)}>
            {open ? "Hide output" : "View output"}
          </Button>
        ) : null}
      </div>
      {open && check.failureDetail !== null ? (
        <pre className="mt-1.5 max-h-64 min-w-0 overflow-auto rounded-md bg-muted px-2 py-1.5 font-mono text-[0.6875rem] whitespace-pre-wrap text-muted-foreground">
          {check.failureDetail}
        </pre>
      ) : null}
    </div>
  );
});

/* -------------------------------------------------------------- reviewer */

const ReviewPanel = memo(function ReviewPanel({
  review,
  agentLabel,
}: {
  review: AgentRunReview;
  agentLabel: string;
}) {
  const tone = review.verdict === "OBJECTIVE_DONE" ? "success" : "attention";

  return (
    <Panel title={`Review · ${agentLabel}`}>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Badge variant={toneToBadgeVariant(tone)} className="font-mono">
            {review.verdict}
          </Badge>
          {review.requiredChanges.length > 0 ? (
            <span className="text-xs text-muted-foreground">
              {review.requiredChanges.length} requested change
              {review.requiredChanges.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>

        {review.summary.length > 0 ? (
          <p className="min-w-0 break-words text-sm text-foreground">{review.summary}</p>
        ) : null}

        {review.requiredChanges.length > 0 ? (
          <ul className="ms-4 list-disc text-sm text-foreground">
            {review.requiredChanges.map((change) => (
              <li key={change} className="min-w-0 break-words">
                {change}
              </li>
            ))}
          </ul>
        ) : null}

        {review.blockingReason !== null ? (
          <Field label="Blocking reason" value={review.blockingReason} />
        ) : null}

        {review.evidence.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">Evidence</span>
            <ul className="ms-4 list-disc text-sm text-muted-foreground">
              {review.evidence.map((item) => (
                <li key={item} className="min-w-0 break-words">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Panel>
  );
});

/* --------------------------------------------------------------- details */

/**
 * Paths, pids, and adapter identities.
 *
 * Collapsed, and last. These are real and occasionally necessary, but a
 * filesystem path is never the headline — and keeping them behind a
 * disclosure is also what keeps them out of a screenshot taken for any other
 * reason.
 */
const TechnicalDetails = memo(function TechnicalDetails({ detail }: { detail: AgentRunDetail }) {
  const [open, setOpen] = useState(false);
  const nowMs = useNowMs(30_000);

  return (
    <section className="flex min-w-0 flex-col rounded-xl border bg-card px-3 py-2.5">
      <Button
        size="xs"
        variant="ghost"
        className="self-start"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Hide technical details" : "Technical details"}
      </Button>

      {open ? (
        <dl className="mt-2 grid min-w-0 grid-cols-1 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-[max-content_1fr]">
          <Detail label="Run id" value={detail.summary.id} mono />
          <Detail label="Work order" value={detail.summary.workOrderId} mono />
          <Detail label="Worker" value={detail.agents.worker} />
          <Detail label="Reviewer" value={detail.agents.reviewer} />
          <Detail label="Branch" value={detail.workspace.branch} mono />
          <Detail label="Base commit" value={detail.workspace.baseSha} mono />
          <Detail label="Worktree" value={detail.workspace.worktreePath} mono />
          <Detail label="Repository" value={detail.workspace.repositoryPath} mono />
          <Detail
            label="Run lock"
            value={
              detail.summary.process.lockHeld
                ? `pid ${detail.summary.process.pid} on ${detail.summary.process.hostname} (${detail.summary.process.lockState})`
                : "not held"
            }
          />
          {/*
            Attempts and provider executions are different facts, and the
            difference is exactly what made the old single number wrong. Both
            are shown here, against the base limit and the effective one.
          */}
          <Detail label="Worker attempts" value={`${detail.summary.executions.worker.attempts}`} />
          <Detail
            label="Worker provider executions"
            value={formatExecutionBudget(detail.summary.executions.worker)}
          />
          <Detail
            label="Reviewer attempts"
            value={`${detail.summary.executions.reviewer.attempts}`}
          />
          <Detail
            label="Reviewer provider executions"
            value={formatExecutionBudget(detail.summary.executions.reviewer)}
          />
          <Detail
            label="Base authorization"
            value={`worker ${detail.limits.maxWorkerExecutions ?? "—"}, reviewer ${
              detail.limits.maxReviewerExecutions ?? "—"
            }`}
          />
          <Detail
            label="Effective reviewer authorization"
            value={
              detail.summary.executions.reviewer.effectiveLimit === null
                ? "uncapped"
                : `${detail.summary.executions.reviewer.effectiveLimit}`
            }
          />
          <Detail label="Attention" value={detail.summary.attention.kind} />
          <Detail label="Last durable event seq" value={`${detail.summary.lastEventSeq}`} />
          <Detail
            label="Interruptions"
            value={`${detail.interruptions} (resumed ${detail.resumes}×)`}
          />
          <Detail label="Updated" value={formatRelative(detail.summary.updatedAt, nowMs)} />
          {detail.degraded.length > 0 ? (
            <Detail label="Evidence gaps" value={detail.degraded.join("; ")} />
          ) : null}
        </dl>
      ) : null}
    </section>
  );
});

function Detail({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  if (value === null) return null;
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 break-all text-foreground", mono && "font-mono")}>{value}</dd>
    </>
  );
}
