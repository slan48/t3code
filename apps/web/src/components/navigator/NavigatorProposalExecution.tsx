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
import { peerLoopOwnerDecisionFingerprint } from "@t3tools/shared/peerLoopDecisionFingerprint";
import { memo, useCallback, useEffect, useRef } from "react";

import { cn } from "~/lib/utils";
import { threadCapabilities } from "~/navigatorCapabilities";
import {
  compactRunId,
  describeExecution,
  describeExecutionDetail,
  describeOwnerDecisionAction,
  executionSnapshotIsUseful,
  presentOwnerDecisionOptions,
  type NavigatorDecisionAnswerFailure,
  type NavigatorOwnerDecisionAction,
  inspectorTargetFor,
  showsExecutionArea,
  type ExecutableProposal,
  type NavigatorExecutionDetail,
  type NavigatorExecutionFacts,
  type NavigatorExecutionFailure,
  type NavigatorExecutionPresentation,
} from "~/navigatorExecution";
import {
  navigatorExecutionAvailability,
  useNavigatorExecution,
  useNavigatorExecutionRuns,
  useNavigatorExecutionSnapshot,
  useNavigatorOwnerDecisionAnswer,
} from "~/state/navigatorExecutionCommand";
import { Button } from "../ui/button";
import { PeerLoopPill } from "../peerLoop/PeerLoopPrimitives";

/**
 * What the conversation knows, handed down once.
 *
 * Assembled in `ChatView` and shared with the composer's confirmation, which
 * decides from this same object rather than from a copy of its own. Run
 * summaries are deliberately absent: this travels through the timeline's row
 * context, and putting a five-second poll in it would re-render every row in
 * the conversation twelve times a minute.
 */
export type NavigatorExecutionContext = NavigatorExecutionFacts;

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
  // The one availability answer, from the one gate. The composer's confirmation
  // asks the same question of the same object, so a card mounting with Execute
  // offered and a phrase submitted a moment later cannot disagree. What the
  // last attempt left behind decides it — not merely whether it might have
  // started something: an already-executed refusal started nothing here and
  // still must not re-offer Execute, while a provable pre-start refusal is
  // executable again the instant this mounts.
  const availability = navigatorExecutionAvailability({ facts: context, proposal });

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
                threadId={threadId}
                purpose={context.purpose}
                refreshRuns={refresh}
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
  threadId,
  purpose,
  presentation,
  refreshRuns,
}: {
  readonly environmentId: EnvironmentId;
  /** The conversation this run is linked to. The link is why it may answer. */
  readonly threadId: ThreadId;
  readonly purpose: ThreadPurpose;
  readonly presentation: NavigatorExecutionPresentation;
  /** Re-read the summaries once an answer lands. */
  readonly refreshRuns: () => void;
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

  /*
   * What the owner may answer, from the reading this card is holding.
   *
   * Never from `detail`, whose text is bounded for display, and never from the
   * run-list summary, which has no question in it at all. The fingerprint has
   * to name what Peer Loop wrote character for character.
   */
  const action = describeOwnerDecisionAction({
    snapshot,
    threadId,
    runId: presentation.runId,
    linkedToThread: true,
    capable: threadCapabilities(purpose).canAnswerLinkedOwnerDecision,
    fingerprintOf: peerLoopOwnerDecisionFingerprint,
  });
  const { state: answerState, answer } = useNavigatorOwnerDecisionAnswer({
    environmentId,
    runId: presentation.runId,
    refreshRuns,
    refreshSnapshot: snapshot.refresh,
  });

  return (
    <NavigatorExecutionCard
      presentation={presentation}
      detail={detail}
      action={action}
      answering={answerState.pending}
      answerFailure={answerState.failure}
      onAnswer={answer}
    />
  );
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
  action = null,
  answering = false,
  answerFailure = null,
  onAnswer,
}: {
  readonly presentation: NavigatorExecutionPresentation;
  readonly detail?: NavigatorExecutionDetail;
  /** The answerable decision, when the snapshot holds a fresh one. */
  readonly action?: NavigatorOwnerDecisionAction | null;
  /** True while this client's answer is in flight, for every copy of the card. */
  readonly answering?: boolean;
  readonly answerFailure?: NavigatorDecisionAnswerFailure | null;
  readonly onAnswer?:
    | ((action: NavigatorOwnerDecisionAction, optionIndex: number) => void)
    | undefined;
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

      <NavigatorExecutionDetailBlock
        detail={detail}
        action={action}
        answering={answering}
        answerFailure={answerFailure}
        onAnswer={onAnswer}
      />

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
  action = null,
  answering = false,
  answerFailure = null,
  onAnswer,
}: {
  readonly detail: NavigatorExecutionDetail;
  readonly action?: NavigatorOwnerDecisionAction | null;
  readonly answering?: boolean;
  readonly answerFailure?: NavigatorDecisionAnswerFailure | null;
  readonly onAnswer?:
    | ((action: NavigatorOwnerDecisionAction, optionIndex: number) => void)
    | undefined;
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
      {action === null ? (
        /*
         * The options as text, exactly as before.
         *
         * This is what a card shows when it cannot answer: no durable thread,
         * no link, a conversation that may not answer, an answer already
         * queued, or a reading that has not arrived. The question and its
         * options still belong on screen — the inspector is where it is
         * answered instead.
         */
        detail.decision.options.length === 0 ? null : (
          <ul className="flex min-w-0 list-disc flex-col gap-0.5 ps-4">
            {detail.decision.options.map((option) => (
              <li key={option} className="text-xs text-muted-foreground">
                {option}
              </li>
            ))}
          </ul>
        )
      ) : (
        <OwnerDecisionOptions action={action} answering={answering} onAnswer={onAnswer} />
      )}
      {answerFailure === null ? null : (
        <div role="alert" className="flex min-w-0 flex-col gap-0.5">
          <p className="text-xs font-medium text-foreground">{answerFailure.title}</p>
          {answerFailure.detail === null ? null : (
            <p className="text-xs text-muted-foreground">{answerFailure.detail}</p>
          )}
          {answerFailure.code === null ? null : (
            <p className="font-mono text-xs break-all text-muted-foreground">
              {answerFailure.code}
            </p>
          )}
        </div>
      )}
      {/*
        Answering is the one control here. No recover, resume, pause or free
        owner message: those need the run's live control snapshot and belong in
        the advanced inspector, which is the one place they are safe.
      */}
    </div>
  );
});

