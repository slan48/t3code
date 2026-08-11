/**
 * NavigatorExecutionContext - what Navigator knows about its own child runs.
 *
 * A Navigator conversation that has launched Peer Loop runs should be able to
 * answer "what happened with that?" without the Owner leaving to read the
 * inspector. This service assembles that answer once per turn, from Peer Loop's
 * structured records, and hands it to the shared provider-command boundary as a
 * bounded block of text.
 *
 * IT IS A READER. `listRuns`, the read-only snapshot `attachRun`, and — only
 * when the Owner explicitly asks for detail — one finite `subscribeEvents`
 * replay. No start, resume, pause, recover or owner message is reachable from
 * here, and none is imported. Orchestration supplies the immutable proposal/run
 * links; Peer Loop supplies every mutable fact about them, live, every turn.
 * Nothing is cached and no run state is copied into T3 Code's own model.
 *
 * WHAT IT COSTS, PER TURN, AT MOST: one `listRuns` scoped to the conversation's
 * own project, and four `attachRun` snapshots — only for links Peer Loop has
 * just reported as DONE or OWNER_REQUIRED, where a second read says something
 * the list cannot. A conversation with no links costs nothing at all and never
 * touches Peer Loop, which is what keeps an install that has never used the
 * feature from spawning the bridge on an ordinary Navigator turn.
 *
 * PLUS, FOR AN EXPLICIT DEEPER QUESTION ONLY: one replay subscription, for one
 * linked run, consumed to its `run-synced` boundary and released. It is never
 * a live tail — the stream is taken until the boundary and closed there, so no
 * later event is ever observed — and it is bounded twice over, by a read
 * timeout and by a rolling window of retained records. An ordinary status
 * question opens no subscription at all.
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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { selectDetailTarget } from "./navigatorDetailRequest.ts";
import { PeerLoopService } from "./Service.ts";
import {
  activityRecordFromEvent,
  appendBoundedActivity,
  detailFromSnapshot,
  factsFromSummary,
  NAVIGATOR_ACTIVITY_MAX_EVENTS,
  renderNavigatorExecutionContext,
  selectAttachTargets,
  selectRecentExecutionLinks,
  type NavigatorActivityRecord,
  type NavigatorActivitySection,
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
  readonly forThread: (input: {
    readonly thread: NavigatorExecutionContextThread;
    /**
     * The Owner's message for this turn, exactly as persisted.
     *
     * Read only to decide whether they asked for detail. It is never sent, and
     * the persisted message, the timeline and title generation are untouched.
     */
    readonly ownerMessageText: string;
  }) => Effect.Effect<string | null>;
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

/**
 * How long a deeper question may wait for a replay.
 *
 * A provider turn is blocked while this runs, so the ceiling is the point: a
 * bridge that is slow, wedged, or replaying an enormous log costs the Owner a
 * few seconds and one sentence saying so, not a conversation that never
 * answers. Nothing is retried — a second replay would cost the same again.
 */
const ACTIVITY_READ_TIMEOUT = Duration.seconds(8);

/** What one replay is folded into while it is being consumed. */
interface ReplayFold {
  readonly records: ReadonlyArray<NavigatorActivityRecord>;
  /** Every `run-event` seen, so truncation can be reported honestly. */
  readonly seen: number;
  readonly resynced: boolean;
  readonly synced: boolean;
}

/** A conversation with no execution links adds nothing and asks nothing. */
const NO_CONTEXT = Effect.succeed(null);

