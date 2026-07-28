import type { AgentRunActivity, AgentRunProcess, AgentRunSummary } from "@t3tools/contracts";

/**
 * Turning evidence into sentences an operator can act on.
 *
 * The rule that shapes every function here: say what is known, name where it
 * came from, and never round an absence up into a claim. "Running 11m, last
 * durable event 42s ago" is useful. "73% complete, ETA 8 minutes" would be a
 * fabrication, and so would "Claude is thinking about the database".
 */

/** `07m 31s`, `1h 12m`, `48s`. Elapsed time, never an estimate of remaining. */
export function formatDuration(millis: number): string {
  if (!Number.isFinite(millis) || millis < 0) return "—";
  const totalSeconds = Math.floor(millis / 1000);
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (totalMinutes > 0)
    return `${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** `43m ago`, `just now`. Returns null when there is no timestamp to describe. */
export function formatRelative(iso: string | null, nowMs: number): string | null {
  if (iso === null) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const delta = nowMs - then;
  if (delta < 0) return "just now";
  if (delta < 10_000) return "just now";
  return `${formatDuration(delta)} ago`;
}

export function elapsedMillis(startIso: string, endIso: string | null, nowMs: number): number {
  const start = Date.parse(startIso);
  if (!Number.isFinite(start)) return 0;
  const end = endIso === null ? nowMs : Date.parse(endIso);
  return Math.max(0, (Number.isFinite(end) ? end : nowMs) - start);
}

/**
 * What the process block should say out loud.
 *
 * Three outcomes only, and the third is the one that matters: a run whose
 * snapshot claims an agent is working while its owner is provably gone. That
 * is stated as a contradiction rather than smoothed into "running", because
 * smoothing it is what made two earlier failures invisible.
 */
export function describeProcess(process: AgentRunProcess): {
  readonly label: string;
  readonly tone: "running" | "attention" | "idle";
} {
  if (process.inconsistent) {
    return { label: "Process not found — state still reports an agent running", tone: "attention" };
  }
  if (!process.lockHeld) {
    return { label: "No agent is running", tone: "idle" };
  }
  if (process.alive === true) {
    return {
      label: process.detached === true ? "Process alive (detached)" : "Process alive",
      tone: "running",
    };
  }
  if (process.alive === false) {
    return { label: "Process has exited", tone: "idle" };
  }
  return {
    label: process.sameHost
      ? "Process liveness unknown"
      : "Held on another host — liveness unknown",
    tone: "idle",
  };
}

const ACTIVITY_SOURCE_LABELS: Readonly<Record<string, string>> = {
  event: "durable event",
  "attempt-journal": "attempt journal",
  "attempt-stream": "agent output",
  "run-snapshot": "run snapshot",
};

/**
 * The activity line under a running agent.
 *
 * Deliberately separates *alive* from *progressing*. A process can be alive
 * and silent for six minutes, and saying so plainly is far better than an
 * animation that implies motion nobody can evidence.
 */
export function describeActivity(activity: AgentRunActivity, nowMs: number): readonly string[] {
  const lines: string[] = [];
  const relative = formatRelative(activity.lastActivityAt, nowMs);
  if (relative === null) {
    lines.push("No durable activity recorded yet");
  } else {
    const source = activity.lastActivitySource;
    const suffix = source === null ? "" : ` (${ACTIVITY_SOURCE_LABELS[source] ?? source})`;
    lines.push(`Last durable activity ${relative}${suffix}`);
  }
  if (activity.filesChanged !== null) {
    lines.push(
      `${activity.filesChanged} file${activity.filesChanged === 1 ? "" : "s"} changed` +
        (activity.filesChangedSource === "workspace-probe" ? " (live)" : ""),
    );
  }
  return lines;
}

/** How long since anything durable happened, in ms, or null if never. */
export function quietMillis(activity: AgentRunActivity, nowMs: number): number | null {
  if (activity.lastActivityAt === null) return null;
  const then = Date.parse(activity.lastActivityAt);
  if (!Number.isFinite(then)) return null;
  return Math.max(0, nowMs - then);
}

/** Quiet long enough to be worth saying so explicitly. */
export const QUIET_THRESHOLD_MS = 5 * 60_000;

/**
 * The one-line headline for a run card.
 *
 * Answers "who is working, and for how long" for an active run, and "how did
 * it end" for a finished one.
 */
export function describeHeadline(run: AgentRunSummary, nowMs: number): string {
  if (run.terminal) {
    const at = formatRelative(run.finishedAt ?? run.updatedAt, nowMs);
    return at === null ? "Finished" : `Finished ${at}`;
  }
  const elapsed = formatDuration(elapsedMillis(run.startedAt, null, nowMs));
  switch (run.activeRole) {
    case "worker":
      return `Claude · cycle ${run.currentCycle} · ${elapsed}`;
    case "reviewer":
      return `Codex · cycle ${run.currentCycle} · ${elapsed}`;
    case "validation":
      return `Validation · cycle ${run.currentCycle} · ${elapsed}`;
    case "final_validation":
      return `Final validation · ${elapsed}`;
    case "none":
      return `Idle · ${elapsed}`;
  }
}

/** Badge/pill variant for a tone, matching the shared UI kit's vocabulary. */
export function toneToBadgeVariant(
  tone: "running" | "success" | "attention" | "failure" | "idle",
): "info" | "success" | "warning" | "error" | "secondary" {
  switch (tone) {
    case "running":
      return "info";
    case "success":
      return "success";
    case "attention":
      return "warning";
    case "failure":
      return "error";
    case "idle":
      return "secondary";
  }
}

export function phaseStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "Pending";
    case "running":
      return "Running";
    case "passed":
      return "Passed";
    case "failed":
      return "Failed";
    case "escalated":
      return "Escalated";
    case "rework":
      return "Rework requested";
    case "skipped":
      return "Not run";
    default:
      return "Unknown";
  }
}

export function phaseStatusTone(
  status: string,
): "running" | "success" | "attention" | "failure" | "idle" {
  switch (status) {
    case "running":
      return "running";
    case "passed":
      return "success";
    case "failed":
      return "failure";
    case "escalated":
    case "rework":
      return "attention";
    default:
      return "idle";
  }
}
