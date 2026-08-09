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
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Schema from "effect/Schema";

import { connect } from "./Bridge.ts";
import { PEER_LOOP_BRIDGE_ARGS } from "./Command.ts";

/**
 * Everything a client could read off a typed error, flattened.
 *
 * Message plus every own field, so a leak cannot hide in a detail nobody
 * thought to assert on.
 */
const renderPublicError = (error: object): string =>
  [
    String((error as { readonly message?: unknown }).message),
    ...Object.values(error).map(String),
  ].join(" | ");

/** Read-only liveness probe. Sends no signal; only ever asked about our child. */
const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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

      const readThree = (feed: typeof first) =>
        Stream.runCollect(Stream.take(Stream.fromQueue(feed.queue), 3));

      const [a, b] = yield* Effect.all([readThree(first), readThree(second)], {
        concurrency: "unbounded",
      });

      // Both subscribers see the same notifications: fan-out, not hand-off.
      const seqOf = (item: (typeof a)[number]): number =>
        item.kind === "notification" && item.message.method === "run.event"
          ? item.message.params.event.seq
          : -1;
      assert.deepStrictEqual(a.map(seqOf), [4, 5, 6]);
      assert.deepStrictEqual(b.map(seqOf), [4, 5, 6]);

      // Neither feed lost anything, so neither has to be told to re-attach.
      assert.isFalse(yield* first.overflowed);
      assert.isFalse(yield* second.overflowed);
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

  it.effect("keeps a pre-handshake failure in its real category", () =>
    Effect.gen(function* () {
      // A child that dies without a word is a transport failure. Calling it an
      // incompatibility would send an operator to go and fix a version.
      const exited = yield* fakeCommand("exit-before-ready");
      const transportFailure = yield* Effect.flip(
        Effect.asVoid(connect(exited, { handshakeTimeout: Duration.seconds(3) })),
      );
      assert.strictEqual(transportFailure._tag, "PeerLoopTransportError");

      // Prose on stdout before the handshake is a protocol failure.
      const noisy = yield* fakeCommand("garbage-before-ready");
      const protocolFailure = yield* Effect.flip(
        Effect.asVoid(connect(noisy, { handshakeTimeout: Duration.seconds(3) })),
      );
      assert.strictEqual(protocolFailure._tag, "PeerLoopProtocolError");
    }),
  );

  it.effect("refuses a version-1 bridge that is missing a required capability", () =>
    Effect.gen(function* () {
      const command = yield* fakeCommand("missing-capability");
      const error = yield* Effect.flip(Effect.asVoid(connect(command)));

      assert.strictEqual(error._tag, "PeerLoopIncompatibleError");
      // Announcing v1 is a claim; implementing it is the requirement.
      assert.include(String((error as { readonly detail?: string }).detail), "run.recover");
    }),
  );

  it.effect("fails closed on a wrong envelope version after a good handshake", () =>
    Effect.gen(function* () {
      const command = yield* fakeCommand("wrong-envelope-version");
      const connection = yield* connect(command);

      const error = yield* Effect.flip(Effect.asVoid(connection.request("health", {})));
      assert.oneOf(error._tag, ["PeerLoopProtocolError", "PeerLoopTransportError"]);

      const reason = yield* connection.closed;
      assert.strictEqual(reason._tag, "PeerLoopProtocolError");
    }),
  );

  it.effect("fails closed when a response answers a different method", () =>
    Effect.gen(function* () {
      const command = yield* fakeCommand("method-mismatch");
      const connection = yield* connect(command);

      const error = yield* Effect.flip(Effect.asVoid(connection.request("health", {})));
      assert.strictEqual(error._tag, "PeerLoopProtocolError");

      const reason = yield* connection.closed;
      assert.strictEqual(reason._tag, "PeerLoopProtocolError");
      assert.strictEqual(yield* connection.pendingRequestCount, 0);
    }),
  );

  it.effect("bounds the enqueue, not just the wait, when the bridge stops reading", () =>
    Effect.gen(function* () {
      const command = yield* fakeCommand("deaf-stdin");
      // A short stop bound too: this fixture deliberately never reads stdin, so
      // closing it is not a signal it can act on.
      const connection = yield* connect(command, {
        requestTimeout: Duration.millis(250),
        stopTimeout: Duration.millis(150),
      });

      // Enough bytes to fill the OS pipe buffer as well as the server's own
      // bounded write queue, against a child that never reads. Without the
      // enqueue inside the bound, these would park forever with no timer.
      const bulk = "x".repeat(8_192);
      const errors = yield* Effect.all(
        Array.from({ length: 120 }, (_, index) =>
          Effect.flip(
            Effect.asVoid(
              connection.request("run.ownerMessage", { runId: `run-${index}`, text: bulk }),
            ),
          ),
        ),
        { concurrency: "unbounded" },
      );

      assert.isTrue(errors.every((error) => error._tag === "PeerLoopTimeoutError"));
      // Nothing is left registered, so a late answer has nothing to resolve.
      assert.strictEqual(yield* connection.pendingRequestCount, 0);
    }),
  );

  it.effect("marks a timed-out mutation as possibly applied and never retries it", () =>
    Effect.gen(function* () {
      const command = yield* fakeCommand("never-answers");
      const connection = yield* connect(command, {
        requestTimeout: Duration.millis(150),
        lifecycleRequestTimeout: Duration.millis(150),
      });

      const read = yield* Effect.flip(Effect.asVoid(connection.request("health", {})));
      assert.strictEqual(read._tag, "PeerLoopTimeoutError");
      assert.isFalse((read as { readonly mayHaveApplied?: boolean }).mayHaveApplied);

      const mutation = yield* Effect.flip(
        Effect.asVoid(connection.request("run.recover", { runId: "run-1", choice: "abandon" })),
      );
      assert.strictEqual(mutation._tag, "PeerLoopTimeoutError");
      assert.isTrue((mutation as { readonly mayHaveApplied?: boolean }).mayHaveApplied);
      assert.include(mutation.message, "may still have accepted");

      assert.strictEqual(yield* connection.pendingRequestCount, 0);
    }),
  );

  it.effect("forgets a cancelled request and ignores its late answer", () =>
    Effect.gen(function* () {
      const command = yield* fakeCommand("late-answer");
      const connection = yield* connect(command);

      // Interrupted while waiting: the registration must go with the caller.
      const cancelled = yield* Effect.timeoutOption(
        Effect.asVoid(connection.request("health", {})),
        Duration.millis(60),
      );
      assert.isTrue(Option.isNone(cancelled));
      assert.strictEqual(yield* connection.pendingRequestCount, 0);

      // The fixture answers at 400ms. Nothing may resurrect the caller, and the
      // connection must still be healthy afterwards.
      yield* Effect.sleep(Duration.millis(500));
      assert.strictEqual(yield* connection.pendingRequestCount, 0);
      const ended = yield* Effect.timeoutOption(connection.closed, Duration.millis(50));
      assert.isTrue(Option.isNone(ended));
    }),
  );

  it.effect("leaves no waiter behind when the transport shuts down", () =>
    Effect.gen(function* () {
      const command = yield* fakeCommand("never-answers");
      const scope = yield* Scope.make();
      const connection = yield* connect(command, {
        requestTimeout: Duration.seconds(30),
        stopTimeout: Duration.millis(200),
      }).pipe(Scope.provide(scope));

      const pending = yield* Effect.forkChild(
        Effect.exit(Effect.asVoid(connection.request("health", {}))),
      );
      yield* Effect.sleep(Duration.millis(60));
      assert.strictEqual(yield* connection.pendingRequestCount, 1);

      yield* Scope.close(scope, Exit.void);

      const settled = yield* Effect.flatten(Fiber.await(pending));
      assert.isTrue(Exit.isFailure(settled));
      assert.strictEqual(yield* connection.pendingRequestCount, 0);
    }),
  );

  it.effect("refuses a request that races the child exiting, with the real reason", () =>
    Effect.gen(function* () {
      // The window this closes is narrow and entirely invisible from outside:
      // a request checks that the transport is open, yields while building its
      // deferred, and registers into `pending` after `shutdown` has already
      // snapshotted and cleared it. Nothing then ever fails that caller. The
      // seam parks a request in exactly that window rather than hoping the
      // scheduler produces it.
      const command = yield* fakeCommand("exit-on-request");
      const arrived = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let armed = true;

      const connection = yield* connect(command, {
        // Deliberately long. If the racing request fell into the hole it would
        // sit here for thirty seconds instead of being told the child had gone,
        // which is the difference this test is about.
        requestTimeout: Duration.seconds(30),
        stopTimeout: Duration.millis(200),
        seams: {
          beforeRegisterRequest: Effect.suspend(() => {
            if (!armed) return Effect.void;
            armed = false;
            return Deferred.succeed(arrived, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
            );
          }),
        },
      });

      const racing = yield* Effect.forkChild(
        Effect.exit(Effect.asVoid(connection.request("health", {}))),
      );
      yield* Deferred.await(arrived);

      // A second request reaches the child, which exits on reading it. The
      // whole shutdown — snapshot, clear, fail, end — runs while the first
      // request is still parked before its registration.
      yield* Effect.exit(Effect.asVoid(connection.request("runs.list", {})));
      const reason = yield* connection.closed;
      assert.strictEqual(reason._tag, "PeerLoopTransportError");

      yield* Deferred.succeed(release, undefined);
      const settled = yield* Effect.flatten(Fiber.await(racing));

      assert.isTrue(Exit.isFailure(settled));
      const failure = String(Exit.isFailure(settled) ? settled.cause : "");
      // The reason the transport actually ended, not a bound running out.
      assert.include(failure, "PeerLoopTransportError");
      assert.notInclude(failure, "PeerLoopTimeoutError");
      assert.strictEqual(yield* connection.pendingRequestCount, 0);
    }),
  );

  it.effect("waits for a mid-turn bridge rather than killing it at ten seconds", () =>
    Effect.gen(function* () {
      // The fixture ignores stdin close, exactly like a bridge finishing an
      // agent turn. The default bound is minutes, so nothing may be terminated
      // anywhere near the old ten-second boundary.
      const command = yield* fakeCommand("hangs-on-stop");
      const scope = yield* Scope.make();
      const connection = yield* connect(command).pipe(Scope.provide(scope));

      const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
      yield* Effect.sleep(Duration.millis(400));

      assert.isTrue(isProcessAlive(connection.pid));
      yield* Fiber.interrupt(closing);
      // Nothing this test started is left running.
      process.kill(connection.pid, "SIGKILL");
    }),
  );

  it.effect("terminates the child it spawned once the injected stop bound elapses", () =>
    Effect.gen(function* () {
      const command = yield* fakeCommand("hangs-on-stop");
      const scope = yield* Scope.make();
      const connection = yield* connect(command, {
        stopTimeout: Duration.millis(150),
      }).pipe(Scope.provide(scope));

      yield* Scope.close(scope, Exit.void);
      yield* Effect.sleep(Duration.millis(100));

      // Only the handle this server spawned is ever touched; nothing is found
      // by name, path or pattern.
      assert.isFalse(isProcessAlive(connection.pid));
    }),
  );

  it.effect("keeps the configured path and raw output out of public errors", () =>
    Effect.gen(function* () {
      const secretPath = "/Users/nobody/secret-place/peer-loop/dist/cli/main.js";
      const missing = yield* Effect.flip(
        Effect.asVoid(
          connect(
            {
              command: process.execPath,
              args: [secretPath, ...PEER_LOOP_BRIDGE_ARGS],
              source: "env-node-entry" as const,
            },
            { handshakeTimeout: Duration.seconds(3) },
          ),
        ),
      );
      assert.notInclude(renderPublicError(missing), "secret-place");

      const noisy = yield* fakeCommand("garbage-before-ready");
      const protocolFailure = yield* Effect.flip(
        Effect.asVoid(connect(noisy, { handshakeTimeout: Duration.seconds(3) })),
      );
      // The offending line said "peer-loop: starting up, please wait".
      assert.notInclude(renderPublicError(protocolFailure), "please wait");
    }),
  );
});
