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
  missingPeerLoopCapabilities,
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

/**
 * How long an ordinary bridge call may take.
 *
 * `health`, `runs.list`, `run.attach` and the control calls are answered from
 * state Peer Loop already holds, so seconds are generous.
 */
export const PEER_LOOP_REQUEST_TIMEOUT = Duration.seconds(30);

/**
 * How long `run.start` and `run.resume` may take.
 *
 * These are not fast calls and pretending otherwise produces a timeout that
 * means nothing: before Peer Loop answers it takes an exclusive project lease,
 * runs its duplicate-run preflight, and probes both agent CLIs for their
 * capabilities — which spawns `codex` and `claude` and waits for them. Two
 * minutes is a bound on a stuck machine, not an expectation.
 */
export const PEER_LOOP_LIFECYCLE_REQUEST_TIMEOUT = Duration.minutes(2);

/** The methods that change something, and may have done so despite a timeout. */
const MUTATING_METHODS: ReadonlySet<PeerLoopBridgeMethod> = new Set([
  "run.start",
  "run.resume",
  "run.ownerMessage",
  "run.pause",
  "run.recover",
]);

/** The methods that spawn and probe before they answer. */
const LIFECYCLE_METHODS: ReadonlySet<PeerLoopBridgeMethod> = new Set(["run.start", "run.resume"]);

/** How long the `bridge.ready` handshake may take before the spawn is a failure. */
export const PEER_LOOP_HANDSHAKE_TIMEOUT = Duration.seconds(15);

/**
 * How long a bridge is given to stop itself after stdin closes.
 *
 * TEN MINUTES, AND THE NUMBER MATTERS. Closing stdin asks Peer Loop to stop at
 * its next safe boundary — which is the end of the agent turn already running.
 * Peer Loop's own per-turn timeouts are optional and off by default, so a
 * Builder turn legitimately runs for many minutes. A ten-*second* bound would
 * therefore terminate a live turn as a matter of routine, turning an orderly
 * shutdown into exactly the ambiguous half-applied state the whole integration
 * is built to avoid.
 *
 * Finite all the same: a server cannot wait forever on a child. An operator
 * whose turns run longer can raise it machine-locally; see `localConfig.ts`.
 */
export const PEER_LOOP_STOP_TIMEOUT = Duration.minutes(10);

/** stderr lines retained for diagnostics. Bounded: this is a tail, not a log. */
export const PEER_LOOP_STDERR_TAIL_LINES = 40;

/** Longest stderr line kept. A runaway line is truncated, never buffered whole. */
export const PEER_LOOP_STDERR_LINE_CHARS = 500;

/**
 * How many notifications one subscriber may fall behind by.
 *
 * Bounded rather than sliding, and the difference is the whole point. A sliding
 * queue drops the oldest entry and says nothing, leaving the reader to *infer*
 * loss from a sequence gap — and Peer Loop's sequences are strictly increasing
 * but NOT contiguous, because an event can take a sequence number and then fail
 * to be recorded. Inferring loss from a skip would cry wolf on a legitimate gap
 * and stay silent on a real drop. A bounded queue refuses the offer instead, so
 * the loss is a fact the feed reports rather than a guess.
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
  readonly subscribe: Effect.Effect<PeerLoopNotificationFeed, never, Scope.Scope>;
  /** Resolves with the reason the transport ended. Never resolves while healthy. */
  readonly closed: Effect.Effect<PeerLoopTransportError | PeerLoopProtocolError>;
  /** Bounded local diagnostics tail, newest last. Never sent to a client. */
  readonly stderrTail: Effect.Effect<readonly string[]>;
  /**
   * How many requests are still awaiting an answer.
   *
   * An inspection seam for tests, so "nothing was stranded" is an assertion
   * rather than a hope. Not reachable from any RPC and not part of the product
   * API — nothing outside this module and its tests reads it.
   */
  readonly pendingRequestCount: Effect.Effect<number>;
}

/**
 * One subscriber's private view of the notification stream.
 *
 * `overflowed` is the explicit answer to "did this feed lose something?". It is
 * a fact recorded at the moment an offer was refused, never reconstructed later
 * from sequence numbers — see `PEER_LOOP_NOTIFICATION_BUFFER`.
 */
export interface PeerLoopNotificationFeed {
  readonly queue: Queue.Dequeue<PeerLoopFeedItem, Cause.Done>;
  readonly overflowed: Effect.Effect<boolean>;
}

