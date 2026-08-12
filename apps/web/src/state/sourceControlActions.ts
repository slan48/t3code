import { useAtomValue } from "@effect/atom-react";
import type {
  AtomCommandFailure,
  AtomCommandResult,
  AtomCommandSuccess,
} from "@t3tools/client-runtime/state/runtime";
import {
  VcsActionUnavailableError,
  type VcsActionOperation,
} from "@t3tools/client-runtime/state/vcs";
import type {
  EnvironmentId,
  GitActionProgressEvent,
  GitResolvePullRequestResult,
  GitStackedAction,
  SourceControlCloneProtocol,
  SourceControlRepositoryVisibility,
  ThreadId,
} from "@t3tools/contracts";
import { SourceControlThreadForbiddenError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { gitEnvironment } from "./git";
import { useEnvironmentQuery } from "./query";
import { sourceControlEnvironment } from "./sourceControl";
import { useAtomCommand } from "./use-atom-command";
import { vcsActionManager, vcsEnvironment } from "./vcs";

export type SourceControlActionKind =
  | "init"
  | "pull"
  | "publishRepository"
  | "runStackedAction"
  | "preparePullRequestThread";

export interface SourceControlActionScope {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  /**
   * Which conversation is asking, and whether it may ask at all.
   *
   * HIDING THE CONTROL IS NOT THE GUARANTEE. A dialog that was already open
   * when the thread changed, a toast retry, or a callback captured before the
   * capability flipped can all still fire; this is where such a call is refused
   * without a request leaving the browser. The server refuses it again from its
   * own read model — this only keeps T3 Code from asking for something it knows
   * is not allowed.
   *
   * Omitted entirely by callers with no originating conversation, which stay
   * exactly as they were.
   */
  readonly mutation?: SourceControlMutationOrigin;
}

export interface SourceControlMutationOrigin {
  /** The durable thread, or null for a draft/unscoped caller. */
  readonly threadId: ThreadId | null;
  /** `ThreadCapabilities.canUseSourceControlActions`. */
  readonly allowed: boolean;
}

export type SourceControlMutationGate =
  | {
      readonly kind: "refused";
      readonly result: AsyncResult.Failure<never, SourceControlThreadForbiddenError>;
    }
  | { readonly kind: "allowed"; readonly origin: { readonly originThreadId?: ThreadId } };

/**
 * The one thing every mutating action in this module asks before dispatching.
 *
 * Two answers in one place so they cannot drift apart: whether this scope may
 * mutate at all, and — when it may — the origin the request has to carry so the
 * server can decide again from its own read model. A caller that skipped this
 * would both bypass the local refusal and send a request the server cannot
 * attribute, so there is deliberately no second way to build either.
 *
 * The refusal is the same typed error the server sends back, so a surface
 * presenting it does not need to know which side said no.
 */
export function sourceControlMutationGate(
  scope: SourceControlActionScope,
  operation: string,
): SourceControlMutationGate {
  const mutation = scope.mutation;
  if (mutation !== undefined && !mutation.allowed) {
    return {
      kind: "refused",
      result: AsyncResult.failure<never, SourceControlThreadForbiddenError>(
        Cause.fail(
          new SourceControlThreadForbiddenError({
            operation,
            reason: "navigator_thread",
            threadId: mutation.threadId,
            detail:
              "This conversation cannot change the repository. Open the coding thread that owns this checkout.",
          }),
        ),
      ),
    };
  }
  const threadId = mutation?.threadId ?? null;
  return {
    kind: "allowed",
    origin: threadId === null ? {} : { originThreadId: threadId },
  };
}

interface SourceControlActionState<
  TArgs extends ReadonlyArray<unknown>,
  R extends AtomCommandResult<unknown, unknown>,
> {
  readonly isPending: boolean;
  readonly error: unknown;
  readonly run: (
    ...args: TArgs
  ) => Promise<
    AtomCommandResult<AtomCommandSuccess<R>, AtomCommandFailure<R> | VcsActionUnavailableError>
  >;
  readonly resetError: () => void;
}

const ACTION_OPERATION = {
  init: "init",
  pull: "pull",
  publishRepository: "publish_repository",
  runStackedAction: "run_change_request",
  preparePullRequestThread: "prepare_pull_request_thread",
} as const satisfies Record<SourceControlActionKind, VcsActionOperation>;

function useAction<
  TArgs extends ReadonlyArray<unknown>,
  R extends AtomCommandResult<unknown, unknown>,
>(input: {
  readonly kind: SourceControlActionKind;
  readonly label: string;
  readonly scope: SourceControlActionScope;
  readonly action: (...args: TArgs) => Promise<R>;
  readonly onSuccess?: () => void;
  readonly managedExternally?: boolean;
}): SourceControlActionState<TArgs, R> {
  const operation = ACTION_OPERATION[input.kind];
  const state = useAtomValue(vcsActionManager.stateAtom(input.scope));
  const ownsState = state.operation === operation;

  const resetError = useCallback(() => {
    vcsActionManager.resetError(appAtomRegistry, input.scope, operation);
  }, [input.scope, operation]);

  const run = useCallback(
    async (...args: TArgs) => {
      const execute = async (): Promise<
        AtomCommandResult<AtomCommandSuccess<R>, AtomCommandFailure<R>>
      > => {
        const result = await input.action(...args);
        if (AsyncResult.isSuccess(result)) {
          input.onSuccess?.();
        }
        return result as AtomCommandResult<AtomCommandSuccess<R>, AtomCommandFailure<R>>;
      };
      return input.managedExternally === true
        ? execute()
        : vcsActionManager.track(
            appAtomRegistry,
            input.scope,
            {
              operation,
              label: input.label,
            },
            execute,
          );
    },
    [input.action, input.label, input.managedExternally, input.onSuccess, input.scope, operation],
  );

  return {
    error: ownsState ? state.error : null,
    isPending: ownsState && state.isRunning,
    resetError,
    run,
  };
}

function resolveScope(scope: SourceControlActionScope) {
  if (scope.environmentId === null || scope.cwd === null) {
    return null;
  }
  return {
    environmentId: scope.environmentId,
    cwd: scope.cwd,
  };
}

export function useSourceControlActionRunning(
  scope: SourceControlActionScope,
  kinds: ReadonlyArray<SourceControlActionKind>,
): boolean {
  const state = useAtomValue(vcsActionManager.stateAtom(scope));
  return (
    state.isRunning &&
    state.operation !== null &&
    kinds.some((kind) => ACTION_OPERATION[kind] === state.operation)
  );
}

export function useVcsInitAction(scope: SourceControlActionScope) {
  const init = useAtomCommand(vcsEnvironment.init, { reportFailure: false });
  const action = useCallback(async () => {
    const gate = sourceControlMutationGate(scope, "vcs.init");
    if (gate.kind === "refused") return gate.result;
    const target = resolveScope(scope);
    if (target === null) {
      return AsyncResult.failure<never, VcsActionUnavailableError>(
        Cause.fail(
          new VcsActionUnavailableError({
            operation: "init",
            environmentId: scope.environmentId,
            cwd: scope.cwd,
          }),
        ),
      );
    }
    return init({
      environmentId: target.environmentId,
      input: { cwd: target.cwd },
    });
  }, [init, scope]);
  return useAction({ kind: "init", label: "Initializing repository", scope, action });
}

export function useVcsPullAction(scope: SourceControlActionScope) {
  const pull = useAtomCommand(vcsEnvironment.pull, { reportFailure: false });
  const status = useEnvironmentQuery(
    scope.environmentId !== null && scope.cwd !== null
      ? vcsEnvironment.status({
          environmentId: scope.environmentId,
          input: { cwd: scope.cwd },
        })
      : null,
  );
  const action = useCallback(async () => {
    const gate = sourceControlMutationGate(scope, "vcs.pull");
    if (gate.kind === "refused") return gate.result;
    const target = resolveScope(scope);
    if (target === null) {
      return AsyncResult.failure<never, VcsActionUnavailableError>(
        Cause.fail(
          new VcsActionUnavailableError({
            operation: "pull",
            environmentId: scope.environmentId,
            cwd: scope.cwd,
          }),
        ),
      );
    }
    return pull({
      environmentId: target.environmentId,
      input: { cwd: target.cwd },
    });
  }, [pull, scope]);
  return useAction({
    kind: "pull",
    label: "Pulling latest changes",
    scope,
    action,
    onSuccess: status.refresh,
  });
}

export function useGitStackedAction(scope: SourceControlActionScope) {
  const runStackedAction = useAtomCommand(vcsActionManager.runStackedAction(scope), {
    reportFailure: false,
  });
  const status = useEnvironmentQuery(
    scope.environmentId !== null && scope.cwd !== null
      ? vcsEnvironment.status({
          environmentId: scope.environmentId,
          input: { cwd: scope.cwd },
        })
      : null,
  );

  const action = useCallback(
    async (input: {
      actionId: string;
      action: GitStackedAction;
      commitMessage?: string;
      featureBranch?: boolean;
      filePaths?: string[];
      onProgress?: (event: GitActionProgressEvent) => void;
    }) => {
      // Checked at dispatch, not at render: this is the last point a stale
      // callback or a dialog left open across a thread change can be stopped.
      const gate = sourceControlMutationGate(scope, "git.runStackedAction");
      if (gate.kind === "refused") return gate.result;
      if (resolveScope(scope) === null) {
        return AsyncResult.failure<never, VcsActionUnavailableError>(
          Cause.fail(
            new VcsActionUnavailableError({
              operation: "run_change_request",
              environmentId: scope.environmentId,
              cwd: scope.cwd,
            }),
          ),
        );
      }
      return runStackedAction({
        actionId: input.actionId,
        action: input.action,
        ...gate.origin,
        ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
        ...(input.featureBranch ? { featureBranch: true } : {}),
        ...(input.filePaths?.length ? { filePaths: input.filePaths } : {}),
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      });
    },
    [runStackedAction, scope],
  );

  return useAction({
    kind: "runStackedAction",
    label: "Running source control action",
    scope,
    action,
    onSuccess: status.refresh,
    managedExternally: true,
  });
}

export function useSourceControlPublishRepositoryAction(scope: SourceControlActionScope) {
  const publishRepository = useAtomCommand(sourceControlEnvironment.publishRepository, {
    reportFailure: false,
  });
  const status = useEnvironmentQuery(
    scope.environmentId !== null && scope.cwd !== null
      ? vcsEnvironment.status({
          environmentId: scope.environmentId,
          input: { cwd: scope.cwd },
        })
      : null,
  );
  const action = useCallback(
    async (input: {
      provider: "github" | "gitlab" | "bitbucket" | "azure-devops";
      repository: string;
      visibility: SourceControlRepositoryVisibility;
      remoteName: string;
      protocol: SourceControlCloneProtocol;
    }) => {
      const gate = sourceControlMutationGate(scope, "sourceControl.publishRepository");
      if (gate.kind === "refused") return gate.result;
      const target = resolveScope(scope);
      if (target === null) {
        return AsyncResult.failure<never, VcsActionUnavailableError>(
          Cause.fail(
            new VcsActionUnavailableError({
              operation: "publish_repository",
              environmentId: scope.environmentId,
              cwd: scope.cwd,
            }),
          ),
        );
      }
      return publishRepository({
        environmentId: target.environmentId,
        input: {
          cwd: target.cwd,
          ...input,
          ...gate.origin,
        },
      });
    },
    [publishRepository, scope],
  );
  return useAction({
    kind: "publishRepository",
    label: "Publishing repository",
    scope,
    action,
    onSuccess: status.refresh,
  });
}

export function usePreparePullRequestThreadAction(scope: SourceControlActionScope) {
  const preparePullRequestThread = useAtomCommand(gitEnvironment.preparePullRequestThread, {
    reportFailure: false,
  });
  const action = useCallback(
    async (input: { reference: string; mode: "local" | "worktree"; threadId?: ThreadId }) => {
      const target = resolveScope(scope);
      if (target === null) {
        return AsyncResult.failure<never, VcsActionUnavailableError>(
          Cause.fail(
            new VcsActionUnavailableError({
              operation: "prepare_pull_request_thread",
              environmentId: scope.environmentId,
              cwd: scope.cwd,
            }),
          ),
        );
      }
      return preparePullRequestThread({
        environmentId: target.environmentId,
        input: {
          cwd: target.cwd,
          reference: input.reference,
          mode: input.mode,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        },
      });
    },
    [preparePullRequestThread, scope],
  );
  return useAction({
    kind: "preparePullRequestThread",
    label: "Preparing pull request thread",
    scope,
    action,
  });
}

export interface PullRequestResolutionTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly reference: string | null;
}

export function readCachedPullRequestResolution(
  target: PullRequestResolutionTarget,
): GitResolvePullRequestResult | null {
  if (target.environmentId === null || target.cwd === null || target.reference === null) {
    return null;
  }
  return Option.getOrNull(
    AsyncResult.value(
      appAtomRegistry.get(
        gitEnvironment.pullRequestResolution({
          environmentId: target.environmentId,
          input: { cwd: target.cwd, reference: target.reference },
        }),
      ),
    ),
  );
}

export function usePullRequestResolutionState(target: PullRequestResolutionTarget) {
  const query = useEnvironmentQuery(
    target.environmentId !== null && target.cwd !== null && target.reference !== null
      ? gitEnvironment.pullRequestResolution({
          environmentId: target.environmentId,
          input: {
            cwd: target.cwd,
            reference: target.reference,
          },
        })
      : null,
  );
  const cached = readCachedPullRequestResolution(target);

  return {
    data: query.data ?? cached,
    error: query.error,
    isPending: query.isPending && cached === null,
    isFetching: query.isPending,
    refresh: query.refresh,
  };
}
