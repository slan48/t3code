/**
 * The Peer Loop service: laziness, fan-out, and refusals that stay legible.
 *
 * Everything runs against the deterministic fake bridge, selected through the
 * same machine-local executable configuration a real install uses. No agent is
 * invoked and nothing is billed.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { PeerLoopSubscriptionEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as Clock from "effect/Clock";

import * as ServerConfig from "../config.ts";

import { make, PeerLoopService } from "./Service.ts";
import { PEER_LOOP_NODE_ENTRY_ENV } from "./Command.ts";

const fixtureEntry = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../../test/fixtures/peer-loop-fake-bridge.mjs"),
);

/**
 * Point the machine-local configuration at the fake bridge.
 *
 * The env var is the documented developer override, so this exercises the real
 * resolution path rather than injecting a command behind it.
 */
const useFakeBridge = (scenario: string) =>
  Effect.gen(function* () {
    const entry = yield* fixtureEntry;
    process.env[PEER_LOOP_NODE_ENTRY_ENV] = entry;
    process.env["T3_PEER_LOOP_FAKE_SCENARIO"] = scenario;
  });

const withoutBridge = Effect.sync(() => {
  delete process.env[PEER_LOOP_NODE_ENTRY_ENV];
  delete process.env["T3_PEER_LOOP_EXECUTABLE"];
});

/**
 * Bounds small enough that a test measures behaviour rather than wall clock.
 *
 * The real stop bound is minutes, because closing stdin asks Peer Loop to
 * finish the agent turn it is running. A test cannot wait for that and does not
 * need to: what it is checking is that the bound is honoured, not how long it
 * is.
 */
const TEST_SEAMS = {
  connect: {
    handshakeTimeout: Duration.seconds(5),
    stopTimeout: Duration.millis(200),
  },
  replayBoundaryTimeout: Duration.seconds(2),
} as const;

/** A service instance in its own scope, so each test owns its bridge. */
const makeService = Effect.gen(function* () {
  const scope = yield* Scope.make();
  const service = yield* make(TEST_SEAMS).pipe(Scope.provide(scope));
  return { service, scope } as const;
});

/**
 * A spawner that counts children and can hold them at a barrier.
 *
 * The barrier is what makes a cold race real rather than hoped for: every
 * caller reaches the spawn together, and only then is one allowed through.
 * `reachedSpawn` and `childStarted` turn "the attempt is now at this exact
 * point" into something a test can wait on instead of sleeping and hoping.
 */
interface CountingSpawner {
  readonly layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly spawned: () => number;
  /**
   * How many spawn calls were ever entered, released or not.
   *
   * Distinct from `spawned`, and the distinction is the point: an attempt that
   * was abandoned and silently restarted shows up here and nowhere else.
   */
  readonly attempts: () => number;
  /** Pids of children that were actually created, in order. */
  readonly pids: () => readonly number[];
  readonly release: () => void;
  /** Resolves once `count` spawn calls have reached the gate. */
  readonly reachedSpawn: (count: number) => Effect.Effect<void>;
  /** Resolves once `count` children actually exist. */
  readonly childStarted: (count: number) => Effect.Effect<void>;
}

interface CountWaiter {
  readonly count: number;
  readonly resume: () => void;
}

const makeCountingSpawner = (
  real: ChildProcessSpawner.ChildProcessSpawner["Service"],
  options: { readonly hold?: boolean; readonly fail?: boolean } = {},
): CountingSpawner => {
  let count = 0;
  let reached = 0;
  let started = 0;
  const pids: number[] = [];
  let open = options.hold !== true;
  const waiters: Array<() => void> = [];
  const reachedWaiters: CountWaiter[] = [];
  const startedWaiters: CountWaiter[] = [];

  const wake = (list: CountWaiter[], value: number): void => {
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const waiter = list[index];
      if (waiter !== undefined && value >= waiter.count) {
        list.splice(index, 1);
        waiter.resume();
      }
    }
  };

  const awaitCount = (list: CountWaiter[], current: () => number, count: number) =>
    Effect.callback<void>((resume) => {
      if (current() >= count) {
        resume(Effect.void);
        return;
      }
      list.push({ count, resume: () => resume(Effect.void) });
    });

  const gate = Effect.callback<void>((resume) => {
    if (open) {
      resume(Effect.void);
      return;
    }
    waiters.push(() => resume(Effect.void));
  });

  return {
    spawned: () => count,
    attempts: () => reached,
    pids: () => [...pids],
    reachedSpawn: (target) => awaitCount(reachedWaiters, () => reached, target),
    childStarted: (target) => awaitCount(startedWaiters, () => started, target),
    release: () => {
      open = true;
      for (const waiter of waiters.splice(0)) waiter();
    },
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
      ChildProcessSpawner.ChildProcessSpawner.of({
        ...real,
        spawn: (command) =>
          Effect.sync(() => {
            reached += 1;
            wake(reachedWaiters, reached);
          }).pipe(
            Effect.andThen(gate),
            Effect.andThen(
              Effect.sync(() => {
                count += 1;
              }),
            ),
            Effect.andThen(
              options.fail === true
                ? Effect.die(new Error("spawn refused by the counting spawner"))
                : real.spawn(command),
            ),
            Effect.tap((handle) =>
              Effect.sync(() => {
                pids.push(Number(handle.pid));
                started += 1;
                wake(startedWaiters, started);
              }),
            ),
          ),
      }),
    ),
  };
};

