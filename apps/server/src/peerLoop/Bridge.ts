/**
 * The stdio transport for one Peer Loop bridge subprocess.
 *
 * One long-lived child, owned by a `Scope`. stdout is protocol and nothing
 * else: every line is decoded with the contracts schema before anything looks
 * at it, responses are correlated by id, and notifications are fanned out.
 * stderr is Peer Loop's own diagnostics — kept only as a small bounded tail so
 * a support question has something to answer with, never streamed to a client
 * and never allowed to grow.
 *
 * What this module deliberately does NOT do:
 *
 *   - guess. A line that is not protocol fails the connection closed rather
 *     than being skipped, because a bridge writing prose on stdout is a bridge
 *     whose responses cannot be trusted either;
 *   - find processes. The only child it can touch is the one it spawned, held
 *     as a handle. Nothing here searches by name, path or pattern;
 *   - resume anything. A child that exits fails the pending requests and ends
 *     the notification stream. Restarting is a decision for the layer above,
 *     and resuming a *run* is an explicit owner command to Peer Loop.
 *
 * @module PeerLoopBridge
 */
import {
  PEER_LOOP_PROTOCOL_VERSION,
  PeerLoopBridgeOutbound,
  PeerLoopBridgeRequest,
  PeerLoopCommandRefusedError,
  PeerLoopIncompatibleError,
  PeerLoopProtocolError,
  PeerLoopTimeoutError,
  PeerLoopTransportError,
  type PeerLoopBridgeMethod,
  type PeerLoopBridgeNotification,
  type PeerLoopError,
  type PeerLoopHealth,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type { PeerLoopCommand } from "./Command.ts";

/** How long a single bridge request may take before it is abandoned. */
export const PEER_LOOP_REQUEST_TIMEOUT = Duration.seconds(30);

/** How long the `bridge.ready` handshake may take before the spawn is a failure. */
export const PEER_LOOP_HANDSHAKE_TIMEOUT = Duration.seconds(15);

/**
 * How long a bridge is given to stop itself after stdin closes.
 *
 * Generous, because it may be finishing an agent turn and releasing leases.
 * Finite, because a server shutdown cannot wait forever on a child.
 */
export const PEER_LOOP_STOP_TIMEOUT = Duration.seconds(10);

/** stderr lines retained for diagnostics. Bounded: this is a tail, not a log. */
export const PEER_LOOP_STDERR_TAIL_LINES = 40;

/** Longest stderr line kept. A runaway line is truncated, never buffered whole. */
export const PEER_LOOP_STDERR_LINE_CHARS = 500;

/**
 * How many notifications one subscriber may fall behind by.
 *
 * Sliding rather than unbounded, so a slow client costs bounded memory here
 * instead of growing the server. Dropping the oldest leaves a `seq` gap, which
 * the subscriber detects and answers with a re-attach — the same mechanism Peer
 * Loop already uses for the same problem, rather than a silent hole in a feed.
 */
export const PEER_LOOP_NOTIFICATION_BUFFER = 1024;

/** One stdout line straight into a validated protocol message. */
const decodeOutboundLine = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PeerLoopBridgeOutbound),
);

/** One request straight out to a protocol line. Never hand-built with string concatenation. */
const encodeRequestLine = Schema.encodeSync(Schema.fromJsonString(PeerLoopBridgeRequest));

const encoder = new TextEncoder();
const EMPTY_CHUNK = new Uint8Array(0);

