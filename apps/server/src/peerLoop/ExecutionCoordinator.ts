/**
 * PeerLoopExecutionCoordinator - turning an agreed proposal into a run.
 *
 * The whole operation is three steps and one rule about each:
 *
 *   1. **Validate against T3 Code's own read model.** Everything that can be
 *      refused is refused here, before Peer Loop is touched, so a rejected
 *      Execute leaves nothing behind anywhere.
 *   2. **Call `startRun` exactly once.** Peer Loop owns run creation, the
 *      duplicate-run preflight, the lifecycle, the policy and the recovery. A
 *      timeout is never retried: Peer Loop may already have started the run and
 *      a second start would fork a session.
 *   3. **Record the immutable link.** One internal orchestration command with
 *      the run id Peer Loop returned.
 *
 * It is a coordinator, not an engine. It holds no run state, mirrors nothing
 * Peer Loop reports, and has no lifecycle of its own — after step 3 it is done
 * with the run forever.
 *
 * AT-MOST-ONCE, AND WHY IT ACTUALLY HOLDS:
 *
 * Attempts are serialized per `(threadId, proposedPlanId)` and validation is
 * re-read *inside* that critical section — against `OrchestrationEngineService`,
 * the engine's own committed command state, and never against the SQL
 * projection. That distinction is the whole guarantee. The projection is
 * eventually consistent with respect to `dispatch`: its projectors catch up
 * separately, so a second Execute arriving right after the first one's link
 * command committed could read a projected thread with no link on it, conclude
 * the proposal had never been executed, and start a second run. The engine's
 * read model is advanced inside the append transaction and before `dispatch`
 * resolves, so a request that waited behind the gate is guaranteed to see the
 * link the previous one recorded, and is refused as already executed.
 *
 * There is deliberately only ONE validation source. Keeping the projection as
 * a second opinion would reintroduce the race the moment anything read it.
 *
 * Serializing per proposal rather than globally keeps two different proposals
 * from queueing behind each other's bridge spawn.
 *
 * @module PeerLoopExecutionCoordinator
 */
