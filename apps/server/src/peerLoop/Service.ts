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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";

import {
  connect,
  type PeerLoopBridgeConnection,
  type PeerLoopFeedItem,
  type PeerLoopNotificationFeed,
} from "./Bridge.ts";
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
    /**
     * The most attaches ever inside ONE run's replay gate at the same time.
     *
     * The other half of the same inspection seam: `replaySlotCount` proves the
     * coordination map is bounded, this proves the gate in it actually
     * excludes. Per run, deliberately — a global count would read 2 for two
     * different runs replaying at once, which is correct behaviour, and would
     * therefore say nothing about the invariant that matters. Not an RPC.
     */
    readonly peakSameRunReplays: Effect.Effect<number>;
    /**
     * How each recent replay boundary ended, newest last and bounded.
     *
     * A snapshot-only attach has no subscription to tell, so its boundary
     * outcome would otherwise be unobservable — including the failures. Local
     * diagnostics: run id and outcome kind, never a cursor's contents, never
     * reachable from an RPC.
     */
    readonly recentBoundaryOutcomes: Effect.Effect<readonly string[]>;
  }
>()("t3/peerLoop/Service/PeerLoopService") {}

interface LiveConnection {
  readonly connection: PeerLoopBridgeConnection;
  readonly scope: Scope.Closeable;
}

/**
 * The connection, its handshake and whether this service is finished — one
 * value, changed under one mutex.
 *
 * Three separate refs could not express "adopted" as a single event. The layer
 * finalizer could land between writing `live` and writing `health`, release
 * what it found, and let the attempt go on to publish a `connected` transport
 * and a health snapshot for a child that had already been killed. Every
 * transition here is taken under `lifecycleGate`, so adoption and shutdown are
 * ordered rather than interleaved: whichever runs second sees the other's work.
 */
type PeerLoopLifecycle =
  | { readonly kind: "idle" }
  | {
      readonly kind: "live";
      readonly entry: LiveConnection;
      readonly health: PeerLoopHealth;
    }
  /** The layer finalizer ran. Terminal: nothing spawns or adopts again. */
  | { readonly kind: "stopped" };

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
  /** Live references to this slot. The entry disappears with the last one. */
  users: number;
  /** Attaches inside the gate right now. The invariant is that this stays 1. */
  active: number;
}

/** How long a replay may hold its run's slot before it is assumed finished. */
export const PEER_LOOP_REPLAY_BOUNDARY_TIMEOUT = Duration.seconds(30);

/** Recent boundary outcomes retained for local diagnostics. A tail, not a log. */
export const PEER_LOOP_BOUNDARY_OUTCOME_TAIL = 20;

/**
 * How a replay boundary ended. Every one of these is acted on.
 *
 * Only `synced` means the replay actually reached the high-water mark the
 * attach reported. The rest are the ways it did not, and they are kept apart
 * because they call for different words to the owner and because collapsing
 * them would make "we stopped waiting" indistinguishable from "Peer Loop said
 * its own stream had a hole".
 */
export type PeerLoopBoundaryKind =
  | "synced"
  /** Peer Loop said its stream is incomplete. Its cursor wins. */
  | "peer-resync"
  /** The service-owned watcher could not keep up. Ours, not Peer Loop's. */
  | "boundary-overflow"
  | "transport-ended"
  | "timeout"
  /** The service stopped, or the guard was cancelled, before the boundary. */
  | "cancelled";

export interface PeerLoopBoundaryResult {
  readonly kind: PeerLoopBoundaryKind;
  /** Category only. Safe to hand a client verbatim. */
  readonly reason: string;
}

const BOUNDARY_REASON: Readonly<Record<Exclude<PeerLoopBoundaryKind, "synced">, string>> = {
  "peer-resync": "Peer Loop reported that this run's event stream was incomplete",
  "boundary-overflow":
    "this server could not follow the replay for this run; re-subscribe from afterSeq",
  "transport-ended": "the Peer Loop bridge stopped before this replay finished",
  timeout: "this run's replay did not reach its reported boundary in time",
  cancelled: "this server stopped following the replay before it finished",
};

