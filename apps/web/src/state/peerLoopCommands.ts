/**
 * Peer Loop's owner controls, as the web app runs them.
 *
 * One hook per command, each keeping its own pending/success/error state so a
 * failed pause does not blank the message you were writing. Two rules matter
 * more than the plumbing:
 *
 *   - **A failure is never retried here.** Peer Loop may have accepted a
 *     command and finished after T3 Code stopped waiting; repeating a start
 *     would fork the Reviewer's conversation and repeating a recovery would
 *     replay a Builder task. The error says so and the owner decides.
 *   - **Typed refusals survive.** `CONTROL_UNAVAILABLE` and
 *     `PROJECT_HAS_UNFINISHED_RUN` are different problems with different fixes,
 *     so the code is carried through to the surface rather than flattened.
 *
 * @module WebPeerLoopCommands
 */
import type { PeerLoopRecoveryChoice } from "@t3tools/contracts";
import { PeerLoopError } from "@t3tools/contracts";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";

import { describeError, type PeerLoopErrorPresentation } from "~/peerLoopPresentation";
import { useAtomCommand } from "./use-atom-command";
import { peerLoopCommands, peerLoopEnvironment } from "./peerLoop";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";

export interface PeerLoopCommandState {
  readonly pending: boolean;
  readonly error: PeerLoopErrorPresentation | null;
  /** The typed refusal behind `error`, kept for structured follow-ups. */
  readonly failure: PeerLoopError | null;
  readonly success: string | null;
}

export const IDLE: PeerLoopCommandState = {
  pending: false,
  error: null,
  failure: null,
  success: null,
};

/** Hoisted: `Schema.is` compiles a checker, and every failed command runs it. */
const isPeerLoopError = Schema.is(PeerLoopError);

/**
 * The typed Peer Loop failure inside a settled command result, if there is one.
 *
 * A command can also fail for connection reasons that have nothing to do with
 * Peer Loop — the environment is not reachable, the session is not authorized.
 * Those are not refusals and must not be dressed as them, so only a genuine
 * Peer Loop error is unwrapped here.
 */
export function peerLoopFailure(
  result: AsyncResult.AsyncResult<unknown, unknown>,
): PeerLoopError | null {
  if (!AsyncResult.isFailure(result)) return null;
  const error = Option.getOrNull(Cause.findErrorOption(result.cause));
  return error !== null && isPeerLoopError(error) ? error : null;
}

const SEND_FAILED: PeerLoopErrorPresentation = {
  title: "The command could not be sent",
  detail: "The connection to this environment failed. Nothing was retried.",
  code: null,
  tone: "warning",
  mayHaveApplied: false,
};

/**
 * An unexpected throw out of the RPC layer.
 *
 * Bounded and generic on purpose: whatever a defect carries was never meant for
 * a remote client, and putting it on a phone would be the one place this
 * integration leaks something it never inspected.
 */
const SEND_FAILED_UNEXPECTEDLY: PeerLoopErrorPresentation = {
  title: "The command could not be sent",
  detail:
    "Something went wrong sending this. Nothing was retried; check the run before trying again.",
  code: null,
  tone: "warning",
  mayHaveApplied: false,
};

/**
 * The gate itself, with no React in it.
 *
 * A synchronous closure flag, which is the whole point: a flag set inside a
 * `setState` updater is not a gate at all, because React may run the updater
 * twice and two presses in the same tick both read `pending: false` before
 * either render lands. That is two RPCs for one intent, and for
 * `run.ownerMessage` it means the same message queued twice.
 *
 * Released on success, on a typed refusal, on a defect and on disposal. A
 * failure is never retried here: Peer Loop may have accepted the command and
 * finished after T3 Code stopped waiting.
 */