/**
 * A button per option this card presents.
 *
 * BOUNDED THE WAY EVERY OTHER PEER LOOP SURFACE BOUNDS OPTIONS, so a Reviewer
 * that produced a dozen does not turn a conversation into a form. Whatever is
 * past the limit is reachable where every option always is: the run's own page,
 * one link below.
 *
 * THE INDEX ON THE BUTTON IS PEER LOOP'S OWN. An option too long to read is
 * shortened, an empty one is not drawn, and one past the limit is not drawn —
 * none of that changes the number sent, because the server resolves the text by
 * that number out of a reading it takes for itself, and a renumbered click
 * would answer with a different sentence.
 *
 * Every button is disabled while any answer for this run is in flight. The two
 * copies of this card share one gate, so a second click cannot become a second
 * answer to a question that was asked once.
 */
const OwnerDecisionOptions = memo(function OwnerDecisionOptions({
  action,
  answering,
  onAnswer,
}: {
  readonly action: NavigatorOwnerDecisionAction;
  readonly answering: boolean;
  readonly onAnswer?:
    | ((action: NavigatorOwnerDecisionAction, optionIndex: number) => void)
    | undefined;
}) {
  const options = presentOwnerDecisionOptions(action.options);
  if (options.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5 pt-1">
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {options.map((option) => (
          <Button
            key={option.index}
            size="sm"
            variant="outline"
            className="h-auto max-w-full min-w-0 self-start py-1 text-start text-xs whitespace-normal"
            disabled={answering}
            onClick={() => onAnswer?.(action, option.index)}
          >
            {option.label}
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {answering
          ? "Sending your answer to Peer Loop…"
          : "Peer Loop receives the option you pick, exactly as the Reviewer wrote it."}
      </p>
    </div>
  );
});