const BOUNDARY_SYNCED: PeerLoopBoundaryResult = { kind: "synced", reason: "" };

const boundaryFailed = (kind: Exclude<PeerLoopBoundaryKind, "synced">): PeerLoopBoundaryResult => ({
  kind,
  reason: BOUNDARY_REASON[kind],
});

/**
 * The two things a subscription reacts to, in one stream.
 *
 * Merging rather than sequencing: the boundary verdict must be able to arrive
 * while the client is still draining its backlog, and the backlog must keep
 * flowing while the boundary is still undecided.
 */
type ReplayInput =
  | { readonly source: "feed"; readonly item: PeerLoopFeedItem }
  | { readonly source: "boundary"; readonly result: PeerLoopBoundaryResult };

/** What a subscriber is told when its own feed could not be kept complete. */
export const PEER_LOOP_CLIENT_FEED_OVERFLOW =
  "this server could not retain the event stream for this client; re-subscribe from afterSeq";

/**
 * What a waiter is told when its shared connection attempt did not finish.
 *
 * Only reachable when the service scope closes while a bridge is still being
 * started. A category, like every other public transport detail: no path, no
 * cause, nothing from the child.
 */
export const PEER_LOOP_ATTEMPT_ENDED = "the Peer Loop connection attempt ended before it completed";

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
  /**
   * Test-only injection points. Nothing in the product supplies these.
   *
   * Both sit in windows that are otherwise a matter of scheduler luck:
   * `beforeForkAttempt` between installing a connection claim and forking the
   * runner that has to complete it, and `beforeAdoptConnection` between a
   * finished handshake and the adoption that publishes it.
   */
  readonly testSeams?: {
    readonly beforeForkAttempt?: Effect.Effect<void>;
    readonly beforeAdoptConnection?: Effect.Effect<void>;
  };
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

  const testSeams = seams.testSeams ?? {};

  const lifecycle = yield* Ref.make<PeerLoopLifecycle>({ kind: "idle" });
  /**
   * The one mutex every lifecycle transition passes through.
   *
   * Adoption, release and shutdown all write the connection state AND publish a
   * transport status, and those two writes have to look like one event to
   * everybody else. Without the mutex, shutdown landing between them leaves a
   * `connected` status describing a child that has already been killed — a
   * client would be told the bridge is up and every call would fail.
   */
  const lifecycleGate = Semaphore.makeUnsafe(1);

  const currentEntry = Effect.map(Ref.get(lifecycle), (state) =>
    state.kind === "live" ? state.entry : null,
  );
  const currentHealth = Effect.map(Ref.get(lifecycle), (state) =>
    state.kind === "live" ? state.health : null,
  );
  const isStopped = Effect.map(Ref.get(lifecycle), (state) => state.kind === "stopped");
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
   * Publish a finished handshake as the live connection. One transition.
   *
   * Refuses, rather than adopting, once the layer has stopped: there would be
   * no finalizer left to release what it adopted. The caller closes the
   * provisional scope in that case, which is what makes every interleaving end
   * with no live entry, no health and a dead child.
   */
  const adoptConnection = (entry: LiveConnection, announced: PeerLoopHealth) =>
    lifecycleGate.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* Ref.get(lifecycle);
        if (state.kind === "stopped") return false;
        yield* Ref.set(lifecycle, { kind: "live", entry, health: announced });
        yield* setTransport("connected", null, announced.protocolVersion);
        return true;
      }).pipe(Effect.uninterruptible),
    );

  /**
   * Tear a connection down and say so.
   *
   * Deliberately does not reconnect. Peer Loop's durable state is untouched by
   * its bridge exiting, and reattaching would be T3Code deciding that a run
   * should keep going — which is Peer Loop's call and the owner's, not ours.
   *
   * A no-op once the layer has stopped, so a dying bridge cannot overwrite the
   * terminal state with `interrupted` after shutdown already said `stopped`.
   */
  const releaseConnection = (
    entry: LiveConnection,
    state: "interrupted" | "stopped",
    detail: string | null,
  ) =>
    lifecycleGate.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* Ref.get(lifecycle);
        if (current.kind !== "live" || current.entry !== entry) return;
        yield* Ref.set(lifecycle, { kind: "idle" });
        yield* setTransport(state, detail, null);
        yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
      }).pipe(Effect.uninterruptible),
    );

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

  /**
   * Spawn a bridge and adopt it. Only ever called through `runConnectionAttempt`.
   *
   * THE PROVISIONAL SCOPE IS CLOSED ON EVERY EXIT THAT IS NOT AN ADOPTION. A
   * typed failure, a defect, a rejected handshake and an interruption all leave
   * a child that nothing else holds a handle to, and an orphaned `peer-loop`
   * still holds Peer Loop's project leases — the single worst leak available
   * here. `onExit` covers the interruption case, which is the one a `tapError`
   * silently misses.
   */
  const openConnection = Effect.gen(function* () {
    // After shutdown there is no scope left to own a child, so a late call
    // must refuse rather than leave an orphan bridge holding project leases.
    if (yield* isStopped) {
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

    /**
     * True once the lifecycle owns this scope, so nothing else may close it.
     *
     * Set inside the same uninterruptible step as the adoption. A flag written
     * afterwards could be skipped by an interrupt landing in between, and the
     * `onExit` below would then close a scope the lifecycle was still pointing
     * at — a live entry wrapping a dead child.
     */
    let adopted = false;

    const adoptable = Effect.gen(function* () {
      const connection = yield* connect(resolution.command, {
        ...connectOptions,
        ...(stopTimeout === undefined ? {} : { stopTimeout }),
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Scope.provide(scope),
        Effect.tapError((error) => setTransport("unavailable", error.message, null)),
      );

      if (testSeams.beforeAdoptConnection !== undefined) {
        yield* testSeams.beforeAdoptConnection;
      }

      const entry: LiveConnection = { connection, scope };
      const accepted = yield* adoptConnection(entry, connection.health).pipe(
        Effect.tap((ok) =>
          Effect.sync(() => {
            if (ok) adopted = true;
          }),
        ),
        Effect.uninterruptible,
      );

      // The layer stopped first. Nothing will release this child but us.
      if (!accepted) {
        return yield* new PeerLoopUnavailableError({ reason: "this server is shutting down" });
      }

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

    return yield* adoptable.pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) || adopted
          ? Effect.void
          : Scope.close(scope, Exit.void).pipe(Effect.ignore),
      ),
    );
  });

  /**
   * Run one connection attempt to completion and hand the result to everyone.
   *
   * Forked into the SERVICE scope, never run on a caller's fiber. An RPC fiber
   * is cancelled when its client disconnects, and a shared attempt that died
   * with its first caller would leave the other waiters parked forever and — if
   * the child had already spawned — a bridge nobody owns. So cancellation of
   * any individual waiter, including the one that won the claim, only cancels
   * that waiter.
   *
   * `ensuring` is the promise that no waiter is left parked: whether this fiber
   * succeeds, fails, dies or is interrupted by the layer shutting down, the
   * claim is cleared and the deferred is settled. Settling twice is a no-op, so
   * the normal path keeps its real outcome and only an abandoned attempt
   * resolves to the typed unavailable error.
   */
  /**
   * Stand this attempt down, and only this one.
   *
   * Conditional on purpose. An unconditional clear would let a finished
   * attempt's cleanup wipe out the claim a *later* caller had already installed
   * in its place, and the caller after that would then install a second one —
   * two attempts, two bridges, two writers for the same project leases.
   */
  const retireClaim = (target: Deferred.Deferred<PeerLoopBridgeConnection, PeerLoopError>) =>
    Ref.update(connecting, (current) => (current === target ? null : current));

  const runConnectionAttempt = (
    target: Deferred.Deferred<PeerLoopBridgeConnection, PeerLoopError>,
  ) =>
    Effect.gen(function* () {
      // A connection may have completed between another caller's read of the
      // lifecycle and this claim being installed.
      const settled = yield* currentEntry;
      const outcome =
        settled === null
          ? yield* Effect.exit(openConnection)
          : Exit.succeed<PeerLoopBridgeConnection>(settled.connection);

      // Cleared before the result is published, so no caller can join an
      // attempt that has already decided. A later explicit RPC starts a fresh
      // one; nothing retries on its own.
      yield* retireClaim(target);
      yield* Deferred.done(target, outcome);
    }).pipe(
      Effect.ensuring(
        retireClaim(target).pipe(
          Effect.andThen(
            Deferred.fail(
              target,
              new PeerLoopUnavailableError({ reason: PEER_LOOP_ATTEMPT_ENDED }),
            ),
          ),
        ),
      ),
      Effect.withSpan("peerLoop.connectionAttempt"),
    );

  /**
   * The live connection, opening one if there is not one already.
   *
   * The claim is a single `Ref.modify` — one atomic read-modify-write — so of
   * any number of concurrent cold callers exactly one installs the attempt and
   * the rest await its result, success or typed failure alike. Two bridges
   * would be two writers contending for the same project leases, which is the
   * one outcome Peer Loop's ownership model cannot express.
   *
   * The caller that installs the attempt does not run it; it waits on the
   * result exactly like everyone else.
   *
   * INSTALLING AND FORKING ARE ONE UNINTERRUPTIBLE HANDOFF. Cancellation
   * landing between them would leave a claim in the ref with nobody to complete
   * it, and every later caller would park on that deferred until the layer went
   * down. Only the wait afterwards is interruptible — which is the part a
   * disconnecting client should be able to abandon.
   */
  const claimConnection = Effect.gen(function* () {
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

    if (claim.opener) {
      if (testSeams.beforeForkAttempt !== undefined) yield* testSeams.beforeForkAttempt;
      yield* Effect.forkIn(runConnectionAttempt(candidate), serviceScope);
    }

    return claim.deferred;
  }).pipe(Effect.uninterruptible);

  const ensureConnection: Effect.Effect<PeerLoopBridgeConnection, PeerLoopError> = Effect.gen(
    function* () {
      const existing = yield* currentEntry;
      if (existing !== null) return existing.connection;

      // No claim is installed after shutdown: there is no scope left to own a
      // child, and an orphan bridge would keep holding Peer Loop's leases.
      if (yield* isStopped) {
        return yield* new PeerLoopUnavailableError({ reason: "this server is shutting down" });
      }

      const shared = yield* claimConnection;
      return yield* Deferred.await(shared);
    },
  );

  /* ------------------------------------------------------ replay slots */

  const replaySlots = new Map<string, RunReplaySlot>();
  /** Test seam: the most attaches ever inside ONE run's gate. Must stay 1. */
  let peakSameRunReplays = 0;
  /** Bounded local record of how replays ended. Diagnostics; never an RPC. */
  const boundaryOutcomes: string[] = [];

  const recordBoundaryOutcome = (runId: string, kind: PeerLoopBoundaryKind): void => {
    boundaryOutcomes.push(`${runId}: ${kind}`);
    if (boundaryOutcomes.length > PEER_LOOP_BOUNDARY_OUTCOME_TAIL) boundaryOutcomes.shift();
  };

  /**
   * Find or create this run's gate, and take a reference to it.
   *
   * ONE SYNCHRONOUS STEP, WHICH IS THE ENTIRE POINT. Creating the semaphore
   * with an effect meant a lookup miss, a yield, and only then the write — so
   * two first attachments for the same run could each miss, each build their
   * own gate, and serialise against nothing. `makeUnsafe` keeps the miss and
   * the write in the same tick, where no fiber can interleave.
   */
  const acquireReplaySlot = (runId: string): Effect.Effect<RunReplaySlot> =>
    Effect.sync(() => {
      const existing = replaySlots.get(runId);
      if (existing !== undefined) {
        existing.users += 1;
        return existing;
      }
      const slot: RunReplaySlot = { gate: Semaphore.makeUnsafe(1), users: 1, active: 0 };
      replaySlots.set(runId, slot);
      return slot;
    });

  /**
   * Give the reference back, deleting the entry with its last user.
   *
   * Takes the slot rather than looking it up again: releasing by run id could
   * decrement a *different* slot created after this one was already deleted,
   * and a client naming arbitrary run ids must not be able to corrupt a count.
   */
  const releaseReplaySlot = (runId: string, slot: RunReplaySlot) =>
    Effect.sync(() => {
      slot.users -= 1;
      if (slot.users <= 0 && replaySlots.get(runId) === slot) replaySlots.delete(runId);
    });

  /**
   * What one attach reached before its guard let the next one in.
   *
   * `boundary` is completed exactly once, by the guard, with one of the kinds
   * above. A subscription races it: on anything other than `synced` it stops at
   * the cursor it had actually delivered and says so.
   */
  interface AttachHandle {
    readonly result: PeerLoopAttachResult;
    readonly clientFeed: PeerLoopNotificationFeed | null;
    readonly boundary: Deferred.Deferred<PeerLoopBoundaryResult>;
  }

  /** What a boundary watcher can conclude from one item on its feed. */
  type BoundarySignal = "reached" | "peer-resync" | "ended";

  /**
   * Follow one replay to its boundary, then let the next attach in.
   *
   * SERVICE-OWNED AND FAST. It has its own run-filtered feed and drains it as
   * quickly as the bridge produces, so holding the run's permit never depends
   * on how fast a phone is reading. The subscriber's own feed is untouched by
   * this, which is what lets delivery start the moment Peer Loop answers.
   *
   * Success is only ever one of two things: the attach reported a boundary the
   * client is already past, or an event for THIS run arrived with a sequence at
   * or beyond it. Never a count — sequences skip legitimately, so the number of
   * events in a replay is not knowable in advance.
   */
  const runBoundaryGuard = (
    runId: string,
    afterSeq: number,
    highWaterMark: number,
    watcher: PeerLoopNotificationFeed,
  ): Effect.Effect<PeerLoopBoundaryResult> =>
    Effect.gen(function* () {
      if (highWaterMark <= afterSeq) return BOUNDARY_SYNCED;

      const signals = yield* Stream.fromQueue(watcher.queue).pipe(
        Stream.map((item): readonly BoundarySignal[] => {
          if (item.kind === "ended") return ["ended"];
          const message = item.message;
          if (message.method === "run.resync") return ["peer-resync"];
          if (message.method === "run.event" && message.params.event.seq >= highWaterMark) {
            return ["reached"];
          }
          return [];
        }),
        Stream.flattenIterable,
        Stream.take(1),
        Stream.runCollect,
        // Never discarded: `None` here is the timeout, and it is a distinct
        // outcome from every other way this can end.
        Effect.timeoutOption(replayBoundaryTimeout),
      );

      if (Option.isNone(signals)) return boundaryFailed("timeout");

      const signal = signals.value[0];
      if (signal === undefined) {
        // The feed ended without a verdict. Either this server could not follow
        // the replay, or the bridge went away; those are not the same thing.
        return boundaryFailed(
          (yield* watcher.overflowed) ? "boundary-overflow" : "transport-ended",
        );
      }
      if (signal === "reached") return BOUNDARY_SYNCED;
      return boundaryFailed(signal === "peer-resync" ? "peer-resync" : "transport-ended");
    }).pipe(Effect.withSpan("peerLoop.replayBoundary", { attributes: { runId } }));

  /**
   * Attach to a run, and hand the run's replay permit to a service-owned guard.
   *
   * THE ORDER IS THE DESIGN.
   *
   *   1. take a reference to the run's gate, then its single permit — so no two
   *      attaches for one run are ever outstanding at once. Peer Loop keeps one
   *      attachment per run, and a second `run.attach` mid-replay supersedes the
   *      first, leaving whoever asked for it with a stream that simply stops;
   *   2. only THEN create the boundary watcher and, when there is one, the
   *      client's feed. Creating them earlier would make a queued subscriber
   *      bank the *previous* subscriber's replay and spend its whole bound on
   *      events it will drop as duplicates;
   *   3. send `run.attach` and validate the answer;
   *   4. return. The caller gets its stream immediately, before a single
   *      backlog notification has been consumed — which is the difference
   *      between a large backlog being delivered and it overflowing unread;
   *   5. the permit stays held by a bounded guard fiber until the replay
   *      reaches the boundary the attach itself reported, or explicitly fails
   *      to. It is always released, and the outcome is always recorded.
   */
  interface AttachOwnership {
    readonly slot: RunReplaySlot;
    readonly guardScope: Scope.Closeable;
    /** True once the guard fiber owns the permit, the reference and the scope. */
    handedOff: boolean;
    /** True once the permit is held, so it is only ever given back once. */
    holdsPermit: boolean;
  }

  /** Give back everything an attach took. Runs once: here, or in the guard. */
  const standDown = (runId: string, owned: AttachOwnership) =>
    Scope.close(owned.guardScope, Exit.void).pipe(
      Effect.ignore,
      Effect.andThen(
        Effect.suspend(() => {
          if (!owned.holdsPermit) return Effect.void;
          owned.holdsPermit = false;
          owned.slot.active -= 1;
          return owned.slot.gate.release(1);
        }),
      ),
      Effect.andThen(releaseReplaySlot(runId, owned.slot)),
    );

  const attachCoordinated = (
    connection: PeerLoopBridgeConnection,
    runId: string,
    afterSeq: number,
    wantsClientFeed: boolean,
  ): Effect.Effect<AttachHandle, PeerLoopError, Scope.Scope> =>
    Effect.acquireUseRelease(
      // Uninterruptibly, and paired with the release below: a caller cancelled
      // between taking the reference and installing the cleanup would leak an
      // entry in the coordination map for a run nobody is watching.
      Effect.gen(function* () {
        const slot = yield* acquireReplaySlot(runId);
        const guardScope = yield* Scope.make();
        const owned: AttachOwnership = { slot, guardScope, handedOff: false, holdsPermit: false };
        return owned;
      }),
      (owned) =>
        Effect.gen(function* () {
          // The wait for the permit stays interruptible — a client queued
          // behind another replay must be able to disconnect — but taking it
          // and recording that we hold it are one step, so an interrupt can
          // never land between them and lose the permit.
          yield* Effect.uninterruptibleMask((restore) =>
            restore(owned.slot.gate.take(1)).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  owned.holdsPermit = true;
                  owned.slot.active += 1;
                  peakSameRunReplays = Math.max(peakSameRunReplays, owned.slot.active);
                }),
              ),
            ),
          );

          // Created only now: a subscriber queued behind another attach must
          // not bank the earlier replay on a feed it opened too early.
          const watcher = yield* connection
            .subscribeRun(runId)
            .pipe(Scope.provide(owned.guardScope));
          const clientFeed = wantsClientFeed ? yield* connection.subscribeRun(runId) : null;

          const raw = yield* connection.request("run.attach", { runId, afterSeq });
          const result = yield* decodeAttach(raw).pipe(
            Effect.mapError(
              () =>
                new PeerLoopProtocolError({
                  detail: "the bridge returned a run.attach result this build cannot read",
                }),
            ),
          );

          const boundary = yield* Deferred.make<PeerLoopBoundaryResult>();
          const guard = runBoundaryGuard(runId, afterSeq, result.eventHighWaterMark, watcher).pipe(
            // Cancellation — the layer going down mid-replay — is an outcome
            // like any other, and the waiting subscription has to hear it.
            Effect.onExit((exit) => {
              const settled: PeerLoopBoundaryResult = Exit.isSuccess(exit)
                ? exit.value
                : boundaryFailed("cancelled");
              recordBoundaryOutcome(runId, settled.kind);
              return Deferred.succeed(boundary, settled);
            }),
            Effect.ensuring(standDown(runId, owned)),
            Effect.asVoid,
          );

          // The handoff, uninterruptible so the permit is never owned by
          // nobody: either this fiber still holds it, or the guard does.
          yield* Effect.forkIn(guard, serviceScope).pipe(
            Effect.andThen(
              Effect.sync(() => {
                owned.handedOff = true;
              }),
            ),
            Effect.uninterruptible,
          );

          return { result, clientFeed, boundary } satisfies AttachHandle;
        }),
      (owned) => (owned.handedOff ? Effect.void : standDown(runId, owned)),
    ).pipe(Effect.withSpan("peerLoop.attach", { attributes: { runId } }));

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
      health: yield* currentHealth,
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

  /**
   * A snapshot, back as soon as Peer Loop has answered.
   *
   * The guard keeps the run's permit until the replay this attach started
   * reaches its boundary, so the next attach cannot supersede it — but no
   * caller waits for that. There is no subscription here to tell about the
   * boundary, so its outcome goes to the bounded local record instead of being
   * dropped.
   */
  const attachRun = Effect.fn("peerLoop.attachRun")(function* (input: PeerLoopAttachRunInput) {
    const connection = yield* ensureConnection;
    const handle = yield* attachCoordinated(
      connection,
      input.runId,
      input.afterSeq ?? 0,
      false,
    ).pipe(Effect.scoped);
    return handle.result;
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
        const opening = yield* SubscriptionRef.get(transport);
        const startCursor = input.afterSeq ?? 0;

        // The feed is created INSIDE the attach coordination, after this run's
        // permit is held and before `run.attach` goes out, and this returns as
        // soon as Peer Loop has answered — before a single backlog notification
        // has been read. That is what lets a backlog larger than one feed's
        // bound be delivered instead of overflowing unread.
        const handle = yield* attachCoordinated(connection, input.runId, startCursor, true);
        const feed = handle.clientFeed;
        if (feed === null) {
          return yield* new PeerLoopProtocolError({
            detail: "the Peer Loop subscription could not be opened",
          });
        }
        const highWaterMark = handle.result.eventHighWaterMark;

        let cursor = startCursor;
        /** Set when this stream must stop advancing: it is no longer complete. */
        let frozen = false;
        /** At most one catch-up fact per subscription, and never after a resync. */
        let synced = false;

        /** The catch-up fact, if this delivery has just crossed the boundary. */
        const syncedIfCaughtUp = (): readonly PeerLoopSubscriptionEvent[] => {
          if (synced || frozen || cursor < highWaterMark) return [];
          synced = true;
          return [
            {
              kind: "run-synced",
              runId: input.runId,
              afterSeq: cursor,
              eventHighWaterMark: highWaterMark,
            },
          ];
        };

        const project = (input_: ReplayInput): readonly PeerLoopSubscriptionEvent[] => {
          if (frozen) return [];

          if (input_.source === "boundary") {
            // Success needs no announcement here: the cursor logic above emits
            // the catch-up fact when this subscriber has actually delivered
            // through the boundary, which is a stronger statement.
            if (input_.result.kind === "synced") return [];
            frozen = true;
            return [
              {
                kind: "run-resync",
                runId: input.runId,
                afterSeq: cursor,
                reason: input_.result.reason,
              },
            ];
          }

          const item = input_.item;
          // The transport ended. `closing` decides what that means for this
          // subscriber, which depends on whether it reached its boundary first.
          if (item.kind === "ended") return [];

          const message = item.message;
          switch (message.method) {
            case "run.event": {
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
                ...syncedIfCaughtUp(),
              ];
            }
            case "run.outcome":
              return [
                {
                  kind: "run-outcome",
                  runId: input.runId,
                  outcome: message.params.outcome,
                  state: message.params.state,
                },
              ];
            case "run.finished":
              return [
                {
                  kind: "run-finished",
                  runId: input.runId,
                  outcome: message.params.outcome,
                  state: message.params.state,
                  reason: message.params.reason,
                },
              ];
            case "run.resync": {
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
        };

        // The boundary rides alongside the feed rather than in front of it. The
        // feed decides when this stream ends (`haltStrategy: "left"`), so a
        // client whose own queue overflowed hears about it at once instead of
        // waiting out the guard's bound.
        const merged = Stream.merge(
          Stream.map(
            Stream.fromQueue(feed.queue),
            (item): ReplayInput => ({ source: "feed", item }),
          ),
          Stream.map(
            Stream.fromEffect(Deferred.await(handle.boundary)),
            (result): ReplayInput => ({ source: "boundary", result }),
          ),
          { haltStrategy: "left" },
        );

        const projected = merged.pipe(
          Stream.map(project),
          Stream.flattenIterable,
          // A resync is the last thing this subscription says. Continuing would
          // mean advancing across a range nobody can vouch for.
          Stream.takeUntil((event) => event.kind === "run-resync"),
        );

        /**
         * How the stream ends, decided when it ends rather than in advance.
         *
         * Four ways out and they are not interchangeable: a resync already went
         * out, this subscriber's own feed overflowed, its replay never reached
         * the boundary, or the bridge went away. The last must not report the
         * stale `connected` a naive read of the transport ref would still be
         * showing, so the state comes from what happened to the connection.
         */
        const resyncing = (reason: string): readonly PeerLoopSubscriptionEvent[] => [
          { kind: "run-resync", runId: input.runId, afterSeq: cursor, reason },
        ];

        const closing = Effect.gen(function* () {
          // A resync already went out, from Peer Loop or from the boundary.
          if (frozen) return [] as readonly PeerLoopSubscriptionEvent[];

          if (yield* feed.overflowed) return resyncing(PEER_LOOP_CLIENT_FEED_OVERFLOW);

          // Whichever of the feed and the boundary got here first, the answer
          // is the same, so the outcome does not depend on the race. Polled
          // rather than awaited: a client that overflowed must not wait out the
          // guard's bound to be told.
          if (yield* Deferred.isDone(handle.boundary)) {
            const settled = yield* Deferred.await(handle.boundary);
            if (settled.kind !== "synced") return resyncing(settled.reason);
          }

          // The feed ended before this subscriber reached its boundary. The
          // replay is incomplete however the guard eventually rules.
          if (!synced) return resyncing(BOUNDARY_REASON["transport-ended"]);

          const stoppedByUs = yield* isStopped;
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

        const head: readonly PeerLoopSubscriptionEvent[] = [
          { kind: "transport", transport: opening },
          // Already past the boundary this attach reported: there is nothing to
          // wait for, and saying so at once is what stops a client sitting on
          // `needsResync` forever after an uneventful reattachment.
          ...syncedIfCaughtUp(),
        ];

        return Stream.concat(
          Stream.fromIterable(head),
          Stream.concat(projected, Stream.flattenIterable(Stream.fromEffect(closing))),
        );
      }),
    );

  const diagnostics = Effect.gen(function* () {
    const entry = yield* currentEntry;
    return entry === null ? [] : yield* entry.connection.stderrTail;
  });

  // A normal server shutdown closes stdin and lets Peer Loop reach its own safe
  // boundary. It is not killed here; the bridge's own finalizer holds the only
  // handle that could, and only after waiting. One gated transition, so an
  // adoption racing this either loses and cleans up after itself, or wins and
  // is released right here.
  yield* Effect.addFinalizer(() =>
    lifecycleGate
      .withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(lifecycle);
          yield* Ref.set(lifecycle, { kind: "stopped" });
          if (current.kind !== "live") return;
          yield* setTransport("stopped", null, null);
          yield* Scope.close(current.entry.scope, Exit.void).pipe(Effect.ignore);
        }).pipe(Effect.uninterruptible),
      )
      .pipe(Effect.ignore),
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
    peakSameRunReplays: Effect.sync(() => peakSameRunReplays),
    recentBoundaryOutcomes: Effect.sync(() => [...boundaryOutcomes]),
  });
});

export const layer = Layer.effect(PeerLoopService, make());

/** Exported so tests can assert the version this build refuses to deviate from. */
export const EXPECTED_PROTOCOL_VERSION = PEER_LOOP_PROTOCOL_VERSION;
