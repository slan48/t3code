/**
 * PeerLoopService - T3Code's control surface over a local Peer Loop bridge.
 *
 * Peer Loop is the engine. It owns the owner policy, the run lifecycle, the
 * durable event log, the runtime ownership of a project and every recovery
 * decision. This service forwards owner intent to it over one JSON-lines
 * subprocess and hands back what it says. It does not model runs, does not
 * decide when a run may continue, and never resumes or recovers anything by
 * itself — a bridge that dies takes its transport with it and leaves Peer
 * Loop's durable state exactly where it was.
 *
 * Three properties are worth stating because they are what the rest of the
 * server depends on:
 *
 *   - **Lazy.** Nothing spawns until a Peer Loop RPC is called. An install that
 *     has never heard of Peer Loop pays nothing, and server startup is
 *     unchanged.
 *   - **Single-flight.** Concurrent first calls share one connection attempt,
 *     so a burst of RPCs cannot produce a second bridge — which would be a
 *     second writer contending for the same project leases.
 *   - **Bounded.** T3Code keeps transport state and per-subscriber cursors and
 *     nothing else. Peer Loop's log is the durable record; a client that missed
 *     activity re-attaches from its own `afterSeq` rather than reading a copy
 *     this server was holding for it.
 *
 * @module PeerLoopService
 */