export interface PeerLoopBridgeConnection {
  readonly pid: number;
  /** The handshake Peer Loop announced. Protocol version already verified. */
  readonly health: PeerLoopHealth;
  readonly request: (
    method: PeerLoopBridgeMethod,
    params: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<unknown, PeerLoopError>;
  /**
   * A private, bounded feed of every validated notification from here on.
   *
   * Scoped: leaving the scope removes the subscriber. Each one has its own
   * queue so one slow client cannot stall the reader or another client.
   */
  readonly subscribe: Effect.Effect<
    Queue.Dequeue<PeerLoopBridgeNotification, Cause.Done>,
    never,
    Scope.Scope
  >;
  /** Resolves with the reason the transport ended. Never resolves while healthy. */
  readonly closed: Effect.Effect<PeerLoopTransportError | PeerLoopProtocolError>;
  /** Bounded stderr tail, newest last. Diagnostics only. */
  readonly stderrTail: Effect.Effect<readonly string[]>;
}

interface PendingRequest {
  readonly method: string;
  readonly deferred: Deferred.Deferred<unknown, PeerLoopError>;
}

/** Hoisted: `Schema.is` compiles a checker, and this runs on every read error. */
const isProtocolError = Schema.is(PeerLoopProtocolError);

const truncateLine = (line: string): string =>
  line.length <= PEER_LOOP_STDERR_LINE_CHARS
    ? line
    : `${line.slice(0, PEER_LOOP_STDERR_LINE_CHARS - 1)}…`;

/**
 * Spawn a bridge and complete its handshake.
 *
 * Scoped: closing the scope closes stdin first, which is how Peer Loop is asked
 * to stop. It finishes any turn already in flight and releases its own
 * ownership leases on the way out — that is its business, not ours, and cutting
 * it short would trade a clean run state for an ambiguous one.
 */
export const connect = Effect.fn("peerLoop.bridge.connect")(function* (
  command: PeerLoopCommand,
  options: {
    readonly requestTimeout?: Duration.Duration;
    readonly handshakeTimeout?: Duration.Duration;
    readonly stopTimeout?: Duration.Duration;
  } = {},
): Effect.fn.Return<
  PeerLoopBridgeConnection,
  PeerLoopTransportError | PeerLoopProtocolError | PeerLoopIncompatibleError,
  Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const requestTimeout = options.requestTimeout ?? PEER_LOOP_REQUEST_TIMEOUT;
  const handshakeTimeout = options.handshakeTimeout ?? PEER_LOOP_HANDSHAKE_TIMEOUT;
  const stopTimeout = options.stopTimeout ?? PEER_LOOP_STOP_TIMEOUT;

  // No shell. The command and its arguments are separate values and stay that
  // way all the way to `spawn`.
  const handle = yield* spawner
    .spawn(ChildProcess.make(command.command, [...command.args], { extendEnv: true }))
    .pipe(
      Effect.mapError(
        (cause) =>
          new PeerLoopTransportError({
            detail: `could not start the Peer Loop bridge: ${Cause.pretty(Cause.fail(cause))}`,
            exitCode: null,
          }),
      ),
    );

  const pending = new Map<string, PendingRequest>();
  const subscribers = new Set<Queue.Queue<PeerLoopBridgeNotification, Cause.Done>>();
  const ready = yield* Deferred.make<PeerLoopHealth, PeerLoopIncompatibleError>();
  const closed = yield* Deferred.make<PeerLoopTransportError | PeerLoopProtocolError>();
  const stderrLines: string[] = [];
  let nextRequestId = 0;

  /**
   * The child's exit status, observed once and shared.
   *
   * Both the reader and the finalizer want to know it, and awaiting the handle
   * twice is not something to rely on. Null means the status itself could not
   * be read, which is not the same as "still running".
   */
  const exited = yield* Deferred.make<number | null>();
  yield* handle.exitCode.pipe(
    Effect.matchEffect({
      onFailure: () => Deferred.succeed(exited, null),
      onSuccess: (code) => Deferred.succeed(exited, Number(code)),
    }),
    Effect.forkScoped,
  );

  const stderrTail = Effect.sync(() => [...stderrLines]);

  /** End the transport once, failing everything still waiting on it. */
  const shutdown = Effect.fn("peerLoop.bridge.shutdown")(function* (
    reason: PeerLoopTransportError | PeerLoopProtocolError,
  ) {
    const settled = yield* Deferred.isDone(closed);
    if (settled) return;
    yield* Deferred.succeed(closed, reason);
    yield* Deferred.fail(
      ready,
      new PeerLoopIncompatibleError({
        expected: PEER_LOOP_PROTOCOL_VERSION,
        reported: null,
        detail: reason.message,
      }),
    );
    const waiting = [...pending.values()];
    pending.clear();
    yield* Effect.forEach(waiting, (entry) => Deferred.fail(entry.deferred, reason), {
      discard: true,
    });
    // Ended, not shut down: a subscriber sees the feed finish cleanly and can
    // emit its own closing state rather than dying of an interrupted queue.
    const feeds = [...subscribers];
    subscribers.clear();
    yield* Effect.forEach(feeds, (feed) => Queue.end(feed), { discard: true });
  });

  const subscribe = Effect.gen(function* () {
    const feed = yield* Queue.sliding<PeerLoopBridgeNotification, Cause.Done>(
      PEER_LOOP_NOTIFICATION_BUFFER,
    );
    const alreadyClosed = yield* Deferred.isDone(closed);
    if (alreadyClosed) {
      yield* Queue.end(feed);
      return feed as Queue.Dequeue<PeerLoopBridgeNotification, Cause.Done>;
    }
    subscribers.add(feed);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        subscribers.delete(feed);
      }).pipe(Effect.andThen(Queue.end(feed)), Effect.ignore),
    );
    return feed as Queue.Dequeue<PeerLoopBridgeNotification, Cause.Done>;
  });

  const handleMessage = Effect.fn("peerLoop.bridge.handleMessage")(function* (line: string) {
    const message = yield* decodeOutboundLine(line).pipe(
      Effect.mapError(
        () =>
          new PeerLoopProtocolError({
            detail: `unrecognised protocol line (${truncateLine(line)})`,
          }),
      ),
    );

    if (message.type === "notification") {
      if (message.method === "bridge.ready") {
        const health = message.params;
        if (health.protocolVersion !== PEER_LOOP_PROTOCOL_VERSION) {
          // Fail closed. A bridge speaking a version we do not implement may
          // have changed the meaning of a command we would otherwise send.
          yield* Deferred.fail(
            ready,
            new PeerLoopIncompatibleError({
              expected: PEER_LOOP_PROTOCOL_VERSION,
              reported: health.protocolVersion,
              detail: "the bridge announced an unsupported protocol version",
            }),
          );
          return;
        }
        yield* Deferred.succeed(ready, health);
        return;
      }
      // Sliding: a subscriber that has stopped reading loses its oldest
      // notifications and finds out from the `seq` gap. The reader never waits.
      for (const feed of subscribers) Queue.offerUnsafe(feed, message);
      return;
    }

    if (message.id === null) {
      // A refusal too malformed to carry an id — a line we sent that the bridge
      // could not parse at all. Nothing to correlate, so record and continue.
      yield* Effect.logWarning("Peer Loop bridge rejected a request it could not correlate.").pipe(
        Effect.annotateLogs({
          code: message.ok === false ? message.error.code : "unknown",
        }),
      );
      return;
    }

    const entry = pending.get(message.id);
    if (entry === undefined) return;
    pending.delete(message.id);

    if (message.ok) {
      yield* Deferred.succeed(entry.deferred, message.result);
      return;
    }
    yield* Deferred.fail(
      entry.deferred,
      refusalToError(message.error.code, message.error.message, message.error.detail ?? null),
    );
  });

  // stdin is a Sink, so writes go through a queue drained into it by one fiber.
  // Bounded, because a peer that stops reading must cost bounded memory rather
  // than however many requests a client can make.
  const stdinQueue = yield* Queue.bounded<Uint8Array, Cause.Done>(64);
  yield* Stream.fromQueue(stdinQueue).pipe(
    Stream.run(handle.stdin),
    Effect.catch((cause) =>
      shutdown(
        new PeerLoopTransportError({
          detail: `writing to the Peer Loop bridge failed: ${String(cause)}`,
          exitCode: null,
        }),
      ),
    ),
    Effect.forkScoped,
  );

  yield* handle.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) => (line.trim().length === 0 ? Effect.void : handleMessage(line))),
    Effect.matchEffect({
      onFailure: (cause) =>
        shutdown(
          isProtocolError(cause)
            ? cause
            : new PeerLoopTransportError({ detail: String(cause), exitCode: null }),
        ),
      // stdout ending is the child going away. Whatever the exit code says, the
      // transport is over and every waiting request has to be told.
      onSuccess: () =>
        Deferred.await(exited).pipe(
          Effect.flatMap((code) =>
            shutdown(
              new PeerLoopTransportError({
                detail:
                  code === null
                    ? "the Peer Loop bridge stopped and its exit status could not be read"
                    : `the Peer Loop bridge exited with code ${code}`,
                exitCode: code,
              }),
            ),
          ),
        ),
    }),
    Effect.forkScoped,
  );

  yield* handle.stderr.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) =>
      Effect.sync(() => {
        if (line.trim().length === 0) return;
        stderrLines.push(truncateLine(line));
        if (stderrLines.length > PEER_LOOP_STDERR_TAIL_LINES) stderrLines.shift();
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );

  const request = Effect.fn("peerLoop.bridge.request")(function* (
    method: PeerLoopBridgeMethod,
    params: Readonly<Record<string, unknown>>,
  ) {
    const alreadyClosed = yield* Deferred.isDone(closed);
    if (alreadyClosed) return yield* Deferred.await(closed).pipe(Effect.flatMap(Effect.fail));

    nextRequestId += 1;
    const id = `t3-${nextRequestId}`;
    const deferred = yield* Deferred.make<unknown, PeerLoopError>();
    pending.set(id, { method, deferred });

    const line = encodeRequestLine({
      v: PEER_LOOP_PROTOCOL_VERSION,
      type: "request",
      id,
      method,
      params,
    });
    yield* Queue.offer(stdinQueue, encoder.encode(`${line}\n`));

    const answered = yield* Deferred.await(deferred).pipe(Effect.timeoutOption(requestTimeout));
    if (Option.isNone(answered)) {
      // Abandoned, not cancelled: Peer Loop may still act on it. The pending
      // entry is dropped so a late response is ignored rather than resolving a
      // caller that has already been told this timed out.
      pending.delete(id);
      return yield* new PeerLoopTimeoutError({
        method,
        timeoutMs: Duration.toMillis(requestTimeout),
      });
    }
    return answered.value;
  });

  /**
   * Closing the scope closes stdin, which is how Peer Loop is asked to stop.
   *
   * It then finishes whatever turn is in flight and releases its own ownership
   * leases — that is its business and cutting it short would trade a clean run
   * state for an ambiguous one. Only after waiting, and only against the handle
   * this server spawned, is the child terminated.
   */
  yield* Effect.addFinalizer(() =>
    // An empty chunk before the end: it costs nothing on the wire and it wakes
    // the drain fiber, which is what actually closes the child's stdin.
    Queue.offer(stdinQueue, EMPTY_CHUNK).pipe(
      Effect.andThen(Queue.end(stdinQueue)),
      Effect.andThen(
        Deferred.await(exited).pipe(
          Effect.timeoutOption(stopTimeout),
          Effect.flatMap((settled) =>
            Option.isSome(settled)
              ? Effect.void
              : Effect.logWarning(
                  "Peer Loop bridge did not exit after stdin closed; terminating the child this server spawned.",
                ).pipe(Effect.andThen(handle.kill().pipe(Effect.ignore))),
          ),
        ),
      ),
      // Anything still waiting on this connection is released here rather than
      // parked forever: the reader fibers are about to be interrupted and will
      // not get the chance to say the transport ended.
      Effect.andThen(
        shutdown(
          new PeerLoopTransportError({
            detail: "the Peer Loop bridge was stopped by this server",
            exitCode: null,
          }),
        ),
      ),
      Effect.ignore,
    ),
  );

  const announced = yield* Deferred.await(ready).pipe(Effect.timeoutOption(handshakeTimeout));
  if (Option.isNone(announced)) {
    return yield* new PeerLoopTransportError({
      detail: "the Peer Loop bridge did not announce itself in time",
      exitCode: null,
    });
  }
  const health = announced.value;

  return {
    pid: Number(handle.pid),
    health,
    request,
    subscribe,
    closed: Deferred.await(closed),
    stderrTail,
  } satisfies PeerLoopBridgeConnection;
});

/**
 * Turn a bridge refusal into the typed T3 error for it.
 *
 * The code travels verbatim, because `CONTROL_UNAVAILABLE`,
 * `PROJECT_HAS_UNFINISHED_RUN`, `REVIEWER_THREAD_BUSY` and `INVALID_RUN_STATE`
 * are all things an operator has to be able to tell apart, and prose does not
 * let them. `UNSUPPORTED_PROTOCOL_VERSION` is the one refusal that is not about
 * the command at all — it means this build and that bridge do not agree on what
 * the words mean — so it becomes the incompatibility error instead.
 */
export function refusalToError(code: string, message: string, detail: unknown): PeerLoopError {
  if (code === "UNSUPPORTED_PROTOCOL_VERSION") {
    return new PeerLoopIncompatibleError({
      expected: PEER_LOOP_PROTOCOL_VERSION,
      reported: null,
      detail: message,
    });
  }
  return new PeerLoopCommandRefusedError({
    code,
    detail: message,
    data: detail === undefined ? null : detail,
  });
}