const make = Effect.gen(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const peerLoop = yield* PeerLoopService;

  /**
   * Peer Loop's view of this project, or the fact that there isn't one.
   *
   * `Effect.catch`, NOT `Effect.catchCause`. Only the typed `PeerLoopError`
   * channel degrades — the bridge is not installed, refused, timed out. A
   * defect is a bug in this process and an interruption is the turn being
   * cancelled; dressing either as "Peer Loop is unavailable" would report a
   * crash as a remote status and would keep a cancelled fiber running.
   *
   * The error itself is logged and never returned: a `PeerLoopError` carries a
   * refusal detail, a transport message or a protocol excerpt, and none of that
   * should be describable to a model.
   */
  const readRuns = Effect.fn("NavigatorExecutionContext.readRuns")(function* (projectPath: string) {
    return yield* peerLoop.listRuns({ projectPath }).pipe(
      Effect.map((result) => ({
        runs: result.runs,
        unreadable: result.unreadable,
        failed: false as const,
      })),
      Effect.catch((error) =>
        Effect.logWarning("navigator execution context could not read Peer Loop runs", {
          // Logged, never rendered.
          error,
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
      // Typed failures only, for the same reason as `readRuns` above.
      Effect.catch((error) =>
        Effect.logWarning("navigator execution context could not read a run snapshot", {
          runId: input.runId,
          error,
        }).pipe(Effect.as({ kind: "unavailable" } as const)),
      ),
    );
  });

  /**
   * One run's durable replay, folded into a bounded tail and released.
   *
   * FINITE BY CONSTRUCTION, THREE WAYS. `Stream.takeUntil` ends the stream at
   * the `run-synced` boundary — the transport fact that says the backlog is
   * behind this subscriber — or at a `run-resync`, so no live event is ever
   * observed and the subscription's scope closes there, releasing Peer Loop's
   * replay coordination. `Effect.timeoutOption` interrupts the whole thing if
   * the boundary never arrives, which closes the same scope. And the fold keeps
   * a rolling window, so memory does not grow with the log.
   *
   * `Effect.catch`, not `catchCause`: a typed `PeerLoopError` degrades to one
   * sentence, while a defect and an interruption travel. Nothing is retried.
   */
  const readActivity = Effect.fn("NavigatorExecutionContext.readActivity")(function* (
    runId: string,
  ): Effect.fn.Return<NavigatorActivitySection> {
    const unavailable: NavigatorActivitySection = {
      runId,
      records: [],
      unavailable: true,
      truncated: false,
    };

    const folded = yield* peerLoop.subscribeEvents({ runId, afterSeq: 0 }).pipe(
      Stream.takeUntil((event) => event.kind === "run-synced" || event.kind === "run-resync"),
      Stream.runFold(
        (): ReplayFold => ({ records: [], seen: 0, resynced: false, synced: false }),
        (accumulator: ReplayFold, event): ReplayFold => {
          if (event.kind === "run-resync") return { ...accumulator, resynced: true };
          if (event.kind === "run-synced") return { ...accumulator, synced: true };
          if (event.kind !== "run-event") return accumulator;
          return {
            ...accumulator,
            seen: accumulator.seen + 1,
            records: appendBoundedActivity(
              accumulator.records,
              activityRecordFromEvent(event.event),
            ),
          };
        },
      ),
      Effect.timeoutOption(ACTIVITY_READ_TIMEOUT),
      Effect.catch((error) =>
        Effect.logWarning("navigator execution context could not replay a run", {
          runId,
          // Logged, never rendered.
          error,
        }).pipe(Effect.as(Option.none())),
      ),
    );

    if (Option.isNone(folded)) {
      yield* Effect.logWarning("navigator execution context replay did not finish in time", {
        runId,
      });
      return unavailable;
    }
    /*
     * A RESYNC IS NOT A READ. It says the stream could not be kept gapless, so
     * whatever arrived before it is an unknown subset of the history — and
     * presenting a subset as "what happened" is worse than saying nothing.
     * Re-subscribing is what a live viewer does; a provider turn does not.
     */
    if (folded.value.resynced) return unavailable;
    return {
      runId,
      records: folded.value.records,
      unavailable: false,
      truncated: folded.value.seen > NAVIGATOR_ACTIVITY_MAX_EVENTS,
    };
  });

  const forThread = Effect.fn("NavigatorExecutionContext.forThread")(function* (input: {
    readonly thread: NavigatorExecutionContextThread;
    readonly ownerMessageText: string;
  }): Effect.fn.Return<string | null> {
    const thread = input.thread;
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
    if (listed.failed) {
      /*
       * A FAILED READ ESTABLISHES NOTHING ABOUT ANY RUN.
       *
       * It says T3 Code could not ask, not that a run is missing or unreadable
       * — those are answers a *successful* list gives. Rendering entries from
       * an empty substitute list would tell the model "Peer Loop is not
       * currently listing this run" about runs that are very likely fine. One
       * bounded sentence, no per-run claims, and no attach attempts.
       */
      return renderNavigatorExecutionContext({ entries: [], degraded: "status-unavailable" });
    }

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

    /*
     * The compact facts are built first and always. Detail is an addition to
     * them, never a replacement: if the replay fails the Owner still gets the
     * status, and if it succeeds the status is still what the model reads
     * first.
     */
    const target = selectDetailTarget({ text: input.ownerMessageText, links });
    if (target.kind === "none") return renderNavigatorExecutionContext({ entries });
    return renderNavigatorExecutionContext({
      entries,
      activity: yield* readActivity(target.runId),
    });
  });

  return NavigatorExecutionContext.of({ forThread });
});

export const layer = Layer.effect(NavigatorExecutionContext, make);
