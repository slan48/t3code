import type {
  AgentRunCheck,
  AgentRunCycle,
  AgentRunDetail,
  AgentRunReview,
} from "@t3tools/contracts";
import { memo, useState } from "react";

import {
  describeActivity,
  elapsedMillis,
  formatDuration,
  formatRelative,
  QUIET_THRESHOLD_MS,
  quietMillis,
  toneToBadgeVariant,
} from "~/agentRunFormat";
import { useNowMs } from "~/hooks/useNowMs";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
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
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="truncate">{summary.project}</span>
          <span>
            Cycle {summary.currentCycle} / {summary.maxCycles}
          </span>
          <span>
            {summary.terminal ? "Ran" : "Running"}{" "}
            {formatDuration(elapsedMillis(summary.startedAt, summary.finishedAt, nowMs))}
          </span>
        </div>
      </header>

      {summary.humanRequired.present ? <HumanRequiredPanel detail={detail} /> : null}

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
        <CyclePanels key={cycle.number} cycle={cycle} />
      ))}

      <Panel title="Timeline">
        <AgentRunTimeline entries={detail.timeline} />
      </Panel>

      <TechnicalDetails detail={detail} />
    </div>
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

const CyclePanels = memo(function CyclePanels({ cycle }: { cycle: AgentRunCycle }) {
  const validationChecks = cycle.validation.flatMap((report) =>
    report.stage === "post_worker" || report.stage === "final" ? report.checks : [],
  );

  return (
    <>
      {validationChecks.length > 0 ? (
        <Panel title={`Validation · cycle ${cycle.number}`}>
          <div className="flex min-w-0 flex-col divide-y divide-border/50">
            {validationChecks.map((check) => (
              <CheckRow key={`${check.id}-${check.outcome}`} check={check} />
            ))}
          </div>
          {cycle.finalGate !== null ? (
            <div className="mt-2 border-t pt-2">
              <AgentRunPhaseRow
                label="Final gate"
                status={cycle.finalGate.passed ? "passed" : "failed"}
                detail={`${cycle.finalGate.checksRun.length} checks run`}
              />
              {cycle.finalGate.failures.map((failure) => (
                <CheckRow key={failure.id} check={failure} />
              ))}
            </div>
          ) : null}
        </Panel>
      ) : null}

      {cycle.review !== null ? (
        <ReviewPanel review={cycle.review} agentLabel={`cycle ${cycle.number}`} />
      ) : null}
    </>
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
          <Detail
            label="Executions"
            value={`worker ${detail.summary.workerExecutionCount}${
              detail.limits.maxWorkerExecutions === null
                ? ""
                : ` / ${detail.limits.maxWorkerExecutions}`
            }, reviewer ${detail.summary.reviewerExecutionCount}${
              detail.limits.maxReviewerExecutions === null
                ? ""
                : ` / ${detail.limits.maxReviewerExecutions}`
            }`}
          />
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