/**
 * What a subscriber reads.
 *
 * `ended` is an item rather than a closed queue because ending a queue does not
 * wake a consumer already parked on it — a reader would sit on a dead transport
 * forever. Delivering the end as a value is what makes "the bridge went away"
 * something a stream can actually observe.
 */
export type PeerLoopFeedItem =
  | { readonly kind: "notification"; readonly message: PeerLoopBridgeNotification }
  | { readonly kind: "ended" };

interface PendingRequest {
  readonly method: PeerLoopBridgeMethod;
  readonly deferred: Deferred.Deferred<unknown, PeerLoopError>;
}

interface SubscriberFeed {
  readonly queue: Queue.Queue<PeerLoopFeedItem, Cause.Done>;
  overflowed: boolean;
}

/** Hoisted: `Schema.is` compiles a checker, and this runs on every read error. */
const isProtocolError = Schema.is(PeerLoopProtocolError);

/**
 * What a client is allowed to be told about a transport failure.
 *
 * Deliberately fixed strings. The underlying cause names the configured
 * executable path, and a malformed stdout line can contain anything Peer Loop
 * was carrying — an owner message, a repository path, a task. Both are useful
 * locally and neither may cross to a phone on the tailnet, so the detail here
 * is a category and the specifics stay in bounded local diagnostics.
 */
export const PEER_LOOP_PUBLIC_SPAWN_FAILURE =
  "the Peer Loop bridge could not be started; check the machine-local executable configuration on the server";
export const PEER_LOOP_PUBLIC_STDIN_FAILURE = "writing to the Peer Loop bridge failed";
export const PEER_LOOP_PUBLIC_READ_FAILURE = "reading from the Peer Loop bridge failed";
export const PEER_LOOP_PUBLIC_MALFORMED_LINE =
  "the Peer Loop bridge wrote a line that is not protocol";
