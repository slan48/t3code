/**
 * NavigatorExecutionContext - what Navigator knows about its own child runs.
 *
 * A Navigator conversation that has launched Peer Loop runs should be able to
 * answer "what happened with that?" without the Owner leaving to read the
 * inspector. This service assembles that answer once per turn, from Peer Loop's
 * structured records, and hands it to the shared provider-command boundary as a
 * bounded block of text.
 *
 * IT IS A READER. It calls `listRuns` and the read-only snapshot `attachRun`
 * and nothing else — no start, resume, pause, recover, owner message or event
 * subscription is reachable from here, and none is imported. Orchestration
 * supplies the immutable proposal/run links; Peer Loop supplies every mutable
 * fact about them, live, every turn. Nothing is cached and no run state is
 * copied into T3 Code's own model.
 *
 * WHAT IT COSTS, PER TURN, AT MOST: one `listRuns` scoped to the conversation's
 * own project, and four `attachRun` snapshots — only for links Peer Loop has
 * just reported as DONE or OWNER_REQUIRED, where a second read says something
 * the list cannot. A conversation with no links costs nothing at all and never
 * touches Peer Loop, which is what keeps an install that has never used the
 * feature from spawning the bridge on an ordinary Navigator turn.
 *
 * FAILURE IS NOT FATAL AND NOT DETAILED. A refused, unavailable or timed-out
 * read degrades to one neutral sentence; the turn proceeds. Nothing from the
 * Cause reaches the provider, because a bridge error is exactly the kind of
 * text that carries paths and diagnostics.
 *
 * @module NavigatorExecutionContext
 */
import type { OrchestrationThread, PeerLoopRunSummary, ProjectId } from "@t3tools/contracts";
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PeerLoopService } from "./Service.ts";
import {
  detailFromSnapshot,
  factsFromSummary,
  renderNavigatorExecutionContext,
  selectAttachTargets,
  selectRecentExecutionLinks,
  type NavigatorExecutionDetail,
  type NavigatorExecutionEntry,
  type NavigatorExecutionFacts,
} from "./navigatorExecutionContextFormat.ts";

/** The thread facts this needs. A subset, so a test can supply an honest one. */
export interface NavigatorExecutionContextThread {
  readonly id: ThreadId;
  readonly purpose: OrchestrationThread["purpose"];
  readonly projectId: ProjectId;
  readonly peerLoopExecutions: OrchestrationThread["peerLoopExecutions"];
}

export interface NavigatorExecutionContextShape {
  /**
   * The provider-visible execution block for this turn, or null.
   *
   * Never fails: a conversation must not be blocked because Peer Loop could not
   * be read. Null means "add nothing", which is the answer for every coding
   * thread and every Navigator thread with no links.
   */
  readonly forThread: (thread: NavigatorExecutionContextThread) => Effect.Effect<string | null>;
}

export class NavigatorExecutionContext extends Context.Service<
  NavigatorExecutionContext,
  NavigatorExecutionContextShape
>()("t3/peerLoop/NavigatorExecutionContext") {}

/**
 * How many snapshot reads run at once.
 *
 * Two, not four: they share one bridge connection and one replay coordinator,
 * so the wall-clock gain past a couple is small and the queueing is not. Result
 * order is preserved by `Effect.forEach` regardless of concurrency, which is
 * what keeps the rendered block deterministic.
 */
const ATTACH_CONCURRENCY = 2;

/** A conversation with no execution links adds nothing and asks nothing. */
const NO_CONTEXT = Effect.succeed(null);

