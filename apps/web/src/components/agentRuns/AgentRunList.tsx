import type { AgentRunSummary, AgentRunsListResult } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon, TerminalIcon } from "lucide-react";
import { memo } from "react";

import { describeActivity, describeHeadline, formatRelative } from "~/agentRunFormat";
import { ORCHESTRATOR_HOME_ENV_HINT } from "~/agentRunHints";
import { cn } from "~/lib/utils";
import { useNowMs } from "~/hooks/useNowMs";
import { AgentRunProcessLine, AgentRunStatePill } from "./AgentRunPrimitives";

/**
 * The run list.
 *
 * A stack of cards rather than a table: this is read as often on a phone over
 * Tailscale as on a desktop, and a table of eight columns is unreadable on
 * either when the important part is "which of these needs me".
 */
export const AgentRunList = memo(function AgentRunList({ data }: { data: AgentRunsListResult }) {
  const nowMs = useNowMs(1_000);

  if (!data.configured) {
    return <NotConfigured />;
  }

  const active = data.runs.filter((run) => !run.terminal);
  const finished = data.runs.filter((run) => run.terminal);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {data.runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No runs recorded yet.</p>
      ) : null}

      {active.length > 0 ? (
        <Section title="Active">
          {active.map((run) => (
            <AgentRunCard key={run.id} run={run} nowMs={nowMs} />
          ))}
        </Section>
      ) : null}

      {finished.length > 0 ? (
        <Section title="Recent">
          {finished.map((run) => (
            <AgentRunCard key={run.id} run={run} nowMs={nowMs} />
          ))}
        </Section>
      ) : null}

      {data.unreadable.length > 0 ? (
        <Section title="Unreadable">
          {/*
            Never silently dropped. A run whose artifacts will not parse is a
            gap in the operator's picture, and hiding it would make the list
            look complete when it is not.
          */}
          {data.unreadable.map((entry) => (
            <div
              key={entry.id}
              className="rounded-xl border border-dashed px-3 py-2.5 text-xs text-muted-foreground"
            >
              <span className="font-mono">{entry.id}</span>
              <span className="ms-2">{entry.reason}</span>
            </div>
          ))}
        </Section>
      ) : null}
    </div>
  );
});

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h2 className="px-0.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      <div className="flex min-w-0 flex-col gap-2">{children}</div>
    </section>
  );
}

const AgentRunCard = memo(function AgentRunCard({
  run,
  nowMs,
}: {
  run: AgentRunSummary;
  nowMs: number;
}) {
  const activity = describeActivity(run.activity, nowMs);
  const updated = formatRelative(run.updatedAt, nowMs);

  return (
    <Link
      to="/agent-runs/$runId"
      params={{ runId: run.id }}
      className={cn(
        "group flex min-w-0 items-start gap-3 rounded-xl border bg-card px-3 py-3 text-start outline-none transition-colors",
        "hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring",
        // Comfortable to hit with a thumb; the whole card is the target.
        "min-h-16",
        run.attentionRequired && "border-warning/40 bg-warning/4",
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">{run.title}</span>
          <AgentRunStatePill state={run.state} />
        </div>

        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className="truncate">{run.project}</span>
          <span>
            Cycle {run.currentCycle} / {run.maxCycles}
          </span>
          <span className="truncate">{describeHeadline(run, nowMs)}</span>
        </div>

        {activity.map((line) => (
          <span key={line} className="min-w-0 break-words text-xs text-muted-foreground">
            {line}
          </span>
        ))}

        {!run.terminal ? <AgentRunProcessLine process={run.process} /> : null}

        {run.humanRequired.present && run.humanRequired.summary !== null ? (
          <p className="mt-0.5 line-clamp-2 min-w-0 text-xs text-warning-foreground">
            {run.humanRequired.summary}
          </p>
        ) : null}

        {updated !== null ? (
          <span className="text-[0.6875rem] text-muted-foreground/80">Updated {updated}</span>
        ) : null}
      </div>

      <ChevronRightIcon className="mt-1 size-4 shrink-0 text-muted-foreground/60" />
    </Link>
  );
});

function NotConfigured() {
  return (
    <div className="flex min-w-0 flex-col items-start gap-3 rounded-xl border border-dashed px-4 py-6">
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <TerminalIcon className="size-4" />
        No orchestrator home configured
      </div>
      <p className="max-w-prose text-sm text-muted-foreground">
        T3Code observes an <code className="font-mono text-xs">agent-orchestrator</code> home
        read-only. Point the server at one and reopen this page.
      </p>
      <code className="min-w-0 overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs">
        {ORCHESTRATOR_HOME_ENV_HINT}
      </code>
    </div>
  );
}