export const PEER_LOOP_PUBLIC_METHOD_MISMATCH =
  "the Peer Loop bridge answered a request with a different method";

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
    /** Bound for `run.start`/`run.resume`, which probe before they answer. */
    readonly lifecycleRequestTimeout?: Duration.Duration;
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
  const lifecycleTimeout = options.lifecycleRequestTimeout ?? PEER_LOOP_LIFECYCLE_REQUEST_TIMEOUT;
  const handshakeTimeout = options.handshakeTimeout ?? PEER_LOOP_HANDSHAKE_TIMEOUT;
  const stopTimeout = options.stopTimeout ?? PEER_LOOP_STOP_TIMEOUT;

  // No shell. The command and its arguments are separate values and stay that
  // way all the way to `spawn`.
  const handle = yield* spawner
    .spawn(ChildProcess.make(command.command, [...command.args], { extendEnv: true }))
    .pipe(
      // The cause names the configured path. It is exactly what an operator on
      // this machine needs and exactly what a remote client must not receive,
      // so it is logged here and the error carries a category instead.
      Effect.tapError((cause) =>
        Effect.logWarning("Could not start the Peer Loop bridge.").pipe(
          Effect.annotateLogs({ cause: Cause.pretty(Cause.fail(cause)) }),
        ),
      ),
      Effect.mapError(
        () =>
          new PeerLoopTransportError({ detail: PEER_LOOP_PUBLIC_SPAWN_FAILURE, exitCode: null }),
      ),
    );

  const pending = new Map<string, PendingRequest>();
  const subscribers = new Set<SubscriberFeed>();
  /**
   * The handshake, or why there will not be one.
   *
   * Typed with all three failures on purpose: a child that died before saying
   * anything is a transport failure, junk on stdout is a protocol failure, and
   * only a bridge that actually announced something we cannot speak is an
   * incompatibility. Collapsing them would tell an operator to fix the wrong
   * thing.
   */
  const ready = yield* Deferred.make<
    PeerLoopHealth,
    PeerLoopIncompatibleError | PeerLoopTransportError | PeerLoopProtocolError
  >();
  const closed = yield* Deferred.make<PeerLoopTransportError | PeerLoopProtocolError>();
  const diagnosticLines: string[] = [];
  let nextRequestId = 0;

  /** Append to the bounded local tail. Never sent to a client. */
  const recordDiagnostic = (line: string): void => {
    if (line.trim().length === 0) return;
    diagnosticLines.push(truncateLine(line));
    if (diagnosticLines.length > PEER_LOOP_STDERR_TAIL_LINES) diagnosticLines.shift();
  };

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

  const stderrTail = Effect.sync(() => [...diagnosticLines]);

  /**
   * End the transport once, releasing everything still waiting on it.
   *
   * ORDER MATTERS AND IT IS NOT THE OBVIOUS ONE. Resolving `closed` wakes the
   * layer above, which tears this connection's scope down — and that interrupts
   * the very fiber running this function. So everything that must actually
   * happen happens first, and `closed` is resolved last, as the announcement
   * that it already has. Uninterruptible for the same reason: a half-finished
   * shutdown leaves subscribers parked on a queue nobody will ever write to.
   */
  const shutdown = Effect.fn("peerLoop.bridge.shutdown")(function* (
    reason: PeerLoopTransportError | PeerLoopProtocolError,
  ) {
    const settled = yield* Deferred.isDone(closed);
    if (settled) return;

    yield* Deferred.fail(ready, reason);

    const waiting = [...pending.values()];
    pending.clear();
    yield* Effect.forEach(waiting, (entry) => Deferred.fail(entry.deferred, reason), {
      discard: true,
    });

    const feeds = [...subscribers];
    subscribers.clear();
    for (const feed of feeds) {
      // The value first, so a consumer parked on an empty queue wakes; then the
      // end, so nothing can be offered afterwards. Ending alone would leave a
      // parked reader waiting on a transport that is already gone.
      Queue.offerUnsafe(feed.queue, { kind: "ended" });
      Queue.endUnsafe(feed.queue);
    }

    yield* Deferred.succeed(closed, reason);
  }, Effect.uninterruptible);

  const subscribe: Effect.Effect<PeerLoopNotificationFeed, never, Scope.Scope> = Effect.gen(
    function* () {
      const queue = yield* Queue.bounded<PeerLoopFeedItem, Cause.Done>(
        PEER_LOOP_NOTIFICATION_BUFFER,
      );
      const feed: SubscriberFeed = { queue, overflowed: false };
      const handle: PeerLoopNotificationFeed = {
        queue,
        overflowed: Effect.sync(() => feed.overflowed),
      };

      const alreadyClosed = yield* Deferred.isDone(closed);
      if (alreadyClosed) {
        yield* Queue.offer(queue, { kind: "ended" });
        yield* Queue.end(queue);
        return handle;
      }

      subscribers.add(feed);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          subscribers.delete(feed);
        }).pipe(Effect.andThen(Queue.end(queue)), Effect.ignore),
      );
      return handle;
    },
  );

  const handleMessage = Effect.fn("peerLoop.bridge.handleMessage")(function* (line: string) {
    const message = yield* decodeOutboundLine(line).pipe(
      // The line itself can carry anything Peer Loop was transporting — an
      // owner message, a task, a path — so it is recorded in the bounded local
      // tail and the error a client sees says only what category of thing went
      // wrong.
      Effect.tapError(() =>
        Effect.sync(() => {
          recordDiagnostic(`unrecognised protocol line: ${line}`);
        }),
      ),
      Effect.mapError(() => new PeerLoopProtocolError({ detail: PEER_LOOP_PUBLIC_MALFORMED_LINE })),
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
      // Never waits, and never drops silently. A refused offer means this
      // subscriber's feed is full; it is marked and ended so the layer above
      // can tell the client to re-attach from a cursor it can still trust.
      for (const feed of subscribers) {
        if (feed.overflowed) continue;
        if (Queue.offerUnsafe(feed.queue, { kind: "notification", message })) continue;
        feed.overflowed = true;
        subscribers.delete(feed);
        // Full by definition, so the consumer is not parked and will observe
        // the end once it has drained what it can still be given.
        Queue.endUnsafe(feed.queue);
      }
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
    // Already abandoned — a timed-out or cancelled request. Ignored rather than
    // resolving a caller that has been told this did not answer.
    if (entry === undefined) return;
    pending.delete(message.id);

    // A response that answers a different method than the request it claims to
    // answer is not something to interpret optimistically: correlation is the
    // only thing making any of these results meaningful.
    if (message.method !== entry.method) {
      recordDiagnostic(
        `response ${message.id} claimed method ${String(message.method)} for a ${entry.method} request`,
      );
      const violation = new PeerLoopProtocolError({ detail: PEER_LOOP_PUBLIC_METHOD_MISMATCH });
      yield* Deferred.fail(entry.deferred, violation);
      return yield* shutdown(violation);
    }

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
      Effect.sync(() => recordDiagnostic(`stdin write failed: ${String(cause)}`)).pipe(
        Effect.andThen(
          shutdown(
            new PeerLoopTransportError({
              detail: PEER_LOOP_PUBLIC_STDIN_FAILURE,
              exitCode: null,
            }),
          ),
        ),
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
        Effect.sync(() => {
          if (!isProtocolError(cause)) recordDiagnostic(`stdout read failed: ${String(cause)}`);
        }).pipe(
          Effect.andThen(
            shutdown(
              isProtocolError(cause)
                ? cause
                : new PeerLoopTransportError({
                    detail: PEER_LOOP_PUBLIC_READ_FAILURE,
                    exitCode: null,
                  }),
            ),
          ),
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
    Stream.runForEach((line) => Effect.sync(() => recordDiagnostic(line))),
    Effect.ignore,
    Effect.forkScoped,
  );

  /**
   * One request, bounded end to end and cleaned up on every exit.
   *
   * THE TIMEOUT COVERS THE ENQUEUE TOO. stdin is a bounded queue, so a bridge
   * that has stopped reading makes the offer itself block — and a timer started
   * after the offer would never run. The bound therefore wraps registering,
   * enqueueing and awaiting as one thing.
   *
   * THE PENDING ENTRY IS REMOVED ON EVERY PATH — success, refusal, timeout, a
   * cancelled caller, a failed enqueue, a transport that ended underneath it.
   * `ensuring` is what makes that true for interruption, which is the path a
   * hand-written cleanup always misses. A response that arrives afterwards
   * finds nothing to resolve and is ignored.
   *
   * A TIMED-OUT MUTATION IS NOT RETRIED. Peer Loop may have accepted it and
   * finished after we stopped waiting; repeating a `run.start` would fork a
   * session and repeating a `run.recover` would replay a Builder task. The
   * error says so and the owner decides.
   */
  const request = Effect.fn("peerLoop.bridge.request")(function* (
    method: PeerLoopBridgeMethod,
    params: Readonly<Record<string, unknown>>,
  ) {
    const alreadyClosed = yield* Deferred.isDone(closed);
    if (alreadyClosed) return yield* Deferred.await(closed).pipe(Effect.flatMap(Effect.fail));

    nextRequestId += 1;
    const id = `t3-${nextRequestId}`;
    const timeout = LIFECYCLE_METHODS.has(method) ? lifecycleTimeout : requestTimeout;

    const line = encodeRequestLine({
      v: PEER_LOOP_PROTOCOL_VERSION,
      type: "request",
      id,
      method,
      params,
    });

    const exchange = Effect.gen(function* () {
      const deferred = yield* Deferred.make<unknown, PeerLoopError>();
      yield* Effect.sync(() => {
        pending.set(id, { method, deferred });
      });
      yield* Queue.offer(stdinQueue, encoder.encode(`${line}\n`));
      return yield* Deferred.await(deferred);
    });

    const answered = yield* exchange.pipe(
      Effect.timeoutOption(timeout),
      Effect.ensuring(
        Effect.sync(() => {
          pending.delete(id);
        }),
      ),
    );

    if (Option.isNone(answered)) {
      return yield* new PeerLoopTimeoutError({
        method,
        timeoutMs: Duration.toMillis(timeout),
        mayHaveApplied: MUTATING_METHODS.has(method),
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
    // a drain fiber parked on an empty queue, which is what actually closes the
    // child's stdin. Offered UNSAFELY, because a full queue means the drain
    // fiber is already awake and shutdown must not block waiting for room.
    Effect.sync(() => Queue.offerUnsafe(stdinQueue, EMPTY_CHUNK)).pipe(
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

  // Announcing version 1 is a claim, not a guarantee. A bridge missing a method
  // this build calls, or a notification it stays in sync from, is incompatible
  // whatever it labels itself — and the handshake is a far better place to find
  // that out than the middle of a run. Extra capabilities are additive.
  const missing = missingPeerLoopCapabilities(health);
  if (missing.length > 0) {
    return yield* new PeerLoopIncompatibleError({
      expected: PEER_LOOP_PROTOCOL_VERSION,
      reported: health.protocolVersion,
      detail: `the bridge announced protocol 1 without: ${missing.join(", ")}`,
    });
  }

  return {
    pid: Number(handle.pid),
    health,
    request,
    subscribe,
    closed: Deferred.await(closed),
    stderrTail,
    pendingRequestCount: Effect.sync(() => pending.size),
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
