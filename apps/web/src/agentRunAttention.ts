import type { AgentRunAttentionKind, AgentRunDetail, AgentRunSummary } from "@t3tools/contracts";

/**
 * Who has to do something, and what the operator should do about it.
 *
 * The classification itself is the server's — `summary.attention.kind` is
 * projected from the run's state and structured terminal reason. This module
 * only decides how to *say* it, and exists because "human input required"
 * covered three unrelated jobs: a product decision Sergio has to make, an
 * orchestration fault that needs an engineer, and a run that simply stopped.
 *
 * The guidance line is the important part. Every run detail answers "is
 * anything expected of me?" before the operator has read anything else.
 */

export interface AgentRunGuidance {
  /** Short verdict, e.g. `Action required — product decision`. */
  readonly headline: string;
  /** One sentence of what to do, or why nothing is needed. */
  readonly detail: string;
  readonly tone: "running" | "success" | "attention" | "failure" | "idle";
  /** True when a person is actively blocking the run. */
  readonly actionRequired: boolean;
}

export const ATTENTION_LABELS: Readonly<Record<AgentRunAttentionKind, string>> = {
  none: "No attention required",
  "product-decision": "Product decision required",
  "orchestrator-recovery": "Orchestrator recovery required",
  "run-failed": "Run failed",
};

/**
 * What this run expects of the operator right now.
 *
 * Driven by the projected classification, never by parsing prose. A completed
 * run and a still-running one both say "no action required" — but they say it
 * differently, because "it is still working" and "it is done" are different
 * reassurances.
 */
export function describeGuidance(summary: AgentRunSummary): AgentRunGuidance {
  switch (summary.attention.kind) {
    case "product-decision":
      return {
        headline: "Action required — product decision",
        detail:
          summary.attention.summary ||
          "This run is waiting on a product or authorization decision before it can continue.",
        tone: "attention",
        actionRequired: true,
      };
    case "orchestrator-recovery":
      return {
        headline: "Action required — orchestrator recovery",
        detail:
          summary.attention.summary ||
          "The orchestration infrastructure needs attention. This is not a product question.",
        tone: "attention",
        actionRequired: true,
      };
    case "run-failed":
      return {
        headline: "Run stopped — inspect failure evidence",
        detail:
          summary.attention.summary ||
          "The run stopped without completing. Nobody is blocking it; the evidence below explains why.",
        tone: "failure",
        actionRequired: false,
      };
    case "none":
      if (summary.state === "COMPLETED") {
        return {
          headline: "No action required",
          detail: "The run completed and its acceptance gate passed.",
          tone: "success",
          actionRequired: false,
        };
      }
      if (summary.terminal) {
        return {
          headline: "No action required",
          detail: "The run has finished.",
          tone: "idle",
          actionRequired: false,
        };
      }
      return {
        headline: "No action required — run continues automatically",
        detail: "The orchestrator is driving this run. It does not need anything from you.",
        tone: "running",
        actionRequired: false,
      };
  }
}

/**
 * Whether any agent is running, stated plainly and always.
 *
 * Asked on every run detail regardless of state, because "is something still
 * burning my subscription?" is the question an operator has when a run is not
 * obviously finished — and the answer must never be implied.
 */
export function describeAgentsRunning(detail: AgentRunDetail): string {
  const { summary } = detail;
  if (summary.process.inconsistent) {
    return "State claims an agent is running, but its process cannot be found";
  }
  if (summary.activeRole === "none" || summary.terminal) {
    return "No agents are currently running";
  }
  const who =
    summary.activeRole === "worker"
      ? detail.agents.worker
      : summary.activeRole === "reviewer"
        ? detail.agents.reviewer
        : summary.activeRole === "validation"
          ? "deterministic validation"
          : "the final acceptance gate";
  return summary.process.alive === true
    ? `${who} is running`
    : `${who} is the active phase (process liveness unknown)`;
}

/**
 * `2 / 2`, or `3` when the run was authorized without a ceiling.
 *
 * Reads provider executions against the *effective* limit — the Work Order's
 * ceiling plus any durable grant. Showing allocated attempts over the base
 * limit produced "4 / 2", which told the operator they had overrun an
 * authorization they had not.
 */
export function formatExecutionBudget(budget: {
  readonly providerExecutions: number;
  readonly effectiveLimit: number | null;
}): string {
  return budget.effectiveLimit === null
    ? `${budget.providerExecutions}`
    : `${budget.providerExecutions} / ${budget.effectiveLimit}`;
}

/**
 * The attempts-versus-executions footnote, when they differ.
 *
 * Only shown when there is something to explain: if every attempt ran a
 * provider, saying so twice is noise.
 */
export function describeAttemptGap(budget: {
  readonly providerExecutions: number;
  readonly attempts: number;
}): string | null {
  const refused = budget.attempts - budget.providerExecutions;
  if (refused <= 0) return null;
  return `${budget.attempts} attempts allocated · ${refused} refused before any process started`;
}
