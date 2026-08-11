import type {
  OrchestrationCommand,
  OrchestrationProject,
  OrchestrationReadModel,
  OrchestrationThread,
  ProjectId,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  ThreadPurpose,
} from "@t3tools/contracts";
import { NAVIGATOR_INTERACTION_MODE, NAVIGATOR_RUNTIME_MODE } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Effect from "effect/Effect";

import { OrchestrationCommandInvariantError } from "./Errors.ts";

function invariantError(commandType: string, detail: string): OrchestrationCommandInvariantError {
  return new OrchestrationCommandInvariantError({
    commandType,
    detail,
  });
}

export function findThreadById(
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  return readModel.threads.find((thread) => thread.id === threadId);
}

export function findProjectById(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): OrchestrationProject | undefined {
  return readModel.projects.find((project) => project.id === projectId);
}

export function listThreadsByProjectId(
  readModel: OrchestrationReadModel,
  projectId: ProjectId,
): ReadonlyArray<OrchestrationThread> {
  return readModel.threads.filter((thread) => thread.projectId === projectId);
}

export function requireProject(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<OrchestrationProject, OrchestrationCommandInvariantError> {
  const project = findProjectById(input.readModel, input.projectId);
  if (project) {
    return Effect.succeed(project);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireProjectAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly projectId: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findProjectById(input.readModel, input.projectId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Project '${input.projectId}' already exists and cannot be created twice.`,
    ),
  );
}

export function requireActiveProjectWorkspaceRootAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly workspaceRoot: string;
  readonly exceptProjectId?: ProjectId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  const normalizedWorkspaceRoot = normalizeProjectPathForComparison(input.workspaceRoot);
  const existingProject = input.readModel.projects.find(
    (project) =>
      project.deletedAt === null &&
      normalizeProjectPathForComparison(project.workspaceRoot) === normalizedWorkspaceRoot &&
      project.id !== input.exceptProjectId,
  );
  if (existingProject === undefined) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Active project '${existingProject.id}' already exists for workspace root '${normalizedWorkspaceRoot}'.`,
    ),
  );
}

export function requireThread(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  const thread = findThreadById(input.readModel, input.threadId);
  if (thread) {
    return Effect.succeed(thread);
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' does not exist for command '${input.command.type}'.`,
    ),
  );
}