/**
 * Releases every party at once.
 *
 * The last to arrive opens the gate, so "at the same time" is a fact rather
 * than a sleep long enough that it probably worked.
 */
const makeBarrier = (parties: number) =>
  Effect.gen(function* () {
    const open = yield* Deferred.make<void>();
    let arrived = 0;
    return {
      arrive: Effect.suspend(() => {
        arrived += 1;
        return arrived >= parties
          ? Effect.asVoid(Deferred.succeed(open, undefined))
          : Deferred.await(open);
      }),
    } as const;
  });

/** Read-only liveness probe. Sends no signal; only ever asked about our child. */
const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Sequence numbers of the run events in a collected subscription stream. */
const seqsOf = (events: readonly PeerLoopSubscriptionEvent[]): readonly number[] =>
  events.flatMap((event) => (event.kind === "run-event" ? [event.event.seq] : []));

const assertOrderedAndUnique = (seqs: readonly number[]): void => {
  assert.deepStrictEqual(
    [...seqs].sort((a, b) => a - b),
    seqs,
  );
  assert.strictEqual(new Set(seqs).size, seqs.length);
};

/**
 * Read one subscription until it says it has caught up.
 *
 * A fixed `take` cannot be used any more and should not be: the point of the
 * catch-up fact is that the client no longer has to guess how many events a
 * replay contains, which it never could — sequences skip.
 */
const collectUntilSynced = (
  service: PeerLoopService["Service"],
  runId: string,
  afterSeq: number,
  gate: Effect.Effect<void> = Effect.void,
) =>
  Stream.runCollect(
    Stream.takeUntil(
      Stream.unwrap(Effect.as(gate, service.subscribeEvents({ runId, afterSeq }))),
      (event) => event.kind === "run-synced" || event.kind === "run-resync",
    ),
  );

/**
 * Wait for every replay guard to let go.
 *
 * An attach now returns before its boundary — that is the whole point — so the
 * coordination map empties a moment later. Bounded, so a leak fails the test
 * rather than hanging it.
 */
const awaitNoReplaySlots = (service: PeerLoopService["Service"]) =>
  Effect.gen(function* () {
    const drained = yield* Effect.timeoutOption(
      Effect.andThen(Effect.sleep(Duration.millis(10)), service.replaySlotCount).pipe(
        Effect.repeat({ until: (count: number) => count === 0 }),
      ),
      Duration.seconds(8),
    );
    assert.isTrue(drained._tag === "Some", "replay coordination never returned to zero");
  });

/** Message plus every own field, so a leak cannot hide in an unasserted detail. */
const renderPublicError = (error: object): string =>
  [
    String((error as { readonly message?: unknown }).message),
    ...Object.values(error).map(String),
  ].join(" | ");

const testConfig = ServerConfig.layerTest(process.cwd(), { prefix: "peer-loop-service" });

