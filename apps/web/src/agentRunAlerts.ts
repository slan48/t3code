import type { AgentRunSummary } from "@t3tools/contracts";
import { agentRunStateLabel } from "@t3tools/contracts";

/**
 * Which agent runs still owe the operator a look, and what to say about them.
 *
 * Acknowledgement lives entirely in T3Code. The orchestrator's history is a
 * record of what the engine did; whether a human has glanced at a browser tab
 * is not part of that record, and writing it there would be rewriting history
 * to store a UI preference.
 *
 * A run is keyed by `id` *and* terminal state, so a run that goes
 * `HUMAN_REQUIRED` → (operator resumes it from a terminal) → `FAILED` alerts
 * again. Acknowledging is a statement about a specific outcome, not a
 * permanent mute on the run.
 */

export const AGENT_RUN_ACK_STORAGE_KEY = "t3code:agent-run-acknowledgements:v1";

export interface AgentRunAlert {
  readonly key: string;
  readonly runId: string;
  readonly title: string;
  readonly message: string;
  readonly tone: "success" | "attention" | "failure";
}

export function acknowledgementKey(run: { readonly id: string; readonly state: string }): string {
  return `${run.id}::${run.state}`;
}

/**
 * The runs that should raise an in-app alert right now.
 *
 * Deliberately derived from current state rather than from a transition the
 * client happened to witness: T3Code may have been closed when the run
 * finished, and "I was not watching" must not mean "I never find out".
 */
/**
 * How many toasts may be raised at once.
 *
 * Opening T3Code after a week away should not bury the app under a stack of
 * notifications. Past this point the badge carries the count and the run list
 * carries the detail, which is a better way to read six outcomes than six
 * toasts competing for the same corner of the screen.
 */
export const MAX_CONCURRENT_ALERTS = 3;

export function pendingAgentRunAlerts(
  runs: readonly AgentRunSummary[],
  acknowledged: readonly string[],
): readonly AgentRunAlert[] {
  const seen = new Set(acknowledged);
  const alerts: AgentRunAlert[] = [];
  for (const run of runs) {
    if (alerts.length >= MAX_CONCURRENT_ALERTS) break;
    if (!run.terminal && run.state !== "RECOVERY_REQUIRED") continue;
    const key = acknowledgementKey(run);
    if (seen.has(key)) continue;
    alerts.push({
      key,
      runId: run.id,
      title: run.title,
      message: alertMessage(run),
      tone: run.state === "COMPLETED" ? "success" : alertTone(run.state),
    });
  }
  return alerts;
}

function alertTone(state: AgentRunSummary["state"]): "attention" | "failure" {
  return state === "FAILED" || state === "TIMED_OUT" ? "failure" : "attention";
}

function alertMessage(run: AgentRunSummary): string {
  switch (run.state) {
    case "COMPLETED":
      return "completed";
    case "HUMAN_REQUIRED":
      return "needs your input";
    case "RECOVERY_REQUIRED":
      return "needs recovery";
    case "MAX_CYCLES_REACHED":
      return "reached its cycle limit and needs review";
    case "FAILED":
      return "failed";
    case "TIMED_OUT":
      return "timed out";
    default:
      return agentRunStateLabel(run.state).toLowerCase();
  }
}

/**
 * The sidebar badge count.
 *
 * Counts only unacknowledged runs that are actually asking for something —
 * a completed run is worth one toast, not a permanent number next to the nav
 * entry.
 */
export function agentRunBadgeCount(
  runs: readonly AgentRunSummary[],
  acknowledged: readonly string[],
): number {
  const seen = new Set(acknowledged);
  return runs.filter((run) => run.attentionRequired && !seen.has(acknowledgementKey(run))).length;
}

/** Keep the acknowledgement list from growing without bound. */
export const MAX_ACKNOWLEDGEMENTS = 200;

export function withAcknowledgement(
  acknowledged: readonly string[],
  key: string,
): readonly string[] {
  if (acknowledged.includes(key)) return acknowledged;
  return [...acknowledged, key].slice(-MAX_ACKNOWLEDGEMENTS);
}