export function requireThreadArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt !== null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is not archived for command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadNotArchived(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<OrchestrationThread, OrchestrationCommandInvariantError> {
  return requireThread(input).pipe(
    Effect.flatMap((thread) =>
      thread.archivedAt === null
        ? Effect.succeed(thread)
        : Effect.fail(
            invariantError(
              input.command.type,
              `Thread '${input.threadId}' is already archived and cannot handle command '${input.command.type}'.`,
            ),
          ),
    ),
  );
}

export function requireThreadAbsent(input: {
  readonly readModel: OrchestrationReadModel;
  readonly command: OrchestrationCommand;
  readonly threadId: ThreadId;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (!findThreadById(input.readModel, input.threadId)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.command.type,
      `Thread '${input.threadId}' already exists and cannot be created twice.`,
    ),
  );
}

/* ------------------------------------------------------------- navigator */

/**
 * The shape a Navigator thread has to be created in.
 *
 * A Navigator conversation is a planning conversation, and "planning" here is a
 * server fact rather than a UI default: a client that asks for a Navigator
 * thread with a writable runtime mode, the implementing interaction mode, a
 * branch or a worktree is refused outright rather than quietly corrected. It is
 * checked at creation because `purpose` is immutable — this is the only moment
 * the combination can be established.
 *
 * The runtime mode is T3 Code's existing read-only sandbox mapping and the
 * interaction mode is the existing plan mode. Navigator adds no new engine, no
 * new sandbox and no new lifecycle; it reuses what a plan-mode thread already
 * does and removes the ways out of it.
 */
export function requireValidNavigatorCreation(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly purpose: ThreadPurpose;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly branch: string | null;
  readonly worktreePath: string | null;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (input.purpose !== "navigator") {
    return Effect.void;
  }
  if (input.runtimeMode !== NAVIGATOR_RUNTIME_MODE) {
    return Effect.fail(
      invariantError(
        input.commandType,
        `A navigator thread must be created with runtimeMode '${NAVIGATOR_RUNTIME_MODE}', not '${input.runtimeMode}'. Navigator threads plan and never write.`,
      ),
    );
  }
  if (input.interactionMode !== NAVIGATOR_INTERACTION_MODE) {
    return Effect.fail(
      invariantError(
        input.commandType,
        `A navigator thread must be created with interactionMode '${NAVIGATOR_INTERACTION_MODE}', not '${input.interactionMode}'.`,
      ),
    );
  }
  if (input.branch !== null) {
    return Effect.fail(
      invariantError(
        input.commandType,
        "A navigator thread must be created with no branch. Navigator threads do not own a checkout.",
      ),
    );
  }
  if (input.worktreePath !== null) {
    return Effect.fail(
      invariantError(
        input.commandType,
        "A navigator thread must be created with no worktree. Navigator threads do not own a checkout.",
      ),
    );
  }
  return Effect.void;
}

/**
 * A Navigator thread cannot be talked out of being one.
 *
 * `purpose` is immutable, so the only way to turn a Navigator into an
 * implementation path would be to move it off the read-only runtime mode or out
 * of plan mode after the fact. Both are refused. Setting the value it already
 * has is allowed, because an idempotent set is how a client re-asserts state it
 * already believes and refusing it would break nothing but the client.
 */
export function requireNavigatorModeUnchanged(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly thread: OrchestrationThread;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (input.thread.purpose !== "navigator") {
    return Effect.void;
  }
  if (input.runtimeMode !== undefined && input.runtimeMode !== NAVIGATOR_RUNTIME_MODE) {
    return Effect.fail(
      invariantError(
        input.commandType,
        `Thread '${input.thread.id}' is a navigator thread and stays in runtimeMode '${NAVIGATOR_RUNTIME_MODE}'. It cannot be moved to '${input.runtimeMode}'.`,
      ),
    );
  }
  if (input.interactionMode !== undefined && input.interactionMode !== NAVIGATOR_INTERACTION_MODE) {
    return Effect.fail(
      invariantError(
        input.commandType,
        `Thread '${input.thread.id}' is a navigator thread and stays in interactionMode '${NAVIGATOR_INTERACTION_MODE}'. It cannot be moved to '${input.interactionMode}'.`,
      ),
    );
  }
  return Effect.void;
}

/**
 * A Navigator thread never acquires a checkout after the fact.
 *
 * The create-time rule would be worth nothing if the next command could attach
 * a branch or a worktree to the same thread. Clearing them (`null`) stays
 * allowed, because that only re-asserts the state a Navigator thread is
 * already in.
 */
export function requireNavigatorCheckoutUnchanged(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly thread: OrchestrationThread;
  readonly branch?: string | null | undefined;
  readonly worktreePath?: string | null | undefined;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (input.thread.purpose !== "navigator") {
    return Effect.void;
  }
  const attached = input.branch != null ? "branch" : input.worktreePath != null ? "worktree" : null;
  if (attached === null) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `Thread '${input.thread.id}' is a navigator thread and cannot be given a ${attached}. Navigator threads plan against the project and own no checkout.`,
    ),
  );
}

/**
 * Decisions that would hand a Navigator thread the ability to act.
 *
 * An accepted approval is the one path where a read-only thread stops being
 * read-only: the provider asked to run something and the owner said yes.
 * Refused for Navigator threads at the same boundary as everything else, so a
 * client that renders the buttons anyway still cannot get one through.
 *
 * `decline` and `cancel` stay allowed on purpose. They only clear a pending
 * request, and blocking them would strand a Navigator thread with a question it
 * could never answer.
 */
const NAVIGATOR_FORBIDDEN_APPROVAL_DECISIONS: ReadonlySet<ProviderApprovalDecision> = new Set([
  "accept",
  "acceptForSession",
]);

