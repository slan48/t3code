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
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Duration from "effect/Duration";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";

import { make } from "./Service.ts";
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
 */
interface CountingSpawner {
  readonly layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly spawned: () => number;
  readonly release: () => void;
}

const makeCountingSpawner = (
  real: ChildProcessSpawner.ChildProcessSpawner["Service"],
  options: { readonly hold?: boolean; readonly fail?: boolean } = {},
): CountingSpawner => {
  let count = 0;
  let open = options.hold !== true;
  const waiters: Array<() => void> = [];

  const gate = Effect.callback<void>((resume) => {
    if (open) {
      resume(Effect.void);
      return;
    }
    waiters.push(() => resume(Effect.void));
  });

  return {
    spawned: () => count,
    release: () => {
      open = true;
      for (const waiter of waiters.splice(0)) waiter();
    },
    layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner)(
      ChildProcessSpawner.ChildProcessSpawner.of({
        ...real,
        spawn: (command) =>
          gate.pipe(
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
          ),
      }),
    ),
  };
};

/** Sequence numbers of the run events in a collected subscription stream. */
const seqsOf = (events: readonly PeerLoopSubscriptionEvent[]): readonly number[] =>
  events.flatMap((event) => (event.kind === "run-event" ? [event.event.seq] : []));

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

    it.effect("delivers the backlog after a subscriber's afterSeq, then live activity", () =>
      Effect.gen(function* () {
        yield* useFakeBridge("ready");
        const { service, scope } = yield* makeService;

        const events = yield* Stream.runCollect(
          service.subscribeEvents({ runId: "run-1", afterSeq: 3 }).pipe(Stream.take(4)),
        );

        // Opening transport fact first, then only what this client is missing.
        assert.strictEqual(events[0]?.kind, "transport");
        const runEvents = events.slice(1);
        assert.deepStrictEqual(
          runEvents.map((event) => (event.kind === "run-event" ? event.event.seq : -1)),
          [4, 5, 6],
        );
        // The durable backlog is flagged as such; the tail is live.
        assert.deepStrictEqual(
          runEvents.map((event) => (event.kind === "run-event" ? event.replay : null)),
          [true, true, false],
        );

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("does not re-deliver events a subscriber already has", () =>
      Effect.gen(function* () {
        yield* useFakeBridge("ready");
        const { service, scope } = yield* makeService;

        // This subscriber is already past everything the fake can produce.
        const stream = service.subscribeEvents({ runId: "run-1", afterSeq: 6 });

        const [collected] = yield* Effect.all(
          [
            // Two events would mean a duplicate arrived: only the opening
            // transport fact is legitimate here.
            Effect.timeoutOption(Stream.runCollect(Stream.take(stream, 2)), "400 millis"),
            // Meanwhile another client attaches from scratch, which makes Peer
            // Loop replay the whole backlog onto the shared feed.
            Effect.andThen(
              Effect.sleep("60 millis"),
              service.attachRun({ runId: "run-1", afterSeq: 0 }),
            ),
          ],
          { concurrency: "unbounded" },
        );

        assert.strictEqual(collected._tag, "None");

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

    it.effect("serialises overlapping attaches instead of stranding a subscriber", () =>
      Effect.gen(function* () {
        // Every replay in this scenario is paced, so two attaches genuinely
        // overlap. Peer Loop keeps one attachment per run, so an uncoordinated
        // second attach would supersede the first and leave it silent.
        yield* useFakeBridge("slow-replay");
        const { service, scope } = yield* makeService;

        const collect = (afterSeq: number, take: number) =>
          Stream.runCollect(
            Stream.take(service.subscribeEvents({ runId: "run-1", afterSeq }), take),
          );

        const [fromZero, fromThree] = yield* Effect.all(
          [
            // transport + 1..5 + 6
            collect(0, 7),
            // transport + 4,5 + 6
            Effect.andThen(Effect.sleep(Duration.millis(30)), collect(3, 4)),
          ],
          { concurrency: "unbounded" },
        );

        assert.deepStrictEqual(seqsOf(fromZero), [1, 2, 3, 4, 5, 6]);
        assert.deepStrictEqual(seqsOf(fromThree), [4, 5, 6]);
        // Each surviving stream is ordered and free of duplicates.
        for (const stream of [fromZero, fromThree]) {
          const seqs = seqsOf(stream);
          assert.deepStrictEqual(
            [...seqs].sort((a, b) => a - b),
            seqs,
          );
          assert.strictEqual(new Set(seqs).size, seqs.length);
        }

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("treats a legitimate sequence gap as data, not as loss", () =>
      Effect.gen(function* () {
        // This run's durable log has no seq 3: Peer Loop numbered an event and
        // then failed to record it. Nothing was lost in transit, so nothing may
        // be reported as lost.
        yield* useFakeBridge("sequence-gap");
        const { service, scope } = yield* makeService;

        const events = yield* Stream.runCollect(
          Stream.take(service.subscribeEvents({ runId: "run-1", afterSeq: 0 }), 6),
        );

        assert.deepStrictEqual(seqsOf(events), [1, 2, 4, 5, 6]);
        assert.isFalse(events.some((event) => event.kind === "run-resync"));

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("reports a real overflow explicitly and stops at the last safe cursor", () =>
      Effect.gen(function* () {
        // Four thousand notifications against a feed that holds a thousand:
        // this server genuinely could not retain them, which is a fact rather
        // than something to infer from a sequence number.
        yield* useFakeBridge("overflow");
        const { service, scope } = yield* makeService;

        // Consumed deliberately slowly, so the feed genuinely cannot keep up.
        // A subscriber that drains as fast as the child writes would never
        // overflow, and would prove nothing.
        const events = yield* Stream.runCollect(
          Stream.tap(service.subscribeEvents({ runId: "run-1", afterSeq: 0 }), () =>
            Effect.sleep(Duration.millis(2)),
          ),
        );

        const last = events[events.length - 1];
        assert.strictEqual(last?.kind, "run-resync");
        if (last?.kind !== "run-resync") throw new Error("unreachable");
        assert.include(last.reason, "re-subscribe");

        // Everything delivered before the resync is ordered, unique, and at or
        // below the cursor the client is told to resume from.
        const seqs = seqsOf(events);
        assert.deepStrictEqual(
          [...seqs].sort((a, b) => a - b),
          seqs,
        );
        assert.strictEqual(new Set(seqs).size, seqs.length);
        assert.strictEqual(last.afterSeq, seqs[seqs.length - 1] ?? 0);

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

        // Reconnecting from the safe cursor picks up cleanly.
        const again = yield* Stream.runCollect(
          Stream.take(service.subscribeEvents({ runId: "run-1", afterSeq: last.afterSeq }), 3),
        );
        const resumed = seqsOf(again);
        assert.isTrue(resumed.every((seq) => seq > last.afterSeq));
        assert.deepStrictEqual(
          [...resumed].sort((a, b) => a - b),
          resumed,
        );

        yield* Scope.close(scope, Exit.void);
      }),
    );

    it.effect("ends a subscription with the transport that actually happened", () =>
      Effect.gen(function* () {
        // The bridge dies mid-subscription. The closing event must say so, not
        // repeat the `connected` the transport ref was still showing.
        yield* useFakeBridge("dies-mid-stream");
        const { service, scope } = yield* makeService;

        const events = yield* Stream.runCollect(
          service.subscribeEvents({ runId: "run-1", afterSeq: 0 }),
        );

        const last = events[events.length - 1];
        assert.strictEqual(last?.kind, "transport");
        if (last?.kind !== "transport") throw new Error("unreachable");
        assert.oneOf(last.transport.state, ["interrupted", "stopped"]);

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

        assert.strictEqual(yield* service.replaySlotCount, 0);

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
