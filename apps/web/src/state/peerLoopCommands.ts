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
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useState } from "react";

import { describeError, type PeerLoopErrorPresentation } from "~/peerLoopPresentation";
import { useAtomCommand } from "./use-atom-command";
import { peerLoopCommands, peerLoopEnvironment } from "./peerLoop";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";

export interface PeerLoopCommandState {
  readonly pending: boolean;
  readonly error: PeerLoopErrorPresentation | null;
  readonly success: string | null;
}

export const IDLE: PeerLoopCommandState = { pending: false, error: null, success: null };

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

/**
 * Run one Peer Loop command and remember only what the surface needs.
 *
 * `reportFailure: false` because a refusal is a legitimate answer here — the
 * page shows it in place, with its code — rather than something to toast as an
 * unexpected error.
 */
function usePeerLoopCommand<Input, Output, Failure>(
  command: Parameters<typeof useAtomCommand<Output, Failure, Input>>[0],
  describeSuccess: (value: Output) => string | null,
) {
  const [state, setState] = useState<PeerLoopCommandState>(IDLE);
  const run = useAtomCommand(command, { reportFailure: false });

  const invoke = useCallback(
    async (input: Input): Promise<Output | null> => {
      // A second press while one is in flight is ignored rather than queued:
      // sending the same owner message twice is not something to guess at.
      let started = false;
      setState((current) => {
        if (current.pending) return current;
        started = true;
        return { pending: true, error: null, success: null };
      });
      if (!started) return null;

      const result = await run(input);
      if (AsyncResult.isSuccess(result)) {
        setState({ pending: false, error: null, success: describeSuccess(result.value) });
        return result.value;
      }
      const failure = peerLoopFailure(result);
      setState({
        pending: false,
        error:
          failure === null
            ? {
                title: "The command could not be sent",
                detail: null,
                code: null,
                tone: "warning",
                mayHaveApplied: false,
              }
            : describeError(failure),
        success: null,
      });
      return null;
    },
    [describeSuccess, run],
  );

  const reset = useCallback(() => setState(IDLE), []);
  return { state, invoke, reset } as const;
}

/** Re-read the run list after a command lands. Never replays the command. */
function useRefreshRuns() {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const refresh = useAtomValue(
    environmentId === null
      ? peerLoopEnvironment.runs({ environmentId: "" as never, input: {} })
      : peerLoopEnvironment.runs({ environmentId, input: {} }),
  );
  return refresh;
}

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
      : `Pause recorded (${result.applied}).`,
  );
}

export function usePeerLoopResume() {
  return usePeerLoopCommand(peerLoopCommands.resumeRun, (result) =>
    result.interrupted
      ? "Peer Loop reports an interrupted turn. Choose how to continue below."
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
export { useRefreshRuns };