import {
  CommandId,
  PeerLoopExecutionCoordinationError,
  type OrchestrationPeerLoopExecution,
  type OrchestrationProject,
  type OrchestrationProposedPlan,
  type OrchestrationThread,
  type PeerLoopError,
  type PeerLoopExecuteProposalInput,
  type PeerLoopExecuteProposalResult,
  type PeerLoopExecutionFailureReason,
  type PeerLoopStartRunInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { PeerLoopService } from "./Service.ts";

export interface PeerLoopExecutionCoordinatorShape {
  readonly executeProposal: (
    input: PeerLoopExecuteProposalInput,
  ) => Effect.Effect<
    PeerLoopExecuteProposalResult,
    PeerLoopError | PeerLoopExecutionCoordinationError
  >;
  /**
   * How many proposals currently hold a serialization gate.
   *
   * An inspection seam so "this map cannot grow" is an assertion rather than a
   * hope, mirroring `PeerLoopService.replaySlotCount`. Not an RPC.
   */
  readonly pendingExecutionGateCount: Effect.Effect<number>;
}

export class PeerLoopExecutionCoordinator extends Context.Service<
  PeerLoopExecutionCoordinator,
  PeerLoopExecutionCoordinatorShape
>()("t3/peerLoop/ExecutionCoordinator/PeerLoopExecutionCoordinator") {}

/* --------------------------------------------------------------- errors */

/**
 * One fixed sentence per reason.
 *
 * Sanitized by construction: the only variables are the ids the caller itself
 * supplied and, where it helps, a run id it is entitled to. Nothing here can
 * carry a SQL message, a stack, a machine path or provider output, because
 * nothing here is interpolated from a caught error.
 */
const FAILURE_DETAILS: Readonly<Record<PeerLoopExecutionFailureReason, string>> = {
  "navigator-thread-not-found": "No active thread with that id. Nothing was started.",
  "not-a-navigator-thread":
    "That thread is a coding thread. Only a navigator thread's execution proposals start Peer Loop runs. Nothing was started.",
  "proposal-not-found": "That proposal does not exist on that thread. Nothing was started.",
  "proposal-already-executed":
    "That proposal has already been executed as a Peer Loop run. Nothing was started; open the existing run instead.",
  "proposal-already-implemented":
    "That proposal was already implemented by a coding thread. Nothing was started.",
  "project-not-found":
    "The thread's project is no longer active, so there is no workspace root to run against. Nothing was started.",
  "coordination-failed":
    "T3 Code could not read its own record of this thread. Nothing was started.",
  "link-not-confirmed":
    "Peer Loop started the run, and T3 Code could not confirm it recorded the link to this proposal. The run is real and nothing was retried — open it directly.",
};

const coordinationFailure = (input: {
  readonly reason: PeerLoopExecutionFailureReason;
  readonly threadId: PeerLoopExecuteProposalInput["threadId"];
  readonly proposedPlanId: PeerLoopExecuteProposalInput["proposedPlanId"];
  readonly runId?: string | null;
  readonly mayHaveStarted?: boolean;
}): PeerLoopExecutionCoordinationError =>
  new PeerLoopExecutionCoordinationError({
    reason: input.reason,
    detail: FAILURE_DETAILS[input.reason],
    threadId: input.threadId,
    proposedPlanId: input.proposedPlanId,
    runId: input.runId ?? null,
    mayHaveStarted: input.mayHaveStarted ?? false,
  });

/* ------------------------------------------------------- serialization */

interface ExecutionGate {
  readonly gate: Semaphore.Semaphore;
  users: number;
}

/**
 * A collision-proof key for a `(threadId, proposedPlanId)` pair.
 *
 * Length-prefixed rather than separator-joined. Any separator — a space, a
 * slash, even a NUL — is a byte that could in principle appear inside an id,
 * and the failure it buys is silent: two different pairs sharing one gate, or
 * two identical pairs landing on different gates and serializing against
 * nothing at all. Prefixing each part with its length removes the question
 * rather than arguing about which byte is safe.
 */
export const executionGateKey = (threadId: string, proposedPlanId: string): string =>
  `${threadId.length}:${threadId}${proposedPlanId.length}:${proposedPlanId}`;

/* ---------------------------------------------------------------- make */

export const make = Effect.fn("peerLoop.ExecutionCoordinator.make")(function* () {
  const peerLoop = yield* PeerLoopService;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;

  const gates = new Map<string, ExecutionGate>();

  /**
   * Find or create this proposal's gate and take a reference, in ONE
   * synchronous step.
   *
   * Creating the semaphore inside an effect would put a yield between the
   * lookup miss and the write, so two simultaneous Execute presses could each
   * miss, each build their own gate, and serialize against nothing — which is
   * precisely the case this exists for.
   */
  const acquireGate = (key: string): Effect.Effect<ExecutionGate> =>
    Effect.sync(() => {
      const existing = gates.get(key);
      if (existing !== undefined) {
        existing.users += 1;
        return existing;
      }
      const created: ExecutionGate = { gate: Semaphore.makeUnsafe(1), users: 1 };
      gates.set(key, created);
      return created;
    });

  /** Give the reference back, deleting the entry with its last user. */
  const releaseGate = (key: string, owned: ExecutionGate): Effect.Effect<void> =>
    Effect.sync(() => {
      owned.users -= 1;
      if (owned.users <= 0 && gates.get(key) === owned) gates.delete(key);
    });

  /* ------------------------------------------------------- validation */

  interface ValidatedProposal {
    readonly thread: OrchestrationThread;
    readonly plan: OrchestrationProposedPlan;
    readonly project: Pick<OrchestrationProject, "workspaceRoot">;
  }

  /**
   * Everything that can refuse this operation, read fresh.
   *
   * Called once inside the gate. Reading it outside as well would only make
   * the window smaller, not closed, and the answer that matters is the one
   * taken while nothing else can be starting the same run.
   */
  const validate = Effect.fn("peerLoop.ExecutionCoordinator.validate")(function* (
    input: PeerLoopExecuteProposalInput,
  ): Effect.fn.Return<ValidatedProposal, PeerLoopExecutionCoordinationError> {
    const fail = (reason: PeerLoopExecutionFailureReason, runId?: string) =>
      coordinationFailure({
        reason,
        threadId: input.threadId,
        proposedPlanId: input.proposedPlanId,
        runId: runId ?? null,
      });

    // The engine's committed state, not the SQL projection: see the module
    // note. This is the read the at-most-once promise rests on.
    const threadOption = yield* orchestrationEngine.getThreadById(input.threadId);

    // A soft-deleted thread is not an active thread. The projection filtered
    // these out in SQL; the engine hands back what it holds, so the "active"
    // half of the rule lives here where it can be read.
    if (Option.isNone(threadOption) || threadOption.value.deletedAt !== null) {
      return yield* fail("navigator-thread-not-found");
    }
    const thread = threadOption.value;

    if (thread.purpose !== "navigator") {
      return yield* fail("not-a-navigator-thread");
    }

    const plan = thread.proposedPlans.find((entry) => entry.id === input.proposedPlanId);
    if (plan === undefined) {
      return yield* fail("proposal-not-found");
    }

    const existingLink = thread.peerLoopExecutions.find(
      (execution) => execution.proposedPlanId === input.proposedPlanId,
    );
    if (existingLink !== undefined) {
      // The run id travels: the useful next action is opening that run, not
      // pressing Execute again.
      return yield* fail("proposal-already-executed", existingLink.runId);
    }

    // A plan already implemented by a coding thread is not a candidate for a
    // second, parallel execution. Different mechanism, same agreed plan.
    if (plan.implementedAt !== null || plan.implementationThreadId !== null) {
      return yield* fail("proposal-already-implemented");
    }

    const projectOption = yield* orchestrationEngine.getProjectById(thread.projectId);
    if (Option.isNone(projectOption) || projectOption.value.deletedAt !== null) {
      return yield* fail("project-not-found");
    }

    return { thread, plan, project: { workspaceRoot: projectOption.value.workspaceRoot } };
  });

  /**
   * Did the link we failed to dispatch actually land?
   *
   * Read once, from the engine's committed state, and looking for the exact
   * pair. A dispatch that reported failure may still have committed — the
   * append transaction and the answer coming back are not the same step — so
   * the honest question is whether the committed record now shows this proposal
   * linked to this run, and nothing weaker. Asking the SQL projection instead
   * would answer "not yet" for a link that is committed and merely not
   * projected, turning a success into a spurious `link-not-confirmed`. A link
   * to a *different* run would mean something else entirely happened and must
   * not be reported as this request's success.
   */
  const confirmLink = Effect.fn("peerLoop.ExecutionCoordinator.confirmLink")(function* (input: {
    readonly threadId: PeerLoopExecuteProposalInput["threadId"];
    readonly proposedPlanId: PeerLoopExecuteProposalInput["proposedPlanId"];
    readonly runId: string;
  }) {
    const threadOption = yield* orchestrationEngine.getThreadById(input.threadId);
    if (Option.isNone(threadOption)) return null;
    return (
      threadOption.value.peerLoopExecutions.find(
        (execution) =>
          execution.runId === input.runId && execution.proposedPlanId === input.proposedPlanId,
      ) ?? null
    );
  });

  /* ---------------------------------------------------------- execute */

  const executeUnderGate = Effect.fn("peerLoop.ExecutionCoordinator.executeUnderGate")(function* (
    input: PeerLoopExecuteProposalInput,
  ): Effect.fn.Return<
    PeerLoopExecuteProposalResult,
    PeerLoopError | PeerLoopExecutionCoordinationError
  > {
    const validated = yield* validate(input);

    // Built here and nowhere else. The client supplied a thread and a proposal;
    // the project root is the project's own, the objective is the agreed plan
    // exactly as written, and `newRun` is absent because bypassing Peer Loop's
    // duplicate-run preflight is Peer Loop's decision to offer, not ours.
    // Minted before the run starts. A crypto failure afterwards would leave a
    // real run with no way to record it — the one outcome worth spending a
    // line to avoid.
    const linkCommandId = yield* crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:peer-loop-execute:${uuid}`)),
      Effect.mapError(() =>
        coordinationFailure({
          reason: "coordination-failed",
          threadId: input.threadId,
          proposedPlanId: input.proposedPlanId,
        }),
      ),
    );

    const startInput: PeerLoopStartRunInput = {
      projectPath: validated.project.workspaceRoot,
      objective: validated.plan.planMarkdown,
      ...(input.safetyLimit === undefined ? {} : { safetyLimit: input.safetyLimit }),
    };

    // Once. A failure here — refusal, timeout, unavailable bridge — is Peer
    // Loop's own answer and travels back untouched, including a timeout's
    // `mayHaveApplied`. Nothing is retried.
    const run = yield* peerLoop.startRun(startInput);

    const linkedAt = DateTime.formatIso(yield* DateTime.now);
    const execution: OrchestrationPeerLoopExecution = {
      runId: run.runId,
      proposedPlanId: input.proposedPlanId,
      createdAt: linkedAt,
    };

    const dispatched = yield* orchestrationEngine
      .dispatch({
        type: "thread.peer-loop-execution.link",
        commandId: linkCommandId,
        threadId: input.threadId,
        proposedPlanId: input.proposedPlanId,
        runId: run.runId,
        createdAt: linkedAt,
      })
      .pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );

    if (dispatched) {
      return { run, execution };
    }

    // The run exists. Either the link landed anyway and this is a successful
    // execution, or it did not and the owner has to be told plainly — with the
    // run id, so recovery is a deliberate act on a run they can actually open.
    // No second start, no resume, no touching Peer Loop's recovery state.
    const confirmed = yield* confirmLink({
      threadId: input.threadId,
      proposedPlanId: input.proposedPlanId,
      runId: run.runId,
    });
    if (confirmed !== null) {
      return { run, execution: confirmed };
    }

    return yield* coordinationFailure({
      reason: "link-not-confirmed",
      threadId: input.threadId,
      proposedPlanId: input.proposedPlanId,
      runId: run.runId,
      mayHaveStarted: true,
    });
  });

  const executeProposal: PeerLoopExecutionCoordinatorShape["executeProposal"] = (input) => {
    const key = executionGateKey(input.threadId, input.proposedPlanId);
    return Effect.acquireUseRelease(
      acquireGate(key),
      (owned) => owned.gate.withPermits(1)(executeUnderGate(input)),
      (owned) => releaseGate(key, owned),
    );
  };

  return {
    executeProposal,
    pendingExecutionGateCount: Effect.sync(() => gates.size),
  } satisfies PeerLoopExecutionCoordinatorShape;
});

export const layer = Layer.effect(PeerLoopExecutionCoordinator, make());
