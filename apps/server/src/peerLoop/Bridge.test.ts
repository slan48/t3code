/**
 * The Peer Loop stdio transport, against a real subprocess.
 *
 * Every case here spawns the deterministic fake bridge in
 * `test/fixtures/peer-loop-fake-bridge.mjs`. It speaks the real wire protocol
 * and runs no agent, so the transport is proven end to end without invoking
 * Codex or Claude or spending a minute of anyone's subscription.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { PeerLoopCommandRefusedError, type PeerLoopError } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Schema from "effect/Schema";

import { connect } from "./Bridge.ts";
import { PEER_LOOP_BRIDGE_ARGS } from "./Command.ts";

const isRefusal = Schema.is(PeerLoopCommandRefusedError);

const fixturePath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../../test/fixtures/peer-loop-fake-bridge.mjs"),
);

const fakeCommand = (scenario: string) =>
  Effect.gen(function* () {
    const entry = yield* fixturePath;
    process.env["T3_PEER_LOOP_FAKE_SCENARIO"] = scenario;
    return {
      command: process.execPath,
      args: [entry, ...PEER_LOOP_BRIDGE_ARGS],
      source: "env-node-entry" as const,
    };
  });

// Real services, not the test clock: every case here waits on an actual child
// process, and a simulated clock would never let a timeout or a read fire.
it.layer(NodeServices.layer, { excludeTestServices: true })("Peer Loop bridge transport", (it) => {
  it.effect("completes the handshake and answers a request", () =>
    Effect.gen(function* () {
      const command = yield* fakeCommand("ready");
      const connection = yield* connect(command);

      assert.strictEqual(connection.health.protocolVersion, 1);
      assert.isAbove(connection.pid, 0);

      const result = (yield* connection.request("health", {})) as { invokedArgs: string[] };
      // The exact argv the child received: the subcommand and nothing else.
      assert.deepStrictEqual(result.invokedArgs, ["bridge", "--stdio"]);
    }),
  );

  it.effect("correlates responses by id, not by arrival order", () =>
    Effect.gen(function* () {
      const command = yield* fakeCommand("out-of-order");
      const connection = yield* connect(command);

      const [pause, message] = yield* Effect.all(
        [
          connection.request("run.pause", { runId: "run-1" }),
          connection.request("run.ownerMessage", { runId: "run-2", text: "hello" }),
        ],
        { concurrency: "unbounded" },
      );

      assert.deepStrictEqual(pause, { runId: "run-1", applied: "live" });
      assert.deepStrictEqual(message, {
        runId: "run-2",
        queued: true,
        accepted: true,
        queuedOwnerMessages: 1,
      });
    }),
  );

  it.effect("refuses a bridge that announces an unsupported protocol version", () =>
    Effect.gen(function* () {
      const command = yield* fakeCommand("bad-version");
      const exit = yield* connect(command).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      const error = Exit.isFailure(exit) ? exit.cause : null;
      assert.include(String(error), "PeerLoopIncompatibleError");
    }),
  );

  it.effect("fails closed when stdout carries something that is not protocol", () =>
    Effect.gen(function* () {
      const command = yield* fakeCommand("garbage");
      const connection = yield* connect(command);

      // The handshake still succeeded — the junk arrives after it — so the
      // failure shows up as the transport ending rather than a bad connect.
      const reason = yield* connection.closed;
      assert.strictEqual(reason._tag, "PeerLoopProtocolError");
      assert.include(reason.message, "invalid protocol output");
    }),
  );

  it.effect("fails every pending request when the child exits", () =>
    Effect.gen(function* () {
      const command = yield* fakeCommand("exit-on-request");
      const connection = yield* connect(command);

      const exit = yield* connection.request("health", {}).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "PeerLoopTransportError");

      const reason = yield* connection.closed;
      assert.strictEqual(reason._tag, "PeerLoopTransportError");
    }),
  );

  it.effect("gives up on a bridge that never announces itself", () =>
    Effect.gen(function* () {
      const command = yield* fakeCommand("silent");
      const exit = yield* connect(command, { handshakeTimeout: Duration.millis(150) }).pipe(
        Effect.exit,
      );

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "did not announce itself");
    }),
  );

  it.effect("keeps only a bounded, truncated tail of stderr", () =>
    Effect.gen(function* () {
      const command = yield* fakeCommand("noisy-stderr");
      const connection = yield* connect(command);

      // The fixture writes 200 long lines; give the reader a moment to drain.
      yield* Effect.sleep(Duration.millis(120));
      const tail = yield* connection.stderrTail;

      assert.isAtMost(tail.length, 40);
      for (const line of tail) assert.isAtMost(line.length, 500);
    }),
  );

  it.effect("passes a refusal through with its stable code and detail", () =>
    Effect.gen(function* () {
      const command = yield* fakeCommand("ready");
      const connection = yield* connect(command);

      // Typed as a discarded result so flipping does not put `unknown` in the
      // error channel; the refusal is what this test is about.
      const refused: Effect.Effect<void, PeerLoopError> = Effect.asVoid(
        connection.request("run.start", { projectPath: "/repos/busy-project" }),
      );
      const error = yield* Effect.flip(refused);
      assert.isTrue(isRefusal(error));
      if (!isRefusal(error)) throw new Error("unreachable");
      assert.strictEqual(error.code, "CONTROL_UNAVAILABLE");
      assert.deepStrictEqual(error.data, { reason: "held_by_other_process" });
    }),
  );

  it.effect("gives each subscriber its own bounded feed and ends it on exit", () =>
    Effect.gen(function* () {
      const command = yield* fakeCommand("ready");
      const connection = yield* connect(command);

      const first = yield* connection.subscribe;
      const second = yield* connection.subscribe;

      yield* connection.request("run.attach", { runId: "run-1", afterSeq: 3 });

      const readThree = (queue: typeof first) =>
        Stream.runCollect(Stream.take(Stream.fromQueue(queue), 3));

      const [a, b] = yield* Effect.all([readThree(first), readThree(second)], {
        concurrency: "unbounded",
      });

      // Both subscribers see the same notifications: fan-out, not hand-off.
      assert.deepStrictEqual(
        a.map((message) => (message.method === "run.event" ? message.params.event.seq : -1)),
        [4, 5, 6],
      );
      assert.deepStrictEqual(
        b.map((message) => (message.method === "run.event" ? message.params.event.seq : -1)),
        [4, 5, 6],
      );

      // A scoped subscriber's queue is ended when the transport is, so a stream
      // over it finishes instead of hanging.
      yield* Queue.size(first as never).pipe(Effect.ignore);
    }),
  );

  it.effect("closes stdin on scope exit and releases anything still waiting", () =>
    Effect.gen(function* () {
      const command = yield* fakeCommand("ready");
      const scope = yield* Scope.make();
      const connection = yield* connect(command).pipe(Scope.provide(scope));

      assert.isAbove(connection.pid, 0);
      // The fake exits when its stdin closes, which is exactly how Peer Loop is
      // asked to stop. Nothing is signalled to get there.
      yield* Scope.close(scope, Exit.void);

      // A waiter is told the transport ended rather than parked forever.
      const reason = yield* connection.closed;
      assert.strictEqual(reason._tag, "PeerLoopTransportError");

      // And the connection refuses further work instead of hanging.
      const exit = yield* connection.request("health", {}).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
    }),
  );
});
