import type { PeerLoopListRunsResult, PeerLoopStatusResult } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { memo } from "react";

import { formatRelative } from "~/agentRunFormat";
import {
  describeRunAttention,
  describeTransport,
  groupRuns,
  projectLabel,
} from "~/peerLoopPresentation";
import { PeerLoopPill, PeerLoopSection } from "./PeerLoopPrimitives";

/**
 * The Peer Loop index.
 *
 * A stack of cards, mobile-first, in the same shape as Agent Runs — which this
 * deliberately does not merge with. Agent Runs observes durable files that T3
 * Code wrote; Peer Loop is a separate tool driven over a protocol, and folding
 * the two lists together would suggest they are the same kind of thing.
 */
export const PeerLoopIndexView = memo(function PeerLoopIndexView({
  status,
  runs,
  startRun,
}: {
  readonly status: PeerLoopStatusResult;
  readonly runs: PeerLoopListRunsResult;
  readonly startRun: React.ReactNode;
}) {
  const transport = describeTransport(status.transport, status.configured);
  const groups = groupRuns(runs.runs);
  const nowMs = Date.now();

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <div className="flex min-w-0 flex-col gap-1 rounded-lg border px-3 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <PeerLoopPill label={transport.label} tone={transport.tone} />
          {status.health === null ? null : (
            <span className="text-xs text-muted-foreground">
              protocol {status.health.protocolVersion}
            </span>
          )}
        </div>
        {transport.detail === null ? null : (
          <p className="break-words text-xs text-muted-foreground">{transport.detail}</p>
        )}
        {status.configured ? null : (
          <p className="text-xs text-muted-foreground">
            Install Peer Loop on the machine running this server, or point T3 Code at it with
            <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono">
              T3_PEER_LOOP_EXECUTABLE
            </code>
            . Nothing about this can be set from here.
          </p>
        )}
      </div>

      {startRun}

      {runs.runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Peer Loop runs on this machine yet.</p>
      ) : null}

      {groups.attention.length > 0 ? (
        <PeerLoopSection title="Needs you" count={groups.attention.length}>
          {groups.attention.map((run) => (
            <PeerLoopRunCard key={run.runId} run={run} nowMs={nowMs} />
          ))}
        </PeerLoopSection>
      ) : null}

      {groups.active.length > 0 ? (
        <PeerLoopSection title="Active" count={groups.active.length}>
          {groups.active.map((run) => (
            <PeerLoopRunCard key={run.runId} run={run} nowMs={nowMs} />
          ))}
        </PeerLoopSection>
      ) : null}

      {groups.recent.length > 0 ? (
        <PeerLoopSection title="Recent" count={groups.recent.length}>
          {groups.recent.map((run) => (
            <PeerLoopRunCard key={run.runId} run={run} nowMs={nowMs} />
          ))}
        </PeerLoopSection>
      ) : null}

      {runs.unreadable.length > 0 ? (
        <PeerLoopSection title="Unreadable" count={runs.unreadable.length}>
          {/*
            Never dropped quietly. A run Peer Loop could not read is a hole in
            the operator's picture, and a list that hid it would look complete
            when it is not.
          */}
          {runs.unreadable.map((runId) => (
            <div key={runId} className="rounded-lg border border-dashed px-3 py-2 text-sm">
              <span className="font-mono text-xs break-all">{runId}</span>
              <p className="text-xs text-muted-foreground">
                Peer Loop could not read this run&apos;s record.
              </p>
            </div>
          ))}
        </PeerLoopSection>
      ) : null}
    </div>
  );
});

const PeerLoopRunCard = memo(function PeerLoopRunCard({
  run,
  nowMs,
}: {
  readonly run: import("@t3tools/contracts").PeerLoopRunSummary;
  readonly nowMs: number;
}) {
  const attention = describeRunAttention(run);
  const updated = formatRelative(run.updatedAt, nowMs);

  return (
    <Link
      to="/peer-loop/$runId"
      params={{ runId: run.runId }}
      className="flex min-w-0 items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-accent/50"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {projectLabel(run.projectPath)}
          </span>
          <PeerLoopPill label={attention.label} tone={attention.tone} />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          <span>iteration {run.iteration}</span>
          {updated === null ? null : <span>· {updated}</span>}
          {run.queuedOwnerMessages > 0 ? (
            <span>· {run.queuedOwnerMessages} queued message(s)</span>
          ) : null}
          {run.liveWriter !== null && !run.liveInThisBridge ? (
            <span>· driven by another process</span>
          ) : null}
        </div>
        {attention.detail === null ? null : (
          <p className="line-clamp-2 text-xs break-words text-muted-foreground">
            {attention.detail}
          </p>
        )}
      </div>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
    </Link>
  );
});
