/**
 * Which conversations may mutate a repository.
 *
 * A Navigator conversation plans; it does not commit, push, open a pull
 * request, or publish a repository to a hosting provider. The chat surface
 * already declines to draw those controls, but that is presentation: the
 * mutating source-control RPCs take a `cwd` and an action, and a `cwd` cannot
 * say which conversation asked. Two threads on the same machine — one Navigator
 * and one coding — name the same directory, so nothing below this point can
 * tell them apart.
 *
 * SO THE ANSWER IS RESOLVED HERE, FROM THE SERVER'S OWN PROJECTION, NOT FROM
 * THE REQUEST. The request supplies a thread id and nothing else; the purpose
 * that decides the outcome is read from the thread row. A client cannot declare
 * itself a coding thread.
 *
 * Deliberately not in `GitManager` or the repository providers. Those run Git
 * for whoever asks and have no notion of a conversation; putting a purpose
 * check down there would scatter the same policy across every command and still
 * leave the decision after the point where a caller could act. This is a gate
 * in front of the side effect, called by the RPC handlers that own it.
 *
 * @module SourceControlThreadPolicy
 */
import { SourceControlThreadForbiddenError, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";

/**
 * Refuse a repository mutation that came from a conversation that may not make
 * one.
 *
 * Three outcomes, and the middle one is the one worth stating:
 *
 *   - no thread id: allowed. Project-level and non-chat callers genuinely have
 *     no originating conversation, and inventing one for them would break them
 *     without protecting anything;
 *   - a thread id that does not resolve to an active thread: REFUSED. Treating
 *     an unresolvable id as unscoped would make "send a thread id nobody has"
 *     the way around this rule, which is worse than sending none at all;
 *   - a thread whose purpose is `navigator`: refused.
 *
 * A projection read failure is refused too, as `thread_lookup_failed`. Failing
 * open on an infrastructure error would let through exactly the request this
 * exists to stop, and "the server could not tell which conversation asked" is
 * not a reason to commit on its behalf.
 */
export function requireSourceControlMutationAllowed(input: {
  readonly projectionSnapshotQuery: Pick<ProjectionSnapshotQueryShape, "getThreadShellById">;
  readonly operation: string;
  readonly originThreadId: ThreadId | undefined;
}): Effect.Effect<void, SourceControlThreadForbiddenError> {
  const originThreadId = input.originThreadId;
  if (originThreadId === undefined) return Effect.void;

  return input.projectionSnapshotQuery.getThreadShellById(originThreadId).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new SourceControlThreadForbiddenError({
              operation: input.operation,
              reason: "unknown_thread",
              threadId: originThreadId,
              detail:
                "This request named a conversation this server does not have. Nothing was changed.",
            }),
          ),
        onSome: (thread) =>
          thread.purpose === "navigator"
            ? Effect.fail(
                new SourceControlThreadForbiddenError({
                  operation: input.operation,
                  reason: "navigator_thread",
                  threadId: originThreadId,
                  detail:
                    "A Navigator conversation plans work; it does not change the repository. Open the coding thread that owns this checkout to commit, push or publish.",
                }),
              )
            : Effect.void,
      }),
    ),
    Effect.catchTag("PersistenceDecodeError", (cause) => threadLookupFailed(input, cause)),
    Effect.catchTag("PersistenceSqlError", (cause) => threadLookupFailed(input, cause)),
  );
}

const threadLookupFailed = (
  input: { readonly operation: string; readonly originThreadId: ThreadId | undefined },
  cause: ProjectionRepositoryError,
): Effect.Effect<never, SourceControlThreadForbiddenError> =>
  Effect.fail(
    new SourceControlThreadForbiddenError({
      operation: input.operation,
      reason: "thread_lookup_failed",
      threadId: input.originThreadId ?? null,
      detail:
        "This server could not read which conversation this request came from, so it changed nothing.",
      cause,
    }),
  );