const make = Effect.gen(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const peerLoop = yield* PeerLoopService;

  /**
   * Peer Loop's view of this project, or the reason there isn't one.
   *
   * The failure is swallowed here deliberately and only the category survives.
   * A `PeerLoopError` carries a refusal detail, a transport message or a
   * protocol excerpt, and none of that should be describable to a model.
   */
  const readRuns = Effect.fn("NavigatorExecutionContext.readRuns")(function* (projectPath: string) {
    return yield* peerLoop.listRuns({ projectPath }).pipe(
      Effect.map((result) => ({
        runs: result.runs,
        unreadable: result.unreadable,
        failed: false as const,
      })),
      Effect.catchCause((cause) =>
        Effect.logWarning("navigator execution context could not read Peer Loop runs", {
          // Logged, never rendered.
          cause,
        }).pipe(
          Effect.as({
            runs: [] as ReadonlyArray<PeerLoopRunSummary>,
            unreadable: [] as ReadonlyArray<string>,
            failed: true as const,
          }),
        ),
      ),
    );
  });

  /**
   * One run's structured decision, or "unavailable".
   *
   * A failed attach is a fact about one card, not about the turn: the rest of
   * the context still renders and the provider request still goes out.
   */
  const readDetail = Effect.fn("NavigatorExecutionContext.readDetail")(function* (input: {
    readonly runId: string;
    readonly expected: "done" | "owner-required";
  }): Effect.fn.Return<NavigatorExecutionDetail> {
    return yield* peerLoop.attachRun({ runId: input.runId }).pipe(
      Effect.map((snapshot) =>
        detailFromSnapshot({ state: snapshot.state, expected: input.expected }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("navigator execution context could not read a run snapshot", {
          runId: input.runId,
          cause,
        }).pipe(Effect.as({ kind: "unavailable" } as const)),
      ),
    );
  });

  const forThread = Effect.fn("NavigatorExecutionContext.forThread")(function* (
    thread: NavigatorExecutionContextThread,
  ): Effect.fn.Return<string | null> {
    // THE TWO ZERO-QUERY CASES, BEFORE ANYTHING ELSE. A coding thread and a
    // Navigator thread that has executed nothing must reach neither the
    // projection nor the bridge, so both return here rather than being filtered
    // out further down.
    if (thread.purpose !== "navigator") return yield* NO_CONTEXT;
    if (thread.peerLoopExecutions.length === 0) return yield* NO_CONTEXT;

    const links = selectRecentExecutionLinks(thread.peerLoopExecutions);

    const projectOption = yield* snapshotQuery
      .getProjectShellById(thread.projectId)
      .pipe(Effect.catchCause(() => Effect.succeed(Option.none())));
    if (Option.isNone(projectOption)) {
      // No canonical workspace root means no project-scoped list to ask for,
      // and an unscoped one would return other projects' runs.
      return renderNavigatorExecutionContext({
        entries: [],
        degraded: "records-unavailable",
      });
    }

    const listed = yield* readRuns(projectOption.value.workspaceRoot);
    const summaryByRunId = new Map<string, PeerLoopRunSummary>(
      listed.runs.map((run) => [run.runId, run]),
    );
    const unreadable = new Set(listed.unreadable);

    // Joined strictly by linked run id: a run in the same project that this
    // conversation did not launch is not this conversation's business.
    const joined = links.map((link) => {
      const summary = summaryByRunId.get(link.runId);
      const facts: NavigatorExecutionFacts | null =
        summary === undefined ? null : factsFromSummary(summary);
      return {
        runId: link.runId,
        proposedPlanId: link.proposedPlanId,
        linkedAt: link.createdAt,
        facts,
        unreadable: unreadable.has(link.runId),
      };
    });

    const attachTargets = new Set(selectAttachTargets(joined));
    const details = yield* Effect.forEach(
      joined,
      (entry) => {
        if (!attachTargets.has(entry.runId) || entry.facts === null) {
          return Effect.succeed({ kind: "none" } as const satisfies NavigatorExecutionDetail);
        }
        return readDetail({
          runId: entry.runId,
          expected: entry.facts.state === "done" ? "done" : "owner-required",
        });
      },
      { concurrency: ATTACH_CONCURRENCY },
    );

    const entries: ReadonlyArray<NavigatorExecutionEntry> = joined.map((entry, index) => ({
      ...entry,
      detail: details[index] ?? { kind: "none" },
    }));

    return renderNavigatorExecutionContext({
      entries,
      ...(listed.failed ? { degraded: "status-unavailable" as const } : {}),
    });
  });

  return NavigatorExecutionContext.of({ forThread });
});

export const layer = Layer.effect(NavigatorExecutionContext, make);
