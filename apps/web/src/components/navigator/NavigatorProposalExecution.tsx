/**
 * The Execute action and the child executions of one Execution Proposal.
 *
 * ONE COMPONENT, RENDERED TWICE. The proposal appears both in the conversation
 * timeline and in the Plan sidebar, and both need the same action — so it is
 * the same component reading the same per-proposal gate. Two visible buttons,
 * one intent, one RPC.
 *
 * Everything mutable about a child run is read from Peer Loop's structured run
 * summary. This card names the run, says what Peer Loop says it is doing, and
 * links to `/peer-loop/$runId`. It deliberately carries no pause, resume,
 * recovery, owner-approval or owner-message control: those need the run's live
 * control snapshot and belong in the advanced inspector, which is the one place
 * they are safe.
 *
 * @module NavigatorProposalExecution
 */
import { Link } from "@tanstack/react-router";
import type {
  EnvironmentId,
  OrchestrationPeerLoopExecution,
  ThreadId,
  ThreadPurpose,
} from "@t3tools/contracts";
import { memo, useCallback, useEffect, useRef } from "react";

import { cn } from "~/lib/utils";
import {
  compactRunId,
  describeExecution,
  executeProposalAvailability,
  showsExecutionArea,
  type ExecutableProposal,
  type NavigatorExecutionPresentation,
} from "~/navigatorExecution";
import {
  useNavigatorExecution,
  useNavigatorExecutionRuns,
} from "~/state/navigatorExecutionCommand";
import { Button } from "../ui/button";
import { PeerLoopPill } from "../peerLoop/PeerLoopPrimitives";

/**
 * What the conversation knows, handed down once.
 *
 * Assembled in `ChatView` and deliberately free of anything Peer Loop reports:
 * this object travels through the timeline's row context, and putting a
 * five-second poll in it would re-render every row in the conversation twelve
 * times a minute. Run summaries are read inside the card that needs them, where
 * the atom family gives every reader the same single query.
 */
export interface NavigatorExecutionContext {
  readonly environmentId: EnvironmentId;
  /** Null for a draft conversation: there is nothing durable to execute. */
  readonly threadId: ThreadId | null;
  readonly purpose: ThreadPurpose;
  readonly latestTurnSettled: boolean;
  readonly executionsByProposal: ReadonlyMap<string, ReadonlyArray<OrchestrationPeerLoopExecution>>;
}

const NO_EXECUTIONS: ReadonlyArray<OrchestrationPeerLoopExecution> = [];

export const NavigatorProposalExecution = memo(function NavigatorProposalExecution({
  context,
  proposal,
}: {
  readonly context: NavigatorExecutionContext;
  readonly proposal: ExecutableProposal;
}) {
  // The gate lives in the inner component, so a draft promoting to a durable
  // thread changes which component is mounted rather than how many hooks run.
  if (
    context.threadId === null ||
    !showsExecutionArea({ purpose: context.purpose, isDurableThread: true })
  ) {
    return null;
  }
  return (
    <ProposalExecutionArea context={context} threadId={context.threadId} proposal={proposal} />
  );
});

