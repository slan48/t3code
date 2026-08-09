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
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
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
  }
>()("t3/peerLoop/Service/PeerLoopService") {}

interface LiveConnection {
  readonly connection: PeerLoopBridgeConnection;
  readonly scope: Scope.Closeable;
}

const decodeRunsList = Schema.decodeUnknownEffect(PeerLoopRunsListResult);
const decodeAttach = Schema.decodeUnknownEffect(PeerLoopAttachResult);
const decodeStart = Schema.decodeUnknownEffect(PeerLoopStartResult);
const decodeResume = Schema.decodeUnknownEffect(PeerLoopResumeResult);
const decodeOwnerMessage = Schema.decodeUnknownEffect(PeerLoopOwnerMessageResult);
const decodePause = Schema.decodeUnknownEffect(PeerLoopPauseResult);
const decodeRecover = Schema.decodeUnknownEffect(PeerLoopRecoverResult);

/* ---------------------------------------------------------------- service */

export const make = Effect.fn("peerLoop.Service.make")(function* () {
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

  // Dependencies are captured once here, so nothing the service hands back
  // carries a requirement its callers would have to satisfy.
  const resolution = resolvePeerLoopCommand(config.localConfigPath).pipe(
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

    const resolved = yield* resolution;
    if (resolved.kind === "invalid") {
      yield* setTransport("unavailable", resolved.reason, null);
      return yield* new PeerLoopUnavailableError({ reason: resolved.reason });
    }

    yield* setTransport("starting", null, null);

    const scope = yield* Scope.make();
    const connection = yield* connect(resolved.command).pipe(
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

  const ensureConnection: Effect.Effect<PeerLoopBridgeConnection, PeerLoopError> = Effect.gen(
    function* () {
      const existing = yield* Ref.get(live);
      if (existing !== null) return existing.connection;

      const inFlight = yield* Ref.get(connecting);
      if (inFlight !== null) return yield* Deferred.await(inFlight);

      // No await between the read above and this write, so two callers cannot
      // both decide they are the one opening the connection.
      const deferred = yield* Deferred.make<PeerLoopBridgeConnection, PeerLoopError>();
      yield* Ref.set(connecting, deferred);

      const outcome = yield* Effect.exit(openConnection);
      yield* Ref.set(connecting, null);
      yield* Deferred.done(deferred, outcome);
      return yield* Deferred.await(deferred);
    },
  );

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
    const resolved = yield* resolution;
    const configured = resolved.kind === "resolved";
    const source = resolved.kind === "resolved" ? resolved.command.source : resolved.source;

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

  const attachRun = (input: PeerLoopAttachRunInput) =>
    call("run.attach", { runId: input.runId, afterSeq: input.afterSeq ?? 0 }, decodeAttach);

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
   * Every subscriber gets its own cursor and filters the shared notification
   * stream with it. That is what makes a second client attaching harmless: its
   * `run.attach` makes Peer Loop replay from *its* `afterSeq`, and the replay
   * is simply older than everyone else's cursor, so nobody else sees it twice.
   *
   * A `seq` that skips means this server could not keep up (its notification
   * buffer slid) — Peer Loop's own sequences are contiguous. That is reported
   * as `run-resync` and the client re-subscribes; it is never papered over,
   * because a silent gap in an activity feed is a lie about what happened.
   */
  const subscribeEvents = (
    input: PeerLoopSubscribeEventsInput,
  ): Stream.Stream<PeerLoopSubscriptionEvent, PeerLoopError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const connection = yield* ensureConnection;
        // Subscribed BEFORE the attach, so the replay it triggers cannot start
        // before this subscriber is listening.
        const notifications = yield* connection.subscribe;
        const opening = yield* SubscriptionRef.get(transport);

        yield* connection.request("run.attach", {
          runId: input.runId,
          afterSeq: input.afterSeq ?? 0,
        });

        let cursor = input.afterSeq ?? 0;

        const projected = Stream.fromQueue(notifications).pipe(
          Stream.map((message): readonly PeerLoopSubscriptionEvent[] => {
            switch (message.method) {
              case "run.event": {
                if (message.params.runId !== input.runId) return [];
                const seq = message.params.event.seq;
                if (seq <= cursor) return [];
                const gapped = cursor > 0 && seq > cursor + 1;
                const resumeFrom = cursor;
                cursor = seq;
                const event: PeerLoopSubscriptionEvent = {
                  kind: "run-event",
                  runId: input.runId,
                  event: message.params.event,
                  replay: message.params.replay,
                };
                return gapped
                  ? [
                      {
                        kind: "run-resync",
                        runId: input.runId,
                        afterSeq: resumeFrom,
                        reason:
                          "this server could not keep up with the event stream; re-subscribe from afterSeq",
                      },
                      event,
                    ]
                  : [event];
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
              case "run.resync":
                return message.params.runId === input.runId
                  ? [
                      {
                        kind: "run-resync",
                        runId: input.runId,
                        afterSeq: message.params.afterSeq,
                        reason: message.params.reason,
                      },
                    ]
                  : [];
              case "bridge.ready":
                return [];
            }
          }),
          Stream.flattenIterable,
        );

        // The notification source ends when the bridge does, so the closing
        // transport event is the client's explicit "and then it stopped".
        const openingEvent: PeerLoopSubscriptionEvent = { kind: "transport", transport: opening };
        return Stream.concat(
          Stream.succeed(openingEvent),
          Stream.concat(
            projected,
            Stream.fromEffect(
              SubscriptionRef.get(transport).pipe(
                Effect.map(
                  (latest): PeerLoopSubscriptionEvent => ({ kind: "transport", transport: latest }),
                ),
              ),
            ),
          ),
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
  });
});

export const layer = Layer.effect(PeerLoopService, make());

/** Exported so tests can assert the version this build refuses to deviate from. */
export const EXPECTED_PROTOCOL_VERSION = PEER_LOOP_PROTOCOL_VERSION;
