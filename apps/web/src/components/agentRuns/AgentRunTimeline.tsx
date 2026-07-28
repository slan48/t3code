import type { AgentRunTimelineEntry } from "@t3tools/contracts";
import { memo } from "react";

import { cn } from "~/lib/utils";
import { ToneIcon, toneTextClass } from "./AgentRunPrimitives";

/**
 * The run's history, as durable facts on a clock.
 *
 * Every row came from something the orchestrator wrote down — a run event, an
 * attempt journal entry, a validation artifact, a reviewer verdict. Nothing is
 * interpolated to make the sequence look continuous, so a gap on this timeline
 * is a real gap and worth noticing.
 *
 * Times are wall-clock and local. Relative times ("4m ago") are right for a
 * card you glance at; a timeline is read by scanning down a column, and a
 * column of shifting relative offsets is much harder to follow than a column
 * of fixed clock times.
 */
export const AgentRunTimeline = memo(function AgentRunTimeline({
  entries,
}: {
  entries: readonly AgentRunTimelineEntry[];
}) {
  if (entries.length === 0) {
    return <p className="py-1 text-sm text-muted-foreground">No recorded events yet.</p>;
  }

  // Two facts can legitimately share a timestamp, a source, and a title — two
  // identical checks in different cycles, say — so identity is disambiguated
  // by occurrence rather than by list position, which would shuffle keys
  // whenever an earlier entry appears.
  const seen = new Map<string, number>();
  const keyed = entries.map((entry) => {
    const base = `${entry.at}|${entry.source}|${entry.kind}|${entry.cycle ?? "-"}|${entry.title}`;
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return { entry, key: `${base}#${occurrence}` };
  });

  return (
    <ol className="flex min-w-0 flex-col">
      {keyed.map(({ entry, key }) => (
        <li key={key} className="flex min-w-0 items-start gap-2.5 py-1">
          <time
            className="w-[4.5rem] shrink-0 pt-0.5 font-mono text-[0.6875rem] text-muted-foreground tabular-nums"
            dateTime={entry.at}
          >
            {formatClock(entry.at)}
          </time>
          <ToneIcon
            tone={entry.tone === "neutral" ? "idle" : entry.tone}
            className={cn(
              "mt-0.5 size-3 shrink-0",
              toneTextClass(entry.tone === "neutral" ? "idle" : entry.tone),
            )}
          />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="min-w-0 break-words text-sm text-foreground">{entry.title}</span>
            {entry.detail !== null ? (
              <span className="min-w-0 break-words text-xs text-muted-foreground">
                {entry.detail}
              </span>
            ) : null}
          </div>
          {entry.cycle !== null ? (
            <span className="shrink-0 pt-0.5 text-[0.6875rem] text-muted-foreground/70">
              c{entry.cycle}
            </span>
          ) : null}
        </li>
      ))}
    </ol>
  );
});

function formatClock(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "--:--";
  const date = new Date(parsed);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(
    date.getSeconds(),
  ).padStart(2, "0")}`;
}