export function createPeerLoopCommandGate<Input, Output>(deps: {
  readonly run: (input: Input) => Promise<AsyncResult.AsyncResult<Output, unknown>>;
  readonly describeSuccess: (value: Output) => string | null;
  readonly onState: (state: PeerLoopCommandState) => void;
}) {
  let inFlight = false;
  let live = true;

  const publish = (state: PeerLoopCommandState): void => {
    if (live) deps.onState(state);
  };

  const invoke = async (input: Input): Promise<Output | null> => {
    // Disposed: the component that owned this is gone. Starting a mutation now
    // would send a command nobody is watching the result of.
    if (!live || inFlight) return null;
    inFlight = true;
    publish({ pending: true, error: null, failure: null, success: null });

    try {
      const result = await deps.run(input);
      if (AsyncResult.isSuccess(result)) {
        publish({
          pending: false,
          error: null,
          failure: null,
          success: deps.describeSuccess(result.value),
        });
        return result.value;
      }
      const failure = peerLoopFailure(result);
      publish({
        pending: false,
        error: failure === null ? SEND_FAILED : describeError(failure),
        failure,
        success: null,
      });
      return null;
    } catch {
      // A DEFECT IS STILL A TERMINAL STATE. Letting it escape left the hook
      // visibly pending for ever and turned the route's `.then` chain into an
      // unhandled rejection. It is settled here, generically, and not retried.
      publish({ pending: false, error: SEND_FAILED_UNEXPECTEDLY, failure: null, success: null });
      return null;
    } finally {
      // Every path.
      inFlight = false;
    }
  };

  return {
    invoke,
    /** True while an invocation is outstanding. For tests and teardown. */
    isBusy: () => inFlight,
    dispose: () => {
      live = false;
      inFlight = false;
    },
  } as const;
}

function usePeerLoopCommand<Input, Output, Failure>(
  command: Parameters<typeof useAtomCommand<Output, Failure, Input>>[0],
  describeSuccess: (value: Output) => string | null,
) {
  const [state, setState] = useState<PeerLoopCommandState>(IDLE);
  const run = useAtomCommand(command, { reportFailure: false });

  const describeRef = useRef(describeSuccess);
  describeRef.current = describeSuccess;
  const runRef = useRef(run);
  runRef.current = run;

  // One gate for the life of the component, held in a ref so it is written
  // synchronously and survives every re-render.
  const gateRef = useRef<ReturnType<typeof createPeerLoopCommandGate<Input, Output>> | null>(null);
  gateRef.current ??= createPeerLoopCommandGate<Input, Output>({
    run: (input) => runRef.current(input),
    describeSuccess: (value) => describeRef.current(value),
    onState: setState,
  });

  useEffect(() => {
    const gate = gateRef.current;
    return () => gate?.dispose();
  }, []);

  const invoke = useCallback((input: Input) => {
    const gate = gateRef.current;
    return gate === null ? Promise.resolve(null) : gate.invoke(input);
  }, []);

  const reset = useCallback(() => setState(IDLE), []);
  return { state, invoke, reset } as const;
}

/**
 * Re-read the run list.
 *
 * `useAtomRefresh` on the exact primary-environment query, so a successful
 * command's effect on the list appears without waiting out the poll — and
 * without anything being sent a second time.
 */
export function useRefreshPeerLoopRuns(): () => void {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const refresh = useAtomRefresh(
    environmentId === null
      ? EMPTY_RUNS_ATOM
      : peerLoopEnvironment.runs({ environmentId, input: {} }),
  );
  return useCallback(() => {
    if (environmentId === null) return;
    refresh();
  }, [environmentId, refresh]);
}

const EMPTY_RUNS_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("web-peer-loop-runs:none"),
);

export function usePeerLoopStartRun() {
  return usePeerLoopCommand(peerLoopCommands.startRun, (result) =>
    result.awaitingOwnerObjective
      ? "Run created. Peer Loop is waiting for an objective before it starts a turn."
      : "Run started.",
  );
}

export function usePeerLoopOwnerMessage() {
  return usePeerLoopCommand(peerLoopCommands.sendOwnerMessage, (result) =>
    result.queued
      ? `Queued for the next Reviewer turn (${result.queuedOwnerMessages} waiting).`
      : "Delivered.",
  );
}

export function usePeerLoopPause() {
  return usePeerLoopCommand(peerLoopCommands.pauseRun, (result) =>
    result.applied === "live"
      ? "Pause requested. It takes effect at the next safe boundary."
      : "Pause recorded for the next time this run is driven.",
  );
}

export function usePeerLoopResume() {
  return usePeerLoopCommand(peerLoopCommands.resumeRun, (result) =>
    result.interrupted
      ? "Resumed, and Peer Loop reports an interrupted turn. Choose how to continue below."
      : "Resumed.",
  );
}

export function usePeerLoopRecover() {
  return usePeerLoopCommand(
    peerLoopCommands.recoverRun,
    (result) => `Recovery applied: ${result.choice}.`,
  );
}

export type { PeerLoopRecoveryChoice };