function ProposalExecutionArea({
  context,
  threadId,
  proposal,
}: {
  readonly context: NavigatorExecutionContext;
  readonly threadId: ThreadId;
  readonly proposal: ExecutableProposal;
}) {
  const { state, execute } = useNavigatorExecution({
    environmentId: context.environmentId,
    threadId,
    proposedPlanId: proposal.id,
  });
  const executions = context.executionsByProposal.get(proposal.id) ?? NO_EXECUTIONS;
  // NOTHING IS OBSERVED UNTIL THERE IS SOMETHING TO OBSERVE. A conversation
  // with no execution link issues no Peer Loop query at all, so opening one
  // cannot spawn the bridge on a machine that has never used it.
  const { runs, unreadable, refresh } = useNavigatorExecutionRuns({
    environmentId: context.environmentId,
    linkCount: executions.length,
  });
  const availability = executeProposalAvailability({
    purpose: context.purpose,
    isDurableThread: true,
    latestTurnSettled: context.latestTurnSettled,
    proposal,
    executionCount: executions.length,
    executing: state.pending,
  });

  const onExecute = useCallback(() => {
    void execute();
  }, [execute]);

  // A link appeared — this client just executed, or the read model caught up.
  // Re-read the summaries once so the child card is not blank until the next
  // poll. A re-read, never a second start.
  const executionCount = executions.length;
  const observedCount = useRef(executionCount);
  useEffect(() => {
    if (executionCount > observedCount.current) refresh();
    observedCount.current = executionCount;
  }, [executionCount, refresh]);

  const failure = state.failure;
  /*
   * A failure that may have left a run behind takes the action away.
   *
   * `link-not-confirmed` and a timeout both mean Peer Loop may already be
   * running this proposal, and offering an Execute button directly beside "do
   * not press this again" is an invitation to fork the Reviewer's session. The
   * inspector link in the notice is the way forward from here.
   */
  const showsAction =
    (availability.canExecute && failure?.mayHaveStarted !== true) ||
    availability.blockedReason === "executing";
  if (!showsAction && failure === null && executions.length === 0) return null;

  return (
    <div className="mt-4 flex min-w-0 flex-col gap-3 border-t border-border/60 pt-4">
      {showsAction ? (
        <div className="flex min-w-0 flex-col gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            disabled={state.pending}
            onClick={onExecute}
          >
            {state.pending ? "Starting…" : "Execute with Peer Loop"}
          </Button>
          {/*
            The press is the confirmation. Nothing in this increment reads
            agreement out of the conversation, and the wording says which plan
            is about to be handed over so there is no ambiguity about it.
          */}
          <p className="text-xs text-muted-foreground">
            Starts Peer Loop&apos;s Reviewer → Builder workflow in this project, using the Execution
            Proposal above. Pressing this is the confirmation; Navigator never infers it from the
            conversation.
          </p>
        </div>
      ) : null}

      {failure === null ? null : (
        <div
          role="alert"
          className={cn(
            "flex min-w-0 flex-col gap-1 rounded-md border px-3 py-2 text-sm",
            failure.presentation.tone === "danger" ? "border-destructive/40" : "border-warning/40",
          )}
        >
          <p className="font-medium">{failure.presentation.title}</p>
          {failure.presentation.detail === null ? null : (
            <p className="text-xs text-muted-foreground">{failure.presentation.detail}</p>
          )}
          {failure.presentation.code === null ? null : (
            <p className="font-mono text-xs break-all text-muted-foreground">
              {failure.presentation.code}
            </p>
          )}
          {failure.inspectorRunId === null ? null : (
            <Link
              to="/peer-loop/$runId"
              params={{ runId: failure.inspectorRunId }}
              className="font-mono text-xs break-all underline underline-offset-2"
            >
              {failure.inspectorRunId}
            </Link>
          )}
        </div>
      )}

      {executions.length === 0 ? null : (
        <ul className="flex min-w-0 flex-col gap-2">
          {executions.map((link) => (
            <li key={`${link.proposedPlanId}:${link.runId}`} className="min-w-0">
              <NavigatorExecutionCard
                presentation={describeExecution({ link, runs, unreadable })}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One child execution.
 *
 * A run with no summary in the list is reported as unavailable rather than
 * given a lifecycle state: T3 Code not being able to see a run says nothing
 * about whether it is working, finished or failed, and choosing between those
 * would be an invention.
 */
export const NavigatorExecutionCard = memo(function NavigatorExecutionCard({
  presentation,
}: {
  readonly presentation: NavigatorExecutionPresentation;
}) {
  const { status } = presentation;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-border/70 px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-mono text-xs break-all text-muted-foreground">
          {compactRunId(presentation.runId)}
        </span>
        {status.kind === "summary" ? (
          <PeerLoopPill label={status.attention.label} tone={status.attention.tone} />
        ) : (
          <PeerLoopPill
            label={status.kind === "unreadable" ? "Record unreadable" : "Status unavailable"}
            tone="neutral"
          />
        )}
      </div>

      {status.kind === "summary" ? (
        <>
          <p className="text-xs text-muted-foreground tabular-nums">
            Iteration {status.iteration} · updated {status.updatedAt}
            {status.queuedOwnerMessages > 0
              ? ` · ${status.queuedOwnerMessages} message(s) queued`
              : ""}
          </p>
          {status.attention.detail === null ? null : (
            <p className="text-xs text-muted-foreground">{status.attention.detail}</p>
          )}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          {status.kind === "unreadable"
            ? "Peer Loop could not read this run's record."
            : "Peer Loop is not reporting this run right now. Nothing is assumed about it."}
        </p>
      )}

      {/*
        The link out, and only the link. Pause, resume, recovery and owner
        approval need the run's live control snapshot; duplicating them here
        would offer controls this card cannot know Peer Loop would accept.
      */}
      <Link
        to="/peer-loop/$runId"
        params={{ runId: presentation.runId }}
        className="self-start text-xs underline underline-offset-2"
      >
        Open execution details
      </Link>
    </div>
  );
});
