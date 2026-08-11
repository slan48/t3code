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
  describeExecutionDetail,
  executeProposalAvailability,
  executionSnapshotIsUseful,
  inspectorTargetFor,
  showsExecutionArea,
  type ExecutableProposal,
  type NavigatorExecutionDetail,
  type NavigatorExecutionFailure,
  type NavigatorExecutionPresentation,
} from "~/navigatorExecution";
import {
  useNavigatorExecution,
  useNavigatorExecutionRuns,
  useNavigatorExecutionSnapshot,
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
    // What the last attempt left behind, not merely whether it might have
    // started something: an already-executed refusal started nothing here and
    // still must not re-offer Execute.
    lastAttemptDisposition: state.failure?.disposition ?? null,
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
   * `link-not-confirmed`, a timeout, and every unclassified transport failure
   * all mean Peer Loop may already be running this proposal. Offering an
   * Execute button directly beside that warning is an invitation to fork the
   * Reviewer's session; the inspector link in the notice is the way forward.
   * `executeProposalAvailability` already refuses these, so this is the same
   * answer read off the reason it gave.
   */
  const showsAction = availability.canExecute || availability.blockedReason === "executing";
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
          <FailureInspectorLink failure={failure} />
        </div>
      )}

      {executions.length === 0 ? null : (
        <ul className="flex min-w-0 flex-col gap-2">
          {executions.map((link) => (
            <li key={`${link.proposedPlanId}:${link.runId}`} className="min-w-0">
              <NavigatorExecutionChild
                environmentId={context.environmentId}
                presentation={describeExecution({ link, runs, unreadable, nowMs: Date.now() })}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Where a failed Execute sends the owner.
 *
 * A named run when there is one; otherwise, for anything that may have started
 * a run, the inspector index — "go and see whether one exists" is the only
 * honest instruction when T3 Code cannot say. A failure that provably started
 * nothing links nowhere.
 */
const FailureInspectorLink = memo(function FailureInspectorLink({
  failure,
}: {
  readonly failure: NavigatorExecutionFailure;
}) {
  const target = inspectorTargetFor(failure);
  if (target.kind === "none") return null;
  if (target.kind === "run") {
    return (
      <Link
        to="/peer-loop/$runId"
        params={{ runId: target.runId }}
        className="font-mono text-xs break-all underline underline-offset-2"
      >
        {target.runId}
      </Link>
    );
  }
  return (
    <Link to="/peer-loop" className="text-xs underline underline-offset-2">
      Check Peer Loop for a new run
    </Link>
  );
});

/**
 * One child execution, with its structured snapshot if it has one worth reading.
 *
 * The snapshot hook lives here rather than in the list above so each execution
 * owns exactly one, and so an ordinary working run mounts an atom that queries
 * nothing at all.
 */
const NavigatorExecutionChild = memo(function NavigatorExecutionChild({
  environmentId,
  presentation,
}: {
  readonly environmentId: EnvironmentId;
  readonly presentation: NavigatorExecutionPresentation;
}) {
  const wanted = executionSnapshotIsUseful(presentation.status);
  const snapshot = useNavigatorExecutionSnapshot({
    environmentId,
    runId: presentation.runId,
    wanted,
    // Peer Loop's own `updatedAt`. A change to it is the only thing that
    // re-reads the snapshot; nothing polls and nothing watches activity.
    revision: presentation.status.kind === "summary" ? presentation.status.updatedAt : null,
  });
  const detail = describeExecutionDetail({ status: presentation.status, snapshot });
  return <NavigatorExecutionCard presentation={presentation} detail={detail} />;
});

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
  detail = NO_DETAIL,
}: {
  readonly presentation: NavigatorExecutionPresentation;
  readonly detail?: NavigatorExecutionDetail;
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
            Iteration {status.iteration}
            {status.updatedLabel === null ? "" : ` · updated ${status.updatedLabel}`}
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

      <NavigatorExecutionDetailBlock detail={detail} />

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
        {detail.kind === "owner-required" || detail.kind === "owner-required-missing"
          ? "Review and respond in execution details"
          : "Open execution details"}
      </Link>
    </div>
  );
});

const NO_DETAIL: NavigatorExecutionDetail = { kind: "none" };

/**
 * The structured paragraph under a child execution's status line.
 *
 * Peer Loop's own `lastReviewerDecision`, through the same helpers the advanced
 * inspector uses. Nothing here is read from a Builder report, a Builder task, a
 * prompt or the activity feed, and the run-list status above is never softened
 * by what this block cannot find.
 */
const NavigatorExecutionDetailBlock = memo(function NavigatorExecutionDetailBlock({
  detail,
}: {
  readonly detail: NavigatorExecutionDetail;
}) {
  if (detail.kind === "none") return null;

  if (detail.kind === "loading") {
    return <p className="text-xs text-muted-foreground">Reading the structured details…</p>;
  }

  if (detail.kind === "unavailable") {
    // Only the extra detail is missing. The status above came from the run
    // list and stands exactly as it did.
    return (
      <p className="text-xs text-muted-foreground">
        Additional structured details are unavailable right now.
      </p>
    );
  }

  if (detail.kind === "completion-missing") {
    return (
      <p className="text-xs text-muted-foreground">
        Peer Loop reports this run as done and recorded no structured completion summary.
      </p>
    );
  }

  if (detail.kind === "completion") {
    return (
      <div className="flex min-w-0 flex-col gap-1 rounded-md bg-muted/40 px-2.5 py-2">
        {detail.completion.summary === null ? null : (
          <p className="text-xs text-foreground">{detail.completion.summary}</p>
        )}
        {detail.completion.finalState === null ? null : (
          <p className="text-xs text-muted-foreground">
            Final state: {detail.completion.finalState}
          </p>
        )}
        {/*
          Peer Loop's own recorded HEAD. No commit list is invented and no git
          history is walked from the browser to produce one.
        */}
        {detail.head === null ? null : (
          <p className="font-mono text-xs break-all text-muted-foreground">
            HEAD {detail.head}
            {detail.branch === null ? "" : ` · ${detail.branch}`}
          </p>
        )}
      </div>
    );
  }

  if (detail.kind === "owner-required-missing") {
    return (
      <p className="text-xs text-muted-foreground">
        This execution is waiting for you. Peer Loop recorded no structured question for it.
      </p>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-md bg-muted/40 px-2.5 py-2">
      <p className="text-xs text-muted-foreground">
        This execution is paused and waiting for your decision.
      </p>
      <p className="text-xs text-foreground">{detail.decision.question}</p>
      <p className="text-xs text-muted-foreground">{detail.decision.why}</p>
      {detail.decision.options.length === 0 ? null : (
        <ul className="flex min-w-0 list-disc flex-col gap-0.5 ps-4">
          {detail.decision.options.map((option) => (
            <li key={option} className="text-xs text-muted-foreground">
              {option}
            </li>
          ))}
        </ul>
      )}
      {/*
        No inline approve, recover, resume, pause or owner message. Answering is
        a live command against Peer Loop's control snapshot, and the inspector
        is where those controls know whether Peer Loop would accept them.
      */}
    </div>
  );
});
