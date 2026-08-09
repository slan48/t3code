import type { PeerLoopRecoveryChoice } from "@t3tools/contracts";
import type { PeerLoopRunView } from "@t3tools/client-runtime/state/peer-loop-reducer";
import { memo, useCallback, useState } from "react";

import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { formatRelative } from "~/agentRunFormat";
import {
  describeControls,
  describeDetail,
  describeEvent,
  describeFailureEvidence,
  describeFinalState,
  describeOwnerDecision,
  describeViewAttention,
  pauseTakesEffectLater,
  projectLabel,
  RECOVERY_CHOICES,
  type PeerLoopErrorPresentation,
} from "~/peerLoopPresentation";
import { PeerLoopErrorNotice, PeerLoopPill, PeerLoopSection } from "./PeerLoopPrimitives";

export interface PeerLoopCommandState {
  readonly pending: boolean;
  readonly error: PeerLoopErrorPresentation | null;
  /** Peer Loop's own confirmation, when the last one succeeded. */
  readonly success: string | null;
}

export const IDLE_COMMAND: PeerLoopCommandState = { pending: false, error: null, success: null };

export interface PeerLoopObservationState {
  readonly waiting: boolean;
  readonly error: PeerLoopErrorPresentation | null;
  /** True before this subscription has produced anything at all. */
  readonly empty: boolean;
}

export const LIVE_OBSERVATION: PeerLoopObservationState = {
  waiting: false,
  error: null,
  empty: false,
};

export interface PeerLoopDetailActions {
  readonly sendOwnerMessage: (text: string) => void;
  readonly pause: () => void;
  readonly resume: () => void;
  readonly recover: (choice: PeerLoopRecoveryChoice) => void;
  readonly reattach: () => void;
  /** Reads again. Sends no command of any kind. */
  readonly retryObservation: () => void;
}

/**
 * One run, from the single subscription that is already open for it.
 *
 * Everything shown here is Peer Loop's — its state, its outcome, its halt
 * reason, its control availability. Nothing on this page decides that a run may
 * continue, and nothing acts on its own: reconnecting restores observation and
 * the controls do exactly what the owner pressed, once.
 */