export function requireNavigatorApprovalDecisionAllowed(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly thread: OrchestrationThread;
  readonly decision: ProviderApprovalDecision;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (input.thread.purpose !== "navigator") {
    return Effect.void;
  }
  if (!NAVIGATOR_FORBIDDEN_APPROVAL_DECISIONS.has(input.decision)) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `Thread '${input.thread.id}' is a navigator thread and cannot approve '${input.decision}'. Navigator threads plan; decline or cancel the request instead.`,
    ),
  );
}

/**
 * Controls that only make sense over a coding thread's own history.
 *
 * Reverting a checkpoint rewinds a worktree. A Navigator thread has none, and
 * accepting the command would mean acting on somebody else's checkout.
 */
export function requireNotNavigatorThread(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly thread: OrchestrationThread;
  readonly reason: string;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (input.thread.purpose !== "navigator") {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `Thread '${input.thread.id}' is a navigator thread. ${input.reason}`,
    ),
  );
}

/**
 * The one moment a proposal/run association can be established.
 *
 * The link is immutable and there is no command that edits or removes one, so
 * every rule about it has to hold here. Four things are checked, and each one
 * failing means something different:
 *
 *   - the thread is a Navigator thread. A coding thread has no Execution
 *     Proposals to run and must not collect run ids;
 *   - the proposal exists on *that* thread. A plan id from another conversation
 *     would attach a run to work it did not come from;
 *   - the proposal has not already been executed. One proposal, one run — a
 *     second link would make "which run did this plan produce" ambiguous;
 *   - the run id is unlinked anywhere in the read model. Peer Loop run ids are
 *     unique, so the same id arriving twice is a bug or a replay, not two runs.
 *
 * Refusals name the conflicting thread and plan because an operator has to be
 * able to find them; nothing else about either is disclosed.
 */
export function requirePeerLoopExecutionLinkable(input: {
  readonly readModel: OrchestrationReadModel;
  readonly commandType: OrchestrationCommand["type"];
  readonly thread: OrchestrationThread;
  readonly proposedPlanId: string;
  readonly runId: string;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (input.thread.purpose !== "navigator") {
    return Effect.fail(
      invariantError(
        input.commandType,
        `Thread '${input.thread.id}' is a coding thread. Only a navigator thread's execution proposals launch Peer Loop runs.`,
      ),
    );
  }

  const plan = input.thread.proposedPlans.find((entry) => entry.id === input.proposedPlanId);
  if (plan === undefined) {
    return Effect.fail(
      invariantError(
        input.commandType,
        `Proposed plan '${input.proposedPlanId}' does not exist on thread '${input.thread.id}'.`,
      ),
    );
  }

  const existingForPlan = input.thread.peerLoopExecutions.find(
    (execution) => execution.proposedPlanId === input.proposedPlanId,
  );
  if (existingForPlan !== undefined) {
    // Idempotent re-link is still refused: the caller is the coordination
    // service, which knows whether it already recorded this, and silently
    // accepting would hide a double-launch.
    return Effect.fail(
      invariantError(
        input.commandType,
        `Proposed plan '${input.proposedPlanId}' on thread '${input.thread.id}' is already linked to Peer Loop run '${existingForPlan.runId}'.`,
      ),
    );
  }

  for (const thread of input.readModel.threads) {
    const existingForRun = thread.peerLoopExecutions.find(
      (execution) => execution.runId === input.runId,
    );
    if (existingForRun !== undefined) {
      return Effect.fail(
        invariantError(
          input.commandType,
          `Peer Loop run '${input.runId}' is already linked to proposed plan '${existingForRun.proposedPlanId}' on thread '${thread.id}'.`,
        ),
      );
    }
  }

  return Effect.void;
}

export function requireNonNegativeInteger(input: {
  readonly commandType: OrchestrationCommand["type"];
  readonly field: string;
  readonly value: number;
}): Effect.Effect<void, OrchestrationCommandInvariantError> {
  if (Number.isInteger(input.value) && input.value >= 0) {
    return Effect.void;
  }
  return Effect.fail(
    invariantError(
      input.commandType,
      `${input.field} must be an integer greater than or equal to 0.`,
    ),
  );
}
