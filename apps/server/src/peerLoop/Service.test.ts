/**
 * The Peer Loop service: laziness, fan-out, and refusals that stay legible.
 *
 * Everything runs against the deterministic fake bridge, selected through the
 * same machine-local executable configuration a real install uses. No agent is
 * invoked and nothing is billed.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

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

/** A service instance in its own scope, so each test owns its bridge. */
const makeService = Effect.gen(function* () {
  const scope = yield* Scope.make();
  const service = yield* make().pipe(Scope.provide(scope));
  return { service, scope } as const;
});

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

    it.effect("shares one bridge across concurrent first calls", () =>
      Effect.gen(function* () {
        yield* useFakeBridge("ready");
        const { service, scope } = yield* makeService;

        // Two bridges would be two writers contending for the same leases, so
        // a burst of cold calls must produce exactly one.
        const [a, b, c] = yield* Effect.all(
          [service.status({}), service.listRuns({}), service.status({})],
          { concurrency: "unbounded" },
        );

        assert.strictEqual(a.health?.bridge.pid, c.health?.bridge.pid);
        assert.strictEqual(b.runs.length, 1);

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
  },
);