export const PeerLoopDetailView = memo(function PeerLoopDetailView({
  view,
  observation = LIVE_OBSERVATION,
  ownerMessage,
  pauseState,
  resumeState,
  recoverState,
  actions,
}: {
  readonly view: PeerLoopRunView;
  readonly observation?: PeerLoopObservationState;
  readonly ownerMessage: PeerLoopCommandState;
  readonly pauseState: PeerLoopCommandState;
  readonly resumeState: PeerLoopCommandState;
  readonly recoverState: PeerLoopCommandState;
  readonly actions: PeerLoopDetailActions;
}) {
  const attention = describeViewAttention(view);
  const detail = describeDetail(view);
  const controls = describeControls(view);
  const ownerDecision = describeOwnerDecision(view);
  const failure = describeFailureEvidence(view);
  const finalState = describeFinalState(view);
  const nowMs = Date.now();

  // A subscription that failed must not render as a run with nothing in it: a
  // missing run and a dropped connection look identical from an empty page.
  if (observation.error !== null && observation.empty) {
    return (
      <div className="flex min-w-0 flex-col gap-3">
        <p className="font-mono text-xs break-all text-muted-foreground">{view.runId}</p>
        <PeerLoopErrorNotice error={observation.error}>
          <Button size="xs" variant="outline" onClick={actions.retryObservation}>
            Try to observe this run again
          </Button>
        </PeerLoopErrorNotice>
        <p className="text-xs text-muted-foreground">
          Looking again only reads. Nothing about the run is started, resumed or resolved.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {observation.error === null ? null : (
        <PeerLoopErrorNotice error={observation.error}>
          <Button size="xs" variant="outline" onClick={actions.retryObservation}>
            Try to observe this run again
          </Button>
        </PeerLoopErrorNotice>
      )}
      {observation.waiting && observation.empty ? (
        <p role="status" className="text-sm text-muted-foreground">
          Reading this run from Peer Loop…
        </p>
      ) : null}
      <header className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h1 className="truncate text-base font-semibold text-foreground">
            {detail.projectPath === null ? view.runId : projectLabel(detail.projectPath)}
          </h1>
          <PeerLoopPill label={attention.label} tone={attention.tone} />
          {view.transport === null ? null : view.transport.state === "connected" ? null : (
            <PeerLoopPill label={`Connection: ${view.transport.state}`} tone="warning" />
          )}
        </div>
        <p className="font-mono text-xs break-all text-muted-foreground">{view.runId}</p>
        {attention.detail === null ? null : (
          <p className="text-sm break-words text-foreground">{attention.detail}</p>
        )}
      </header>

      {view.needsResync ? (
        <div
          role="status"
          className="flex min-w-0 flex-col items-start gap-2 rounded-md border border-warning/40 px-3 py-2"
        >
          <p className="text-sm text-foreground">
            This view is missing part of the run&apos;s activity. Peer Loop&apos;s record is
            unaffected.
          </p>
          <Button size="xs" variant="outline" onClick={actions.reattach}>
            Catch up from where it left off
          </Button>
        </div>
      ) : null}

      <PeerLoopSection title="State">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
          <Fact label="Run state" value={detail.state} />
          <Fact
            label="Iteration"
            value={detail.iteration === null ? null : String(detail.iteration)}
          />
          <Fact label="Reviewer" value={detail.reviewer} />
          <Fact label="Builder" value={detail.builder} />
          <Fact
            label="Turn in flight"
            value={detail.inFlightActor === null ? "none" : detail.inFlightActor}
          />
          <Fact label="Queued messages" value={String(detail.queuedOwnerMessages)} />
        </dl>
        {controls.unavailableReason === null ? null : (
          <p className="text-xs text-warning">{controls.unavailableReason}</p>
        )}
        {detail.currentTask === null ? null : (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-xs font-medium text-muted-foreground">Current Builder task</span>
            <p className="text-sm break-words text-foreground">{detail.currentTask}</p>
          </div>
        )}
        {detail.lastDecision === null ? null : (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-xs font-medium text-muted-foreground">
              Last Reviewer decision
            </span>
            <p className="text-sm break-words text-foreground">{detail.lastDecision}</p>
          </div>
        )}
      </PeerLoopSection>

      {ownerDecision === null ? null : (
        <PeerLoopSection title="The Reviewer needs a decision">
          <div className="flex min-w-0 flex-col gap-2 rounded-md border border-warning/40 px-3 py-2">
            <p className="text-sm break-words text-foreground">{ownerDecision.question}</p>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="text-xs font-medium text-muted-foreground">Why it needs you</span>
              <p className="text-xs break-words text-muted-foreground">{ownerDecision.why}</p>
            </div>
            {ownerDecision.options.length === 0 ? null : (
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-xs font-medium text-muted-foreground">
                  The options the Reviewer offered
                </span>
                {/*
                  Rendering an option does not send it. Each one is a button the
                  owner presses, and it goes out as an ordinary owner message —
                  queued for the next Reviewer turn like anything else typed.
                */}
                {ownerDecision.options.map((option) => (
                  <div key={option} className="flex min-w-0 items-start gap-2">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!controls.canSendOwnerMessage || ownerMessage.pending}
                      onClick={() => actions.sendOwnerMessage(option)}
                    >
                      Send
                    </Button>
                    <span className="min-w-0 text-xs break-words text-foreground">{option}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </PeerLoopSection>
      )}

      {failure === null ? null : (
        <PeerLoopSection title="What the Builder reported">
          <div className="flex min-w-0 flex-col gap-1 rounded-md border px-3 py-2">
            <span className="text-sm font-medium text-foreground">{failure.title}</span>
            <p className="text-xs break-words whitespace-pre-wrap text-muted-foreground">
              {failure.evidence}
            </p>
            <span className="text-[0.6875rem] text-muted-foreground">from {failure.source}</span>
            {/*
              Peer Loop reports a reset time only when the CLI actually stated
              one. Its absence is said plainly rather than shown as "no limit".
            */}
            <span className="text-xs text-muted-foreground">
              {failure.resetAt === null
                ? "No reset time was given."
                : `Resets at ${failure.resetAt}.`}
            </span>
          </div>
        </PeerLoopSection>
      )}

      {finalState === null ? null : (
        <PeerLoopSection title="How it finished">
          <p className="text-sm break-words text-foreground">{finalState}</p>
        </PeerLoopSection>
      )}

      <PeerLoopSection title="Controls">
        <OwnerMessageForm
          disabled={!controls.canSendOwnerMessage}
          state={ownerMessage}
          onSubmit={actions.sendOwnerMessage}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!controls.canPause || pauseState.pending}
            onClick={actions.pause}
          >
            {pauseState.pending
              ? "Pausing…"
              : pauseTakesEffectLater(view)
                ? "Pause at the next boundary"
                : "Pause"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!controls.canResume || resumeState.pending}
            onClick={actions.resume}
          >
            {resumeState.pending ? "Resuming…" : "Resume"}
          </Button>
        </div>
        {pauseState.error === null ? null : <PeerLoopErrorNotice error={pauseState.error} />}
        {resumeState.error === null ? null : <PeerLoopErrorNotice error={resumeState.error} />}
        {pauseState.success === null ? null : (
          <p className="text-xs text-success">{pauseState.success}</p>
        )}
        {resumeState.success === null ? null : (
          <p className="text-xs text-success">{resumeState.success}</p>
        )}

        {controls.resumeBeforeRecover ? (
          <div className="flex min-w-0 flex-col gap-1 rounded-md border border-warning/40 px-3 py-2">
            <p className="text-sm font-medium text-foreground">
              A turn was in flight when this run stopped.
            </p>
            {/*
              Recovery is a live command and nobody is driving this run, so a
              Recover button here would be refused. Resuming takes control
              first — and it does not replay the interrupted task; that stays an
              explicit choice, offered once Peer Loop is driving again.
            */}
            <p className="text-xs text-muted-foreground">
              Resume first to take control. Resuming runs a Reviewer turn and does not replay the
              interrupted Builder task; you choose what happens to that afterwards.
            </p>
          </div>
        ) : null}

        {controls.canRecover ? (
          <RecoveryControls state={recoverState} onRecover={actions.recover} />
        ) : null}
      </PeerLoopSection>

      <PeerLoopSection title="Activity" count={view.activity.length}>
        {view.activity.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing recorded for this run yet.</p>
        ) : (
          <ol className="flex min-w-0 flex-col gap-2">
            {view.activity.map((entry) => {
              const presented = describeEvent(entry);
              const when = formatRelative(entry.ts, nowMs);
              return (
                <li
                  key={entry.seq}
                  className="flex min-w-0 flex-col gap-0.5 rounded-md border px-3 py-2"
                >
                  <div className="flex min-w-0 flex-wrap items-baseline gap-2">
                    <span className="text-sm font-medium text-foreground">{presented.title}</span>
                    <span className="text-[0.6875rem] text-muted-foreground">#{entry.seq}</span>
                    {when === null ? null : (
                      <span className="text-[0.6875rem] text-muted-foreground">{when}</span>
                    )}
                  </div>
                  {presented.detail === null ? null : (
                    <p className="text-xs break-words text-muted-foreground">{presented.detail}</p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </PeerLoopSection>
    </div>
  );
});

const Fact = memo(function Fact({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <dt className="text-[0.6875rem] text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm text-foreground">{value ?? "—"}</dd>
    </div>
  );
});

/**
 * An owner message.
 *
 * Queued for the next Reviewer turn — Peer Loop never interrupts a running tool
 * because someone typed. Disabled while one is in flight so a double press
 * cannot queue the same thing twice.
 */
const OwnerMessageForm = memo(function OwnerMessageForm({
  disabled,
  state,
  onSubmit,
}: {
  readonly disabled: boolean;
  readonly state: PeerLoopCommandState;
  readonly onSubmit: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const submit = useCallback(
    (formEvent: React.FormEvent) => {
      formEvent.preventDefault();
      const trimmed = text.trim();
      if (trimmed.length === 0 || disabled || state.pending) return;
      onSubmit(trimmed);
      setText("");
    },
    [disabled, onSubmit, state.pending, text],
  );

  return (
    <form
      className="flex min-w-0 flex-col gap-2"
      onSubmit={submit}
      aria-label="Send an owner message"
    >
      <Textarea
        rows={2}
        value={text}
        disabled={disabled || state.pending}
        placeholder="Message the Reviewer — delivered at its next turn"
        onChange={(changeEvent) => setText(changeEvent.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={disabled || state.pending || text.trim().length === 0}
        >
          {state.pending ? "Sending…" : "Send message"}
        </Button>
        {state.success === null ? null : (
          <span className="text-xs text-success">{state.success}</span>
        )}
      </div>
      {state.error === null ? null : <PeerLoopErrorNotice error={state.error} />}
    </form>
  );
});

/**
 * Resolving an interrupted turn.
 *
 * No default, and no option is pre-selected: Peer Loop does not choose this and
 * neither does T3 Code. Replaying the Builder task takes a second, explicit
 * confirmation, because the interrupted task may already have changed the
 * repository and running it again can repeat work that was partly done.
 */
const RecoveryControls = memo(function RecoveryControls({
  state,
  onRecover,
}: {
  readonly state: PeerLoopCommandState;
  readonly onRecover: (choice: PeerLoopRecoveryChoice) => void;
}) {
  const [confirming, setConfirming] = useState<PeerLoopRecoveryChoice | null>(null);

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border border-destructive/40 px-3 py-2">
      <p className="text-sm font-medium text-foreground">
        A turn was in flight when Peer Loop stopped. Choose how to continue.
      </p>
      <p className="text-xs text-muted-foreground">
        The repository may already have changed. Nothing happens until you pick one.
      </p>
      {RECOVERY_CHOICES.map((option) => (
        <div key={option.choice} className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={option.confirm ? "destructive" : "outline"}
              disabled={state.pending}
              onClick={() => {
                if (option.confirm) {
                  setConfirming(confirming === option.choice ? null : option.choice);
                  return;
                }
                onRecover(option.choice);
              }}
            >
              {option.label}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{option.description}</p>
          {option.confirm && confirming === option.choice ? (
            <div className="flex min-w-0 flex-col gap-2 rounded-md border border-destructive/60 px-3 py-2">
              <p className="text-xs text-foreground">
                The interrupted task may already have changed the repository. Running it again can
                repeat work that was partly done. Continue?
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="xs"
                  variant="destructive"
                  disabled={state.pending}
                  onClick={() => {
                    setConfirming(null);
                    onRecover(option.choice);
                  }}
                >
                  Yes, run the task again
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setConfirming(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ))}
      {state.error === null ? null : <PeerLoopErrorNotice error={state.error} />}
      {state.success === null ? null : <p className="text-xs text-success">{state.success}</p>}
    </div>
  );
});