it.layer(Layer.provideMerge(testConfig, NodeServices.layer), { excludeTestServices: true })(
  "PeerLoopService",
  (it) => {
    it.effect("stays inert until a Peer Loop RPC is used", () =>
      Effect.gen(function* () {
        yield* useFakeBridge("ready");
        const { service, scope } = yield* makeService;

        // Building the service must not have spawned anything: an install with
        // no Peer Loop pays nothing, and startup is unchanged.
        const before = yield* service.diagnostics;
        assert.deepStrictEqual(before, []);

        const status = yield* service.status({});
        assert.isTrue(status.configured);
        assert.strictEqual(status.executableSource, "env-node-entry");
        assert.strictEqual(status.transport.state, "connected");
        assert.strictEqual(status.health?.protocolVersion, 1);

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("reports an unconfigured environment as an answer, not a failure", () =>
      Effect.gen(function* () {
        yield* withoutBridge;
        process.env[PEER_LOOP_NODE_ENTRY_ENV] = "relative/path/main.js";
        const { service, scope } = yield* makeService;

        const status = yield* service.status({});
        assert.isFalse(status.configured);
        assert.strictEqual(status.executableSource, "env-node-entry");
        assert.strictEqual(status.transport.state, "unavailable");
        assert.include(status.transport.detail ?? "", "must be absolute");

        // A command still fails, and with the typed unavailable error.
        const error = yield* service.listRuns({}).pipe(Effect.flip);
        assert.strictEqual(error._tag, "PeerLoopUnavailableError");

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("lists runs and names the ones Peer Loop could not read", () =>
      Effect.gen(function* () {
        yield* useFakeBridge("ready");
        const { service, scope } = yield* makeService;

        const result = yield* service.listRuns({ projectPath: "/repos/demo" });
        assert.strictEqual(result.runs.length, 1);
        assert.strictEqual(result.runs[0]?.runId, "run-1");
        assert.strictEqual(result.runs[0]?.haltReason?.kind, "OWNER_PAUSED");
        assert.deepStrictEqual(result.unreadable, ["run-broken"]);

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("opens exactly one child for a real cold race", () =>
      Effect.gen(function* () {
        yield* useFakeBridge("ready");
        const real = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = makeCountingSpawner(real, { hold: true });

        const scope = yield* Scope.make();
        const service = yield* make(TEST_SEAMS).pipe(
          Effect.provide(spawner.layer),
          Scope.provide(scope),
        );

        // Six cold callers, every kind of entry point, all held at the spawn.
        const racers = yield* Effect.forkChild(
          Effect.all(
            [
              Effect.asVoid(service.status({})),
              Effect.asVoid(Effect.orDie(service.listRuns({}))),
              Effect.asVoid(Effect.orDie(service.attachRun({ runId: "run-1" }))),
              Effect.asVoid(Effect.orDie(service.pauseRun({ runId: "run-1" }))),
              Effect.asVoid(
                Effect.orDie(
                  Stream.runCollect(
                    Stream.take(service.subscribeEvents({ runId: "run-1", afterSeq: 5 }), 1),
                  ),
                ),
              ),
              Effect.asVoid(service.status({})),
            ],
            { concurrency: "unbounded" },
          ),
        );

        yield* Effect.sleep(Duration.millis(100));
        assert.strictEqual(spawner.spawned(), 0);
        spawner.release();
        yield* Fiber.await(racers);

        // Two bridges would be two writers contending for the same leases.
        assert.strictEqual(spawner.spawned(), 1);

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("shares one typed failure with every racing caller", () =>
      Effect.gen(function* () {
        yield* useFakeBridge("ready");
        const real = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = makeCountingSpawner(real, { hold: true, fail: true });

        const scope = yield* Scope.make();
        const service = yield* make(TEST_SEAMS).pipe(
          Effect.provide(spawner.layer),
          Scope.provide(scope),
        );

        const racers = yield* Effect.forkChild(
          Effect.all(
            [
              Effect.exit(Effect.asVoid(service.listRuns({}))),
              Effect.exit(Effect.asVoid(service.listRuns({}))),
              Effect.exit(Effect.asVoid(service.attachRun({ runId: "run-1" }))),
            ],
            { concurrency: "unbounded" },
          ),
        );

        yield* Effect.sleep(Duration.millis(80));
        spawner.release();
        const outcomes = yield* Fiber.await(racers).pipe(Effect.flatten);

        // One attempt, one failure, shared — not three children and three ways
        // to fail.
        assert.strictEqual(spawner.spawned(), 1);
        assert.isTrue(outcomes.every((outcome) => Exit.isFailure(outcome)));

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("finishes a shared attempt whose first caller disconnected", () =>
      Effect.gen(function* () {
        yield* useFakeBridge("ready");
        const real = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = makeCountingSpawner(real, { hold: true });

        const scope = yield* Scope.make();
        const service = yield* make(TEST_SEAMS).pipe(
          Effect.provide(spawner.layer),
          Scope.provide(scope),
        );

        // The winner installs the claim; the attempt reaches the held spawn.
        const winner = yield* Effect.forkChild(Effect.exit(Effect.asVoid(service.status({}))));
        yield* spawner.reachedSpawn(1);

        // A second caller joins the same attempt — `startImmediately` runs it
        // as far as its first suspension, which is the await on the shared
        // claim — and then the client that started it all goes away, a
        // websocket closing mid-RPC.
        const waiter = yield* Effect.forkChild(Effect.exit(Effect.asVoid(service.listRuns({}))), {
          startImmediately: true,
        });
        yield* Fiber.interrupt(winner);

        spawner.release();
        const settled = yield* Effect.flatten(Fiber.await(waiter));

        // The attempt belongs to the service, so cancelling one waiter neither
        // cancels it nor strands the others.
        assert.isTrue(Exit.isSuccess(settled));
        assert.strictEqual(spawner.spawned(), 1);
        // And it was the same attempt throughout — not abandoned and quietly
        // begun again by whoever was left.
        assert.strictEqual(spawner.attempts(), 1);

        const status = yield* service.status({});
        assert.strictEqual(status.transport.state, "connected");
        const pid = status.health?.bridge.pid ?? 0;
        assert.isAbove(pid, 0);
        assert.strictEqual(spawner.spawned(), 1);

        yield* Scope.close(scope, Exit.void);
        // Nothing this service started outlives it.
        assert.isFalse(isProcessAlive(pid));
      }),
    );

    it.effect("closes a provisional child when the handshake fails after its caller left", () =>
      Effect.gen(function* () {
        // This bridge never announces itself, so the attempt is still
        // mid-handshake — child alive, nothing adopted — when its caller is
        // cancelled. A provisional scope left open here is an orphan
        // `peer-loop` holding project leases nobody can release.
        yield* useFakeBridge("silent");
        const real = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = makeCountingSpawner(real);

        const scope = yield* Scope.make();
        const service = yield* make({
          connect: { handshakeTimeout: Duration.millis(400), stopTimeout: Duration.millis(200) },
          replayBoundaryTimeout: Duration.seconds(2),
        }).pipe(Effect.provide(spawner.layer), Scope.provide(scope));

        const winner = yield* Effect.forkChild(Effect.exit(Effect.asVoid(service.status({}))));
        yield* spawner.childStarted(1);
        const waiter = yield* Effect.forkChild(Effect.exit(Effect.asVoid(service.listRuns({}))));
        yield* Fiber.interrupt(winner);

        const settled = yield* Effect.flatten(Fiber.await(waiter));
        assert.isTrue(Exit.isFailure(settled));
        assert.strictEqual(spawner.spawned(), 1);

        const pid = spawner.pids()[0] ?? 0;
        assert.isAbove(pid, 0);
        assert.isFalse(isProcessAlive(pid));

        // A completed failure is not retried on its own.
        assert.strictEqual(spawner.spawned(), 1);

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("settles every waiter when the service stops mid-attempt", () =>
      Effect.gen(function* () {
        yield* useFakeBridge("ready");
        const real = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = makeCountingSpawner(real, { hold: true });

        const scope = yield* Scope.make();
        const service = yield* make(TEST_SEAMS).pipe(
          Effect.provide(spawner.layer),
          Scope.provide(scope),
        );

        const waiters = yield* Effect.forkChild(
          Effect.all(
            [
              Effect.exit(Effect.asVoid(service.listRuns({}))),
              Effect.exit(Effect.asVoid(service.attachRun({ runId: "run-1" }))),
            ],
            { concurrency: "unbounded" },
          ),
        );
        yield* spawner.reachedSpawn(1);

        // The layer goes down while the bridge is still being started.
        yield* Scope.close(scope, Exit.void);
        spawner.release();

        const outcomes = yield* Effect.flatten(Fiber.await(waiters));
        assert.isTrue(outcomes.every((outcome) => Exit.isFailure(outcome)));
        // The child never got past the gate, so there is nothing to leak.
        assert.deepStrictEqual(spawner.pids(), []);

        // And the claim is gone: a later call refuses rather than joining a
        // deferred nobody will ever complete.
        const error = yield* Effect.flip(Effect.asVoid(service.listRuns({})));
        assert.strictEqual(error._tag, "PeerLoopUnavailableError");
      }),
    );

    it.effect("takes the provisional child down with the layer, mid-handshake", () =>
      Effect.gen(function* () {
        // The child exists and nothing has adopted it: `live` is still null, so
        // the layer finalizer has nothing to release and only the attempt's own
        // exit can close that scope. Interruption is the path a `tapError`
        // never runs on, and the leak it leaves is a live `peer-loop`.
        yield* useFakeBridge("silent");
        const real = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = makeCountingSpawner(real);

        const scope = yield* Scope.make();
        const service = yield* make({
          connect: { handshakeTimeout: Duration.seconds(20), stopTimeout: Duration.millis(200) },
          replayBoundaryTimeout: Duration.seconds(2),
        }).pipe(Effect.provide(spawner.layer), Scope.provide(scope));

        const waiter = yield* Effect.forkChild(Effect.exit(Effect.asVoid(service.listRuns({}))));
        yield* spawner.childStarted(1);

        // Well inside the twenty-second handshake bound: nothing here is
        // waiting for a timeout to rescue it.
        yield* Scope.close(scope, Exit.void);

        const settled = yield* Effect.flatten(Fiber.await(waiter));
        assert.isTrue(Exit.isFailure(settled));

        const pid = spawner.pids()[0] ?? 0;
        assert.isAbove(pid, 0);
        assert.isFalse(isProcessAlive(pid));
      }),
    );

    it.effect("cannot be cancelled between installing a claim and forking its runner", () =>
      Effect.gen(function* () {
        // The narrowest window in the connection path: the claim is in the ref
        // and nothing is running it yet. An interrupt landing here leaves a
        // deferred nobody will ever complete, and every later caller parks on
        // it until the layer goes down.
        yield* useFakeBridge("ready");
        const arrived = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const real = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = makeCountingSpawner(real);

        const scope = yield* Scope.make();
        const service = yield* make({
          ...TEST_SEAMS,
          testSeams: {
            beforeForkAttempt: Deferred.succeed(arrived, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
            ),
          },
        }).pipe(Effect.provide(spawner.layer), Scope.provide(scope));

        const winner = yield* Effect.forkChild(Effect.exit(Effect.asVoid(service.listRuns({}))));
        yield* Deferred.await(arrived);

        // Forked and started at once, so the interrupt is genuinely delivered
        // while the winner is inside the handoff — the handoff being
        // uninterruptible is what makes that a request rather than an effect.
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(winner), {
          startImmediately: true,
        });
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.await(interrupting);

        // A caller arriving afterwards still gets a connection, which is only
        // true if the claim was completed rather than abandoned.
        const runs = yield* service.listRuns({});
        assert.strictEqual(runs.runs.length, 1);
        assert.strictEqual(spawner.spawned(), 1);

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("leaves nothing behind when shutdown races the adoption", () =>
      Effect.gen(function* () {
        // The handshake is finished and the connection is about to be
        // published. If the layer stops now, every interleaving still has to
        // end the same way: no live entry, no health, a stopped transport and
        // a dead child.
        yield* useFakeBridge("ready");
        const arrived = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const real = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = makeCountingSpawner(real);

        const scope = yield* Scope.make();
        const service = yield* make({
          ...TEST_SEAMS,
          testSeams: {
            // Uninterruptible, so the layer genuinely races the adoption
            // instead of simply cancelling the attempt before it.
            beforeAdoptConnection: Deferred.succeed(arrived, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.uninterruptible,
            ),
          },
        }).pipe(Effect.provide(spawner.layer), Scope.provide(scope));

        const caller = yield* Effect.forkChild(Effect.exit(Effect.asVoid(service.listRuns({}))));
        yield* Deferred.await(arrived);

        const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.await(closing);
        yield* Fiber.await(caller);

        const status = yield* service.status({});
        assert.notStrictEqual(status.transport.state, "connected");
        assert.strictEqual(status.health, null);

        const pid = spawner.pids()[0] ?? 0;
        assert.isAbove(pid, 0);
        assert.isFalse(isProcessAlive(pid));

        const error = yield* Effect.flip(Effect.asVoid(service.listRuns({})));
        assert.strictEqual(error._tag, "PeerLoopUnavailableError");
      }),
    );

    it.effect("gives two simultaneous same-run attachments one gate, not two", () =>
      Effect.gen(function* () {
        // Every replay here is paced, so the two genuinely overlap. Peer Loop
        // keeps one attachment per run: two gates would mean the second attach
        // supersedes the first mid-replay and strands it.
        yield* useFakeBridge("slow-replay");
        const { service, scope } = yield* makeService;

        // The bridge is already up, so the race is on the replay coordination
        // itself rather than on the connection.
        yield* service.status({});

        const barrier = yield* makeBarrier(2);
        // No stagger: both are released by the last one to arrive, and each
        // reads until it is told it has caught up.
        const [fromZero, fromThree] = yield* Effect.all(
          [
            collectUntilSynced(service, "run-unseen", 0, barrier.arrive),
            collectUntilSynced(service, "run-unseen", 3, barrier.arrive),
          ],
          { concurrency: "unbounded" },
        );

        // Two gates would have let both replays run at once.
        assert.strictEqual(yield* service.peakSameRunReplays, 1);
        yield* awaitNoReplaySlots(service);

        assert.deepStrictEqual(seqsOf(fromZero), [1, 2, 3, 4, 5]);
        assert.deepStrictEqual(seqsOf(fromThree), [4, 5]);
        for (const stream of [fromZero, fromThree]) {
          assertOrderedAndUnique(seqsOf(stream));
          assert.strictEqual(stream[stream.length - 1]?.kind, "run-synced");
        }

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("lets different runs replay at once without tripping the same-run gate", () =>
      Effect.gen(function* () {
        yield* useFakeBridge("slow-replay");
        const { service, scope } = yield* makeService;
        yield* service.status({});

        const barrier = yield* makeBarrier(2);
        const [first, second] = yield* Effect.all(
          [
            collectUntilSynced(service, "run-a", 0, barrier.arrive),
            collectUntilSynced(service, "run-b", 0, barrier.arrive),
          ],
          { concurrency: "unbounded" },
        );

        // Two runs replaying together is correct, and the per-run invariant is
        // the one that has to hold. A global counter would read 2 here and call
        // healthy behaviour a bug.
        assert.strictEqual(yield* service.peakSameRunReplays, 1);
        assert.deepStrictEqual(seqsOf(first), [1, 2, 3, 4, 5]);
        assert.deepStrictEqual(seqsOf(second), [1, 2, 3, 4, 5]);
        yield* awaitNoReplaySlots(service);

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("delivers the backlog after a subscriber's afterSeq, then live activity", () =>
      Effect.gen(function* () {
        yield* useFakeBridge("ready");
        const { service, scope } = yield* makeService;

        const events = yield* Stream.runCollect(
          service.subscribeEvents({ runId: "run-1", afterSeq: 3 }).pipe(Stream.take(5)),
        );

        // Opening transport fact first, then only what this client is missing.
        assert.strictEqual(events[0]?.kind, "transport");
        assert.deepStrictEqual(seqsOf(events), [4, 5, 6]);
        // The durable backlog is flagged as such; the tail is live.
        assert.deepStrictEqual(
          events.flatMap((event) => (event.kind === "run-event" ? [event.replay] : [])),
          [true, true, false],
        );
        // Caught up is announced once the boundary has actually been delivered,
        // which is after 5 and before the live 6.
        const synced = events.find((event) => event.kind === "run-synced");
        assert.strictEqual(synced?.kind, "run-synced");
        if (synced?.kind !== "run-synced") throw new Error("unreachable");
        assert.strictEqual(synced.afterSeq, 5);
        assert.strictEqual(synced.eventHighWaterMark, 5);
        assert.strictEqual(events.indexOf(synced), 3);

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("tells a subscriber that is already past the boundary at once", () =>
      Effect.gen(function* () {
        yield* useFakeBridge("ready");
        const { service, scope } = yield* makeService;

        // Already past everything the fake can produce. There is nothing to
        // replay, and a client left waiting for a catch-up fact that never
        // came would sit on `needsResync` for ever.
        const stream = service.subscribeEvents({ runId: "run-1", afterSeq: 6 });

        const [collected] = yield* Effect.all(
          [
            // A third event would mean a duplicate arrived.
            Effect.timeoutOption(Stream.runCollect(Stream.take(stream, 3)), "500 millis"),
            // Meanwhile another client attaches from scratch, which makes Peer
            // Loop replay the whole backlog for it.
            Effect.andThen(
              Effect.sleep("60 millis"),
              service.attachRun({ runId: "run-1", afterSeq: 0 }),
            ),
          ],
          { concurrency: "unbounded" },
        );

        assert.strictEqual(collected._tag, "None");

        const head = yield* Stream.runCollect(
          Stream.take(service.subscribeEvents({ runId: "run-1", afterSeq: 6 }), 2),
        );
        assert.strictEqual(head[0]?.kind, "transport");
        assert.strictEqual(head[1]?.kind, "run-synced");
        if (head[1]?.kind !== "run-synced") throw new Error("unreachable");
        assert.strictEqual(head[1].afterSeq, 6);

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("passes a refusal through with its code intact", () =>
      Effect.gen(function* () {
        yield* useFakeBridge("ready");
        const { service, scope } = yield* makeService;

        const busy = yield* service
          .startRun({ projectPath: "/repos/busy-project" })
          .pipe(Effect.flip);
        assert.strictEqual(busy._tag, "PeerLoopCommandRefusedError");
        assert.strictEqual(
          busy._tag === "PeerLoopCommandRefusedError" ? busy.code : null,
          "CONTROL_UNAVAILABLE",
        );

        const duplicate = yield* service
          .startRun({ projectPath: "/repos/unfinished-project" })
          .pipe(Effect.flip);
        assert.strictEqual(
          duplicate._tag === "PeerLoopCommandRefusedError" ? duplicate.code : null,
          "PROJECT_HAS_UNFINISHED_RUN",
        );

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("forwards pause, resume and recovery without deciding anything", () =>
      Effect.gen(function* () {
        yield* useFakeBridge("ready");
        const { service, scope } = yield* makeService;

        const paused = yield* service.pauseRun({ runId: "run-1" });
        assert.strictEqual(paused.applied, "live");

        // Resuming an interrupted run reports the interruption and stops there:
        // nothing is replayed until the owner says which of the three choices.
        const resumed = yield* service.resumeRun({ runId: "run-1" });
        assert.isTrue(resumed.interrupted);
        assert.strictEqual(resumed.state.state, "interrupted");

        const recovered = yield* service.recoverRun({
          runId: "run-1",
          choice: "resume_to_reviewer",
        });
        assert.strictEqual(recovered.choice, "resume_to_reviewer");
        assert.strictEqual(recovered.state.state, "idle");

        const message = yield* service.sendOwnerMessage({ runId: "run-1", text: "keep it local" });
        assert.isTrue(message.queued);

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("reports an unreadable result as a protocol error rather than guessing", () =>
      Effect.gen(function* () {
        yield* useFakeBridge("bad-result");
        const { service, scope } = yield* makeService;

        const error = yield* service.listRuns({}).pipe(Effect.flip);
        assert.strictEqual(error._tag, "PeerLoopProtocolError");

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("surfaces a transport interruption and does not resume anything", () =>
      Effect.gen(function* () {
        // The bridge announces itself and then writes something that is not
        // protocol, which ends the transport the same way an exit would.
        yield* useFakeBridge("garbage");
        const { service, scope } = yield* makeService;

        yield* service.status({});
        yield* Effect.sleep("150 millis");

        // The dead connection was dropped rather than silently replaced: no
        // bridge was restarted and no run was resumed on anyone's behalf.
        const diagnostics = yield* service.diagnostics;
        assert.deepStrictEqual(diagnostics, []);

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("stops the bridge when its scope closes", () =>
      Effect.gen(function* () {
        yield* useFakeBridge("ready");
        const { service, scope } = yield* makeService;

        const before = yield* service.status({});
        assert.strictEqual(before.transport.state, "connected");

        yield* Scope.close(scope, Exit.void);

        // Every command after shutdown fails rather than silently starting a
        // second bridge behind a closed scope — an orphan holding Peer Loop's
        // project leases would be the worst possible leak here.
        const error = yield* Effect.flip(service.listRuns({}));
        assert.strictEqual(error._tag, "PeerLoopUnavailableError");
      }),
    );

    it.effect("starts delivering a backlog larger than one feed can hold", () =>
      Effect.gen(function* () {
        // Two and a half thousand events against a bound of a thousand. Under
        // the old ordering the subscription was only returned once the replay
        // was over, so this backlog could not be delivered at all — the feed
        // filled up with nobody reading it.
        yield* useFakeBridge("big-backlog");
        const { service, scope } = yield* makeService;

        const events = yield* collectUntilSynced(service, "run-1", 0);

        const seqs = seqsOf(events);
        assertOrderedAndUnique(seqs);
        assert.strictEqual(seqs.length, 2_500);
        assert.strictEqual(seqs[seqs.length - 1], 2_500);

        const last = events[events.length - 1];
        assert.strictEqual(last?.kind, "run-synced");
        if (last?.kind !== "run-synced") throw new Error("unreachable");
        assert.strictEqual(last.eventHighWaterMark, 2_500);
        assert.strictEqual(last.afterSeq, 2_500);

        yield* awaitNoReplaySlots(service);
        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("treats a legitimate sequence gap as data, not as loss", () =>
      Effect.gen(function* () {
        // This run's durable log has no seq 3: Peer Loop numbered an event and
        // then failed to record it. Nothing was lost in transit, so nothing may
        // be reported as lost — and the catch-up fact still arrives, at the
        // real high-water mark rather than at a count nobody could compute.
        yield* useFakeBridge("sequence-gap");
        const { service, scope } = yield* makeService;

        const events = yield* collectUntilSynced(service, "run-1", 0);

        assert.deepStrictEqual(seqsOf(events), [1, 2, 4, 5]);
        assert.isFalse(events.some((event) => event.kind === "run-resync"));
        const last = events[events.length - 1];
        assert.strictEqual(last?.kind, "run-synced");
        if (last?.kind !== "run-synced") throw new Error("unreachable");
        assert.strictEqual(last.eventHighWaterMark, 5);
        assert.strictEqual(last.afterSeq, 5);

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("reports a real overflow explicitly and makes progress on reconnect", () =>
      Effect.gen(function* () {
        // Six thousand notifications against a feed that holds a thousand:
        // this server genuinely could not retain them, which is a fact rather
        // than something to infer from a sequence number.
        yield* useFakeBridge("overflow");
        const { service, scope } = yield* makeService;

        // Consumed deliberately slowly, so the feed genuinely cannot keep up.
        // A subscriber that drains as fast as the child writes would never
        // overflow, and would prove nothing.
        const slowly = (afterSeq: number) =>
          Stream.runCollect(
            Stream.tap(service.subscribeEvents({ runId: "run-1", afterSeq }), () =>
              Effect.sleep(Duration.millis(2)),
            ),
          );

        const events = yield* slowly(0);

        const last = events[events.length - 1];
        assert.strictEqual(last?.kind, "run-resync");
        if (last?.kind !== "run-resync") throw new Error("unreachable");
        assert.include(last.reason, "re-subscribe");
        // Overflow is not being caught up, and must never be dressed as it.
        assert.isFalse(events.some((event) => event.kind === "run-synced"));

        // Everything delivered before the resync is ordered, unique, and at or
        // below the cursor the client is told to resume from.
        const seqs = seqsOf(events);
        assertOrderedAndUnique(seqs);
        assert.strictEqual(last.afterSeq, seqs[seqs.length - 1] ?? 0);
        // The cursor moved: a resync back to where it started would be a loop
        // that never finishes, however many times the client tried.
        assert.isAbove(last.afterSeq, 0);

        // And reconnecting from it continues rather than repeating.
        const again = yield* slowly(last.afterSeq);
        const resumed = seqsOf(again);
        assertOrderedAndUnique(resumed);
        assert.isTrue(resumed.every((seq) => seq > last.afterSeq));
        assert.isAbove(resumed.length, 0);

        yield* awaitNoReplaySlots(service);
        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("gives up on a replay that never reaches its boundary, and says so once", () =>
      Effect.gen(function* () {
        // The attach announces a boundary at 9 and the replay stops at 3. The
        // permit cannot be held for ever, and the subscriber must not be left
        // looking complete.
        yield* useFakeBridge("never-reaches-boundary");
        const scope = yield* Scope.make();
        const service = yield* make({
          ...TEST_SEAMS,
          replayBoundaryTimeout: Duration.millis(300),
        }).pipe(Scope.provide(scope));

        const events = yield* Stream.runCollect(
          Stream.takeUntil(
            service.subscribeEvents({ runId: "run-1", afterSeq: 0 }),
            (event) => event.kind === "run-resync",
          ),
        );

        assert.deepStrictEqual(seqsOf(events), [1, 2, 3]);
        const resyncs = events.filter((event) => event.kind === "run-resync");
        assert.strictEqual(resyncs.length, 1);
        const last = resyncs[0];
        if (last?.kind !== "run-resync") throw new Error("unreachable");
        assert.strictEqual(last.afterSeq, 3);
        assert.include(last.reason, "did not reach its reported boundary");
        // Never caught up, and nothing after the resync.
        assert.isFalse(events.some((event) => event.kind === "run-synced"));
        assert.strictEqual(events[events.length - 1]?.kind, "run-resync");

        yield* awaitNoReplaySlots(service);
        const outcomes = yield* service.recentBoundaryOutcomes;
        assert.include(outcomes.join(" | "), "run-1: timeout");

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("does not let a busy run overflow a quiet one's subscriber", () =>
      Effect.gen(function* () {
        // Six thousand notifications for `run-busy` while `run-quiet` watches.
        // A feed that accepted everything and filtered on the way out would
        // spend the quiet run's whole bound on the busy one's activity and then
        // tell that client to resync over a run that never moved.
        yield* useFakeBridge("cross-run-flood");
        const { service, scope } = yield* makeService;
        yield* service.status({});

        // Deliberately unhurried, and it stays open until the quiet run's late
        // event at 400ms — well past the flood. A subscriber that could drain
        // six thousand notifications faster than they are written would prove
        // nothing about the bound.
        const quietStream = service.subscribeEvents({ runId: "run-quiet", afterSeq: 0 }).pipe(
          Stream.tap(() => Effect.sleep(Duration.millis(2))),
          Stream.takeUntil(
            (event) =>
              event.kind === "run-resync" || (event.kind === "run-event" && event.event.seq === 6),
          ),
        );

        const [quiet] = yield* Effect.all(
          [
            Stream.runCollect(quietStream),
            Effect.andThen(
              Effect.sleep(Duration.millis(50)),
              Effect.asVoid(service.attachRun({ runId: "run-busy", afterSeq: 0 })),
            ),
          ],
          { concurrency: "unbounded" },
        );

        assert.deepStrictEqual(seqsOf(quiet), [1, 2, 3, 4, 5, 6]);
        assert.isFalse(quiet.some((event) => event.kind === "run-resync"));
        assert.isTrue(quiet.some((event) => event.kind === "run-synced"));

        yield* awaitNoReplaySlots(service);
        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("returns a snapshot attach at once while the next one waits for its guard", () =>
      Effect.gen(function* () {
        // The replay is paced over more than a hundred milliseconds. A snapshot
        // caller must not wait for it — but the next attach for the same run
        // must, or Peer Loop would supersede a replay that is still running.
        yield* useFakeBridge("slow-replay");
        const { service, scope } = yield* makeService;
        yield* service.status({});

        const started = yield* Clock.currentTimeMillis;
        const first = yield* service.attachRun({ runId: "run-1", afterSeq: 0 });
        const afterFirst = yield* Clock.currentTimeMillis;
        assert.strictEqual(first.runId, "run-1");
        // Back before the replay it started could possibly have finished.
        assert.isBelow(afterFirst - started, 100);

        yield* service.attachRun({ runId: "run-1", afterSeq: 0 });
        const afterSecond = yield* Clock.currentTimeMillis;
        // The second one waited for the first replay's guard.
        assert.isAbove(afterSecond - started, 100);
        assert.strictEqual(yield* service.peakSameRunReplays, 1);

        yield* awaitNoReplaySlots(service);
        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("forwards Peer Loop's own resync and stops advancing there", () =>
      Effect.gen(function* () {
        // The fixture emits events 1..6, then a resync back to 4, then a 7 that
        // must never be delivered on this subscription.
        yield* useFakeBridge("resync");
        const { service, scope } = yield* makeService;

        const events = yield* Stream.runCollect(
          service.subscribeEvents({ runId: "run-1", afterSeq: 0 }),
        );

        const last = events[events.length - 1];
        assert.strictEqual(last?.kind, "run-resync");
        if (last?.kind !== "run-resync") throw new Error("unreachable");
        assert.strictEqual(last.afterSeq, 4);
        assert.notInclude(seqsOf(events), 7);

        // This subscriber genuinely did reach its attach boundary at 5 before
        // Peer Loop reported the hole, so the catch-up fact is legitimate — but
        // nothing may follow the resync, least of all a second one.
        const syncedAt = events.findIndex((event) => event.kind === "run-synced");
        assert.isAbove(syncedAt, 0);
        assert.isBelow(syncedAt, events.length - 1);
        assert.strictEqual(events.lastIndexOf(last), events.length - 1);

        // Reconnecting from the safe cursor picks up cleanly.
        const again = yield* Stream.runCollect(
          Stream.take(service.subscribeEvents({ runId: "run-1", afterSeq: last.afterSeq }), 3),
        );
        const resumed = seqsOf(again);
        assert.isTrue(resumed.every((seq) => seq > last.afterSeq));
        assertOrderedAndUnique(resumed);

        // The replay itself did reach its boundary — Peer Loop's hole is later,
        // and the two facts are recorded as the different things they are.
        const outcomes = yield* service.recentBoundaryOutcomes;
        assert.include(outcomes.join(" | "), "run-1: synced");

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("ends a subscription with the transport that actually happened", () =>
      Effect.gen(function* () {
        // The bridge dies after this subscriber has already reached its
        // boundary. Nothing was lost, so the closing fact is the transport
        // ending — not a resync, and not the stale `connected` the transport
        // ref was still showing.
        yield* useFakeBridge("dies-mid-stream");
        const { service, scope } = yield* makeService;

        const events = yield* Stream.runCollect(
          service.subscribeEvents({ runId: "run-1", afterSeq: 0 }),
        );

        assert.isTrue(events.some((event) => event.kind === "run-synced"));
        const last = events[events.length - 1];
        assert.strictEqual(last?.kind, "transport");
        if (last?.kind !== "transport") throw new Error("unreachable");
        assert.oneOf(last.transport.state, ["interrupted", "stopped"]);

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("resyncs a subscription whose bridge died before its boundary", () =>
      Effect.gen(function* () {
        // Same death, earlier: the replay was still running. This client did
        // not catch up, and telling it the transport ended without telling it
        // to re-attach would leave it believing it has the whole story.
        yield* useFakeBridge("dies-before-boundary");
        const { service, scope } = yield* makeService;

        const events = yield* Stream.runCollect(
          service.subscribeEvents({ runId: "run-1", afterSeq: 0 }),
        );

        assert.deepStrictEqual(seqsOf(events), [1, 2]);
        assert.isFalse(events.some((event) => event.kind === "run-synced"));
        const last = events[events.length - 1];
        assert.strictEqual(last?.kind, "run-resync");
        if (last?.kind !== "run-resync") throw new Error("unreachable");
        assert.strictEqual(last.afterSeq, 2);
        assert.include(last.reason, "stopped before this replay finished");

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("does not keep replay coordination for runs nobody is watching", () =>
      Effect.gen(function* () {
        yield* useFakeBridge("ready");
        const { service, scope } = yield* makeService;

        // A client naming arbitrary run ids must not be able to grow anything
        // that outlives the calls themselves.
        yield* Effect.forEach(
          Array.from({ length: 25 }, (_, index) => `run-${index}`),
          (runId) => Effect.asVoid(Effect.orDie(service.attachRun({ runId }))),
          { discard: true },
        );

        yield* awaitNoReplaySlots(service);
        // Every one of those attaches held its run's gate alone.
        assert.strictEqual(yield* service.peakSameRunReplays, 1);
        // The boundary record is a tail, not a log: 25 attaches, 20 kept.
        const outcomes = yield* service.recentBoundaryOutcomes;
        assert.strictEqual(outcomes.length, 20);

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("keeps the configured path out of everything a client can read", () =>
      Effect.gen(function* () {
        // A distinctive path that must not appear anywhere a client can see.
        yield* withoutBridge;
        process.env[PEER_LOOP_NODE_ENTRY_ENV] =
          "/Users/nobody/very-distinctive-directory/peer-loop/dist/cli/main.js";
        const { service, scope } = yield* makeService;

        const status = yield* service.status({});
        assert.notInclude(renderPublicError(status), "very-distinctive-directory");
        assert.notInclude(String(status.transport.detail ?? ""), "very-distinctive-directory");
        assert.strictEqual(status.executableSource, "env-node-entry");

        const error = yield* Effect.flip(Effect.asVoid(service.listRuns({})));
        assert.notInclude(renderPublicError(error), "very-distinctive-directory");

        yield* Scope.close(scope, Exit.void);
      }),
    );
  },
);
