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
  describeViewAttention,
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

export interface PeerLoopDetailActions {
  readonly sendOwnerMessage: (text: string) => void;
  readonly pause: () => void;
  readonly resume: () => void;
  readonly recover: (choice: PeerLoopRecoveryChoice) => void;
  readonly reattach: () => void;
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
  ownerMessage,
  pauseState,
  resumeState,
  recoverState,
  actions,
}: {
  readonly view: PeerLoopRunView;
  readonly ownerMessage: PeerLoopCommandState;
  readonly pauseState: PeerLoopCommandState;
  readonly resumeState: PeerLoopCommandState;
  readonly recoverState: PeerLoopCommandState;
  readonly actions: PeerLoopDetailActions;
}) {
  const attention = describeViewAttention(view);
  const detail = describeDetail(view);
  const controls = describeControls(view);
  const nowMs = Date.now();

  return (
    <div className="flex min-w-0 flex-col gap-6">
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
            {pauseState.pending ? "Pausing…" : "Pause"}
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