import {
  PEER_LOOP_PROTOCOL_VERSION,
  PeerLoopAttachResult,
  PeerLoopListRunsResult,
  PeerLoopOwnerMessageResult,
  PeerLoopPauseResult,
  PeerLoopProtocolError,
  PeerLoopRecoverResult,
  PeerLoopResumeResult,
  PeerLoopRunsListResult,
  PeerLoopStartResult,
  PeerLoopUnavailableError,
  type PeerLoopAttachRunInput,
  type PeerLoopBridgeMethod,
  type PeerLoopBridgeNotification,
  type PeerLoopError,
  type PeerLoopHealth,
  type PeerLoopListRunsInput,
  type PeerLoopRecoverRunInput,
  type PeerLoopRunIdInput,
  type PeerLoopSendOwnerMessageInput,
  type PeerLoopStartRunInput,
  type PeerLoopStatusInput,
  type PeerLoopStatusResult,
  type PeerLoopSubscribeEventsInput,
  type PeerLoopSubscriptionEvent,
  type PeerLoopTransportStatus,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";

import { connect, type PeerLoopBridgeConnection } from "./Bridge.ts";
import { resolvePeerLoopCommand } from "./Command.ts";

/* ------------------------------------------------------------------ types */

export class PeerLoopService extends Context.Service<
  PeerLoopService,
  {
    /** Never fails: "Peer Loop is not installed here" is an answer, not an error. */
    readonly status: (input: PeerLoopStatusInput) => Effect.Effect<PeerLoopStatusResult>;
    readonly listRuns: (
      input: PeerLoopListRunsInput,
    ) => Effect.Effect<PeerLoopListRunsResult, PeerLoopError>;
    readonly attachRun: (
      input: PeerLoopAttachRunInput,
    ) => Effect.Effect<PeerLoopAttachResult, PeerLoopError>;
    readonly startRun: (
      input: PeerLoopStartRunInput,
    ) => Effect.Effect<PeerLoopStartResult, PeerLoopError>;
    readonly resumeRun: (
      input: PeerLoopRunIdInput,
    ) => Effect.Effect<PeerLoopResumeResult, PeerLoopError>;
    readonly sendOwnerMessage: (
      input: PeerLoopSendOwnerMessageInput,
    ) => Effect.Effect<PeerLoopOwnerMessageResult, PeerLoopError>;
    readonly pauseRun: (
      input: PeerLoopRunIdInput,
    ) => Effect.Effect<PeerLoopPauseResult, PeerLoopError>;
    readonly recoverRun: (
      input: PeerLoopRecoverRunInput,
    ) => Effect.Effect<PeerLoopRecoverResult, PeerLoopError>;
    readonly subscribeEvents: (
      input: PeerLoopSubscribeEventsInput,
    ) => Stream.Stream<PeerLoopSubscriptionEvent, PeerLoopError>;
    /** Bounded stderr tail from the running bridge. Diagnostics only. */
    readonly diagnostics: Effect.Effect<readonly string[]>;
    /**
     * How many runs currently hold replay coordination state.
     *
     * An inspection seam for tests, so "this map cannot grow" is an assertion
     * rather than a hope. Not an RPC and not part of the product API.
     */
    readonly replaySlotCount: Effect.Effect<number>;
  }
>()("t3/peerLoop/Service/PeerLoopService") {}

interface LiveConnection {
  readonly connection: PeerLoopBridgeConnection;
  readonly scope: Scope.Closeable;
}

/**
 * The one attachment Peer Loop keeps per run, guarded on this side.
 *
 * Peer Loop supersedes an in-flight replay when a second `run.attach` arrives
 * for the same run, which would strand whoever asked for the first one. So
 * attaches are serialised here and the slot is only released once the replay
 * has reached the high-water mark the attach itself reported.
 *
 * Reference-counted so a client that names arbitrary run ids cannot grow this
 * map: the entry disappears with its last user.
 */
interface ConnectionClaim {
  /** True for the single caller that won the right to spawn the bridge. */
  readonly opener: boolean;
  readonly deferred: Deferred.Deferred<PeerLoopBridgeConnection, PeerLoopError>;
}

interface RunReplaySlot {
  readonly gate: Semaphore.Semaphore;
  users: number;
}

/** How long a replay may hold its run's slot before it is assumed finished. */
export const PEER_LOOP_REPLAY_BOUNDARY_TIMEOUT = Duration.seconds(30);

const decodeRunsList = Schema.decodeUnknownEffect(PeerLoopRunsListResult);
const decodeAttach = Schema.decodeUnknownEffect(PeerLoopAttachResult);
const decodeStart = Schema.decodeUnknownEffect(PeerLoopStartResult);
const decodeResume = Schema.decodeUnknownEffect(PeerLoopResumeResult);
const decodeOwnerMessage = Schema.decodeUnknownEffect(PeerLoopOwnerMessageResult);
const decodePause = Schema.decodeUnknownEffect(PeerLoopPauseResult);
const decodeRecover = Schema.decodeUnknownEffect(PeerLoopRecoverResult);

/* ---------------------------------------------------------------- service */

export interface PeerLoopServiceSeams {
  /** Injected by tests so a bounded wait is measured in milliseconds. */
  readonly connect?: {
    readonly requestTimeout?: Duration.Duration;
    readonly lifecycleRequestTimeout?: Duration.Duration;
    readonly handshakeTimeout?: Duration.Duration;
    readonly stopTimeout?: Duration.Duration;
  };
  readonly replayBoundaryTimeout?: Duration.Duration;
}

export const make = Effect.fn("peerLoop.Service.make")(function* (
  seams: PeerLoopServiceSeams = {},
) {
  const connectOptions = seams.connect ?? {};
  const replayBoundaryTimeout = seams.replayBoundaryTimeout ?? PEER_LOOP_REPLAY_BOUNDARY_TIMEOUT;
  const config = yield* ServerConfig.ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serviceScope = yield* Effect.scope;

  const live = yield* Ref.make<LiveConnection | null>(null);
  const health = yield* Ref.make<PeerLoopHealth | null>(null);
  /** Set by the layer finalizer. A stopped service never spawns again. */
  const stopped = yield* Ref.make(false);
  /**
   * The connection attempt in flight, if any.
   *
   * Single-flight by hand rather than with a lock, because the work being
   * guarded forks the reader fibers that make the connection usable, and it
   * must run on an ordinary fiber. Callers that arrive during an attempt wait
   * on its result instead of starting a second bridge — two bridges would be
   * two writers contending for the same project leases.
   */
  const connecting = yield* Ref.make<Deferred.Deferred<
    PeerLoopBridgeConnection,
    PeerLoopError
  > | null>(null);

  const now = Effect.map(Clock.currentTimeMillis, (millis) =>
    DateTime.formatIso(DateTime.makeUnsafe(millis)),
  );

  const transport = yield* now.pipe(
    Effect.flatMap((changedAt) =>
      SubscriptionRef.make<PeerLoopTransportStatus>({
        state: "unavailable",
        changedAt,
        detail: null,
        protocolVersion: null,
      }),
    ),
  );

  const setTransport = Effect.fn("peerLoop.setTransport")(function* (
    state: PeerLoopTransportStatus["state"],
    detail: string | null,
    protocolVersion: number | null,
  ) {
    const changedAt = yield* now;
    yield* SubscriptionRef.set(transport, { state, changedAt, detail, protocolVersion });
  });

  /**
   * Tear a connection down and say so.
   *
   * Deliberately does not reconnect. Peer Loop's durable state is untouched by
   * its bridge exiting, and reattaching would be T3Code deciding that a run
   * should keep going — which is Peer Loop's call and the owner's, not ours.
   */
  const releaseConnection = Effect.fn("peerLoop.releaseConnection")(function* (
    entry: LiveConnection,
    state: "interrupted" | "stopped",
    detail: string | null,
  ) {
    const current = yield* Ref.get(live);
    if (current !== entry) return;
    yield* Ref.set(live, null);
    yield* Ref.set(health, null);
    yield* setTransport(state, detail, null);
    yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
  });

  /**
   * The machine-local executable, resolved once for the life of the service.
   *
   * Re-reading `local.json` on every RPC would let the answer change mid-run —
   * a status call and the start it precedes could name different programs — and
   * would put a file read on every call for a value that is true of one machine
   * and does not change while it is up. Dependencies are captured here too, so
   * nothing the service hands back carries a requirement on its callers.
   */
  const resolution = yield* resolvePeerLoopCommand(config.localConfigPath).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );

  /** Spawns a bridge and adopts it. Only ever called through `ensureConnection`. */
  const openConnection = Effect.gen(function* () {
    // After shutdown there is no scope left to own a child, so a late call
    // must refuse rather than leave an orphan bridge holding project leases.
    if (yield* Ref.get(stopped)) {
      return yield* new PeerLoopUnavailableError({
        reason: "this server is shutting down",
      });
    }

    if (resolution.kind === "invalid") {
      yield* setTransport("unavailable", resolution.reason, null);
      return yield* new PeerLoopUnavailableError({ reason: resolution.reason });
    }

    yield* setTransport("starting", null, null);

    const scope = yield* Scope.make();
    // The machine-local stop bound, when the operator set one. A test seam
    // still wins, so a bounded wait can be measured in milliseconds.
    const stopTimeout =
      connectOptions.stopTimeout ??
      (resolution.stopTimeoutSeconds === null
        ? undefined
        : Duration.seconds(resolution.stopTimeoutSeconds));

    const connection = yield* connect(resolution.command, {
      ...connectOptions,
      ...(stopTimeout === undefined ? {} : { stopTimeout }),
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Scope.provide(scope),
      Effect.tapError(() => Scope.close(scope, Exit.void).pipe(Effect.ignore)),
      Effect.tapError((error) => setTransport("unavailable", error.message, null)),
    );

    const entry: LiveConnection = { connection, scope };
    yield* Ref.set(live, entry);
    yield* Ref.set(health, connection.health);
    yield* setTransport("connected", null, connection.health.protocolVersion);

    // One watcher per connection, on the service scope so it cannot outlive
    // the layer. It publishes the interruption; it does not act on it.
    yield* connection.closed.pipe(
      Effect.flatMap((reason) =>
        Effect.logWarning("Peer Loop bridge transport ended.").pipe(
          Effect.annotateLogs({ detail: reason.message }),
          Effect.andThen(releaseConnection(entry, "interrupted", reason.message)),
        ),
      ),
      Effect.forkIn(serviceScope),
    );

    return connection;
  });

  /**
   * The live connection, opening one if there is not one already.
   *
   * The claim is a single `Ref.modify` — one atomic read-modify-write — so of
   * any number of concurrent cold callers exactly one becomes the opener and
   * the rest await its result, success or typed failure alike. Two bridges
   * would be two writers contending for the same project leases, which is the
   * one outcome Peer Loop's ownership model cannot express.
   *
   * The opener re-checks `live` after winning the claim, because a connection
   * may have completed between another caller's read and its claim.
   */
  const ensureConnection: Effect.Effect<PeerLoopBridgeConnection, PeerLoopError> = Effect.gen(
    function* () {
      const existing = yield* Ref.get(live);
      if (existing !== null) return existing.connection;

      const candidate = yield* Deferred.make<PeerLoopBridgeConnection, PeerLoopError>();
      const claim = yield* Ref.modify(
        connecting,
        (
          current,
        ): readonly [ConnectionClaim, Deferred.Deferred<PeerLoopBridgeConnection, PeerLoopError>] =>
          current === null
            ? [{ opener: true, deferred: candidate }, candidate]
            : [{ opener: false, deferred: current }, current],
      );

      if (!claim.opener) return yield* Deferred.await(claim.deferred);

      const settled = yield* Ref.get(live);
      const outcome =
        settled === null
          ? yield* Effect.exit(openConnection)
          : Exit.succeed<PeerLoopBridgeConnection>(settled.connection);

      yield* Ref.set(connecting, null);
      yield* Deferred.done(claim.deferred, outcome);
      return yield* Deferred.await(claim.deferred);
    },
  );

  /* ------------------------------------------------------ replay slots */

  const replaySlots = new Map<string, RunReplaySlot>();

  const acquireReplaySlot = Effect.fn("peerLoop.acquireReplaySlot")(function* (runId: string) {
    const existing = replaySlots.get(runId);
    if (existing !== undefined) {
      existing.users += 1;
      return existing;
    }
    const slot: RunReplaySlot = { gate: yield* Semaphore.make(1), users: 1 };
    replaySlots.set(runId, slot);
    return slot;
  });

  const releaseReplaySlot = (runId: string) =>
    Effect.sync(() => {
      const slot = replaySlots.get(runId);
      if (slot === undefined) return;
      slot.users -= 1;
      if (slot.users <= 0) replaySlots.delete(runId);
    });

  /**
   * Attach to a run without cutting anyone else's replay short.
   *
   * The slot is held for the attach AND for the replay it starts, because Peer
   * Loop keeps one attachment per run: a second attach mid-replay supersedes
   * the first and leaves whoever asked for it with a stream that simply stops.
   * The boundary is the `eventHighWaterMark` the attach itself reported —
   * authoritative, unlike counting events, because Peer Loop's sequences are
   * strictly increasing but not contiguous and the count is not knowable.
   */
  const attachSerialized = Effect.fn("peerLoop.attach")(function* (
    connection: PeerLoopBridgeConnection,
    runId: string,
    afterSeq: number,
  ) {
    const slot = yield* acquireReplaySlot(runId);
    return yield* slot.gate
      .withPermits(1)(
        Effect.gen(function* () {
          const watcher = yield* connection.subscribe;
          const raw = yield* connection.request("run.attach", { runId, afterSeq });
          const result = yield* decodeAttach(raw).pipe(
            Effect.mapError(
              () =>
                new PeerLoopProtocolError({
                  detail: "the bridge returned a run.attach result this build cannot read",
                }),
            ),
          );

          if (result.eventHighWaterMark > afterSeq) {
            // Wait for the replay to reach its own boundary before letting the
            // next attach for this run supersede it. Bounded, because a run
            // that never emits again must not hold the slot forever.
            yield* Stream.fromQueue(watcher.queue).pipe(
              Stream.takeWhile((item) => item.kind === "notification"),
              Stream.filter((item) => {
                const message = (item as { readonly message: PeerLoopBridgeNotification }).message;
                return (
                  message.method === "run.event" &&
                  message.params.runId === runId &&
                  message.params.event.seq >= result.eventHighWaterMark
                );
              }),
              Stream.take(1),
              Stream.runDrain,
              Effect.timeoutOption(replayBoundaryTimeout),
            );
          }

          return result;
        }).pipe(Effect.scoped),
      )
      .pipe(Effect.ensuring(releaseReplaySlot(runId)));
  });

  /** One bridge call, with its result validated against the contract. */
  const call = <A>(
    method: PeerLoopBridgeMethod,
    params: Readonly<Record<string, unknown>>,
    decode: (value: unknown) => Effect.Effect<A, Schema.SchemaError>,
  ): Effect.Effect<A, PeerLoopError> =>
    Effect.gen(function* () {
      const connection = yield* ensureConnection;
      const raw = yield* connection.request(method, params);
      return yield* decode(raw).pipe(
        Effect.mapError(
          () =>
            new PeerLoopProtocolError({
              detail: `the bridge returned a ${method} result this build cannot read`,
            }),
        ),
      );
    });

  const status = Effect.fn("peerLoop.status")(function* (_input: PeerLoopStatusInput) {
    const configured = resolution.kind === "resolved";
    const source = resolution.kind === "resolved" ? resolution.command.source : resolution.source;

    // Status is the one method that starts the bridge as a probe: an operator
    // asking "is Peer Loop working here?" wants it tried, not assumed.
    yield* ensureConnection.pipe(Effect.ignore);

    // A configured-but-unusable value still reports its source, so the answer
    // names the setting the operator has to fix. The path itself never leaves.
    return {
      configured,
      executableSource: source,
      transport: yield* SubscriptionRef.get(transport),
      health: yield* Ref.get(health),
    } satisfies PeerLoopStatusResult;
  });

  const listRuns = Effect.fn("peerLoop.listRuns")(function* (input: PeerLoopListRunsInput) {
    const result = yield* call(
      "runs.list",
      input.projectPath === undefined ? {} : { projectPath: input.projectPath },
      decodeRunsList,
    );
    return { runs: result.runs, unreadable: result.unreadable } satisfies PeerLoopListRunsResult;
  });

  const attachRun = Effect.fn("peerLoop.attachRun")(function* (input: PeerLoopAttachRunInput) {
    const connection = yield* ensureConnection;
    return yield* attachSerialized(connection, input.runId, input.afterSeq ?? 0);
  });

  const startRun = (input: PeerLoopStartRunInput) =>
    call(
      "run.start",
      {
        projectPath: input.projectPath,
        ...(input.objective === undefined ? {} : { objective: input.objective }),
        ...(input.newRun === undefined ? {} : { newRun: input.newRun }),
        ...(input.safetyLimit === undefined ? {} : { safetyLimit: input.safetyLimit }),
      },
      decodeStart,
    );

  const resumeRun = (input: PeerLoopRunIdInput) =>
    call("run.resume", { runId: input.runId }, decodeResume);

  const sendOwnerMessage = (input: PeerLoopSendOwnerMessageInput) =>
    call("run.ownerMessage", { runId: input.runId, text: input.text }, decodeOwnerMessage);

  const pauseRun = (input: PeerLoopRunIdInput) =>
    call("run.pause", { runId: input.runId }, decodePause);

  const recoverRun = (input: PeerLoopRecoverRunInput) =>
    call("run.recover", { runId: input.runId, choice: input.choice }, decodeRecover);

  /**
   * One client's view of one run.
   *
   * Every subscriber has its own feed and its own cursor and forwards only what
   * that cursor has not seen, which is what makes a second client harmless: its
   * attach makes Peer Loop replay from *its* `afterSeq`, and those events are
   * simply older than everyone else's cursor.
   *
   * NO GAP IS INFERRED FROM A SEQUENCE SKIP. Peer Loop's sequences are strictly
   * increasing but not contiguous — an event can take a number and then fail to
   * be recorded — so a skip is not evidence of loss. Loss is only ever reported
   * when this server actually refused a notification for this subscriber, or
   * when Peer Loop itself says so. Both end the subscription at the last cursor
   * the client can trust, so it re-attaches from a known-safe point instead of
   * quietly carrying on across a hole.
   */
  const subscribeEvents = (
    input: PeerLoopSubscribeEventsInput,
  ): Stream.Stream<PeerLoopSubscriptionEvent, PeerLoopError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const connection = yield* ensureConnection;
        // Subscribed BEFORE the attach, so the replay it triggers cannot start
        // before this subscriber is listening.
        const feed = yield* connection.subscribe;
        const opening = yield* SubscriptionRef.get(transport);

        yield* attachSerialized(connection, input.runId, input.afterSeq ?? 0);

        const startCursor = input.afterSeq ?? 0;
        let cursor = startCursor;
        /** Set when this stream must stop advancing: it is no longer complete. */
        let frozen = false;

        const projected = Stream.fromQueue(feed.queue).pipe(
          // The feed says when the transport ended; a queue that merely stops
          // producing would leave this parked on a dead connection.
          Stream.takeWhile((item) => item.kind === "notification"),
          Stream.map((item): readonly PeerLoopSubscriptionEvent[] => {
            const message = (item as { readonly message: PeerLoopBridgeNotification }).message;
            if (frozen) return [];
            switch (message.method) {
              case "run.event": {
                if (message.params.runId !== input.runId) return [];
                const seq = message.params.event.seq;
                if (seq <= cursor) return [];
                cursor = seq;
                return [
                  {
                    kind: "run-event",
                    runId: input.runId,
                    event: message.params.event,
                    replay: message.params.replay,
                  },
                ];
              }
              case "run.outcome":
                return message.params.runId === input.runId
                  ? [
                      {
                        kind: "run-outcome",
                        runId: input.runId,
                        outcome: message.params.outcome,
                        state: message.params.state,
                      },
                    ]
                  : [];
              case "run.finished":
                return message.params.runId === input.runId
                  ? [
                      {
                        kind: "run-finished",
                        runId: input.runId,
                        outcome: message.params.outcome,
                        state: message.params.state,
                        reason: message.params.reason,
                      },
                    ]
                  : [];
              case "run.resync": {
                if (message.params.runId !== input.runId) return [];
                // Peer Loop says its own stream is incomplete. Freeze here: the
                // safe cursor is whichever of the two is lower, and advancing
                // past it would carry the client over a known missing range.
                frozen = true;
                const safe = Math.min(cursor, message.params.afterSeq);
                cursor = safe;
                return [
                  {
                    kind: "run-resync",
                    runId: input.runId,
                    afterSeq: safe,
                    reason: message.params.reason,
                  },
                ];
              }
              case "bridge.ready":
                return [];
            }
          }),
          Stream.flattenIterable,
          // A resync is the last thing this subscription says. Continuing would
          // mean advancing across a range nobody can vouch for.
          Stream.takeUntil((event) => event.kind === "run-resync"),
        );

        /**
         * How the stream ends, decided when it ends rather than in advance.
         *
         * Three ways out, and they are not interchangeable: this subscriber's
         * feed overflowed, Peer Loop already told us to resync, or the bridge
         * went away. The last one must not report the stale `connected` status
         * a naive read of the transport ref would still be showing, so the
         * state comes from what actually happened to the connection.
         */
        const closing = Effect.gen(function* () {
          if (frozen) return [] as readonly PeerLoopSubscriptionEvent[];

          if (yield* feed.overflowed) {
            return [
              {
                kind: "run-resync",
                runId: input.runId,
                afterSeq: cursor,
                reason:
                  "this server could not retain the event stream for this client; re-subscribe from afterSeq",
              },
            ] satisfies readonly PeerLoopSubscriptionEvent[];
          }

          const stoppedByUs = yield* Ref.get(stopped);
          const latest = yield* SubscriptionRef.get(transport);
          const state = stoppedByUs ? "stopped" : "interrupted";
          return [
            {
              kind: "transport",
              transport:
                latest.state === "connected" || latest.state === "starting"
                  ? { ...latest, state, protocolVersion: null }
                  : latest,
            },
          ] satisfies readonly PeerLoopSubscriptionEvent[];
        });

        const openingEvent: PeerLoopSubscriptionEvent = { kind: "transport", transport: opening };
        return Stream.concat(
          Stream.succeed(openingEvent),
          Stream.concat(projected, Stream.flattenIterable(Stream.fromEffect(closing))),
        );
      }),
    );

  const diagnostics = Effect.gen(function* () {
    const entry = yield* Ref.get(live);
    return entry === null ? [] : yield* entry.connection.stderrTail;
  });

  // A normal server shutdown closes stdin and lets Peer Loop reach its own safe
  // boundary. It is not killed here; the bridge's own finalizer holds the only
  // handle that could, and only after waiting.
  yield* Effect.addFinalizer(() =>
    Ref.set(stopped, true).pipe(
      Effect.andThen(Ref.get(live)),
      Effect.flatMap((entry) =>
        entry === null ? Effect.void : releaseConnection(entry, "stopped", null),
      ),
      Effect.ignore,
    ),
  );

  return PeerLoopService.of({
    status,
    listRuns,
    attachRun,
    startRun,
    resumeRun,
    sendOwnerMessage,
    pauseRun,
    recoverRun,
    subscribeEvents,
    diagnostics,
    replaySlotCount: Effect.sync(() => replaySlots.size),
  });
});

export const layer = Layer.effect(PeerLoopService, make());

/** Exported so tests can assert the version this build refuses to deviate from. */
export const EXPECTED_PROTOCOL_VERSION = PEER_LOOP_PROTOCOL_VERSION;
