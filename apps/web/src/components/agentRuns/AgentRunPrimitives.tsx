import type { AgentRunProcess, AgentRunState } from "@t3tools/contracts";
import { agentRunStateLabel, agentRunStateTone } from "@t3tools/contracts";
import { AlertTriangleIcon, CheckIcon, CircleIcon, LoaderIcon, XIcon } from "lucide-react";
import { memo } from "react";

import {
  describeProcess,
  phaseStatusLabel,
  phaseStatusTone,
  toneToBadgeVariant,
} from "~/agentRunFormat";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";

/**
 * Shared vocabulary for the agent-run surfaces.
 *
 * One state maps to one label, one tone, and one icon everywhere it appears,
 * so an operator learns the language once. The raw state travels alongside the
 * label in a title attribute rather than being replaced by it — the friendly
 * word is for reading at a glance, the engine's word is for talking to the
 * orchestrator afterwards.
 */

export const AgentRunStatePill = memo(function AgentRunStatePill({
  state,
  className,
}: {
  state: AgentRunState;
  className?: string;
}) {
  const tone = agentRunStateTone(state);
  return (
    <Badge variant={toneToBadgeVariant(tone)} className={cn("gap-1", className)} title={state}>
      <ToneIcon tone={tone} />
      {agentRunStateLabel(state)}
    </Badge>
  );
});

export function ToneIcon({
  tone,
  className,
}: {
  tone: "running" | "success" | "attention" | "failure" | "idle";
  className?: string;
}) {
  switch (tone) {
    case "running":
      return <LoaderIcon className={cn("animate-spin motion-reduce:animate-none", className)} />;
    case "success":
      return <CheckIcon className={className} />;
    case "attention":
      return <AlertTriangleIcon className={className} />;
    case "failure":
      return <XIcon className={className} />;
    case "idle":
      return <CircleIcon className={className} />;
  }
}

/**
 * One row of the phase stack: worker, validation, reviewer, final gate.
 *
 * A stack of named phases rather than a progress bar, because there is no
 * honest percentage to show — the engine knows which phase it is in, and knows
 * nothing at all about how much of it remains.
 */
export const AgentRunPhaseRow = memo(function AgentRunPhaseRow({
  label,
  status,
  detail,
}: {
  label: string;
  status: string;
  detail?: string | null;
}) {
  const tone = phaseStatusTone(status);
  return (
    <div className="flex min-w-0 items-start gap-2.5 py-1.5">
      <ToneIcon tone={tone} className={cn("mt-0.5 size-4 shrink-0", toneTextClass(tone))} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium text-foreground">{label}</span>
          <span className={cn("text-xs", toneTextClass(tone))}>{phaseStatusLabel(status)}</span>
        </div>
        {detail ? (
          <span className="min-w-0 break-words text-xs text-muted-foreground">{detail}</span>
        ) : null}
      </div>
    </div>
  );
});

export function toneTextClass(
  tone: "running" | "success" | "attention" | "failure" | "idle",
): string {
  switch (tone) {
    case "running":
      return "text-info-foreground";
    case "success":
      return "text-success-foreground";
    case "attention":
      return "text-warning-foreground";
    case "failure":
      return "text-destructive-foreground";
    case "idle":
      return "text-muted-foreground";
  }
}

/**
 * Process liveness, stated separately from progress.
 *
 * "Alive" and "moving" are different claims with different evidence, and the
 * UI never lets one stand in for the other.
 */
export const AgentRunProcessLine = memo(function AgentRunProcessLine({
  process,
}: {
  process: AgentRunProcess;
}) {
  const { label, tone } = describeProcess(process);
  return (
    <div className={cn("flex items-center gap-1.5 text-xs", toneTextClass(tone))}>
      <ToneIcon tone={tone} className="size-3 shrink-0" />
      <span className="min-w-0 break-words">{label}</span>
    </div>
  );
});
