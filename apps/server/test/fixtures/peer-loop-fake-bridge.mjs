/**
 * A deterministic stand-in for `peer-loop bridge --stdio`.
 *
 * Plain JavaScript on purpose: the machine-local Node-entry override only
 * accepts a `.js`/`.mjs`/`.cjs` entry, and these tests exercise that real
 * resolution rather than a relaxed test-only variant of it.
 *
 * It speaks the real wire protocol — one JSON object per line, `bridge.ready`
 * first, responses correlated by id — so the server's transport is exercised
 * against a subprocess rather than a mock. It runs no agent, spawns nothing,
 * and reads no credentials.
 *
 * The scenario is chosen with `T3_PEER_LOOP_FAKE_SCENARIO`, so each test gets
 * exactly the bridge behaviour it is about.
 */
import * as NodeReadline from "node:readline";
import * as NodeStream from "node:stream";

const scenario = process.env["T3_PEER_LOOP_FAKE_SCENARIO"] ?? "ready";

/** The last two argv entries must be the bridge subcommand, exactly. */
const invokedArgs = process.argv.slice(2);

const write = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

/** Scenarios that withhold a required v1 capability. */
const missingCapability = scenario === "missing-capability";

const health = {
  protocolVersion: scenario === "bad-version" ? 99 : 1,
  bridge: { name: "peer-loop", pid: process.pid, host: "fake-host", node: process.version },
  peerLoopHome: "/fake/.peer-loop",
  methods: missingCapability
    ? [
        "health",
        "runs.list",
        "run.attach",
        "run.start",
        "run.resume",
        "run.ownerMessage",
        "run.pause",
      ]
    : [
        "health",
        "runs.list",
        "run.attach",
        "run.start",
        "run.resume",
        "run.ownerMessage",
        "run.pause",
        "run.recover",
      ],
  notifications: ["bridge.ready", "run.event", "run.outcome", "run.finished", "run.resync"],
  errorCodes: ["CONTROL_UNAVAILABLE", "RUN_NOT_FOUND"],
  recoveryChoices: ["resume_to_reviewer", "replay_builder_task", "abandon"],
  capabilities: {
    liveEvents: true,
    backlogReplay: true,
    ownerMessages: true,
    pause: true,
    recovery: true,
    start: true,
    resume: true,
    crossProcessControl: false,
  },
  liveRuns: [],
  // Only the fake sets this: tests assert the exact argv reached the child.
  invokedArgs,
};

const adapters = {
  reviewer: "codex",
  reviewerVersion: "1.0.0",
  builder: "claude-code",
  builderVersion: "2.0.0",
};

const runState = (runId, extra = {}) => ({
  schemaVersion: 1,
  runId,
  projectPath: "/repos/demo",
  state: "paused",
  iteration: 2,
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:05:00.000Z",
  ownerPolicy: { ownerNotes: [] },
  ownerPolicyText: "OWNER POLICY",
  builderSessionId: "session-1",
  reviewerThreadId: "thread-1",
  repo: null,
  lastBuilderTask: "Write NOTES.md. Then STOP.",
  lastBuilderReport: "Done.",
  lastBuilderFailure: null,
  lastReviewerDecision: null,
  queuedOwnerMessages: [],
  ownerObjectiveRecordedAt: "2026-08-09T00:01:00.000Z",
  inFlight: null,
  haltReason: { kind: "OWNER_PAUSED", message: "Paused by the owner." },
  stopRequested: false,
  adapters,
  safetyLimit: null,
  lastSequence: 5,
  ...extra,
});

const control = {
  available: true,
  reason: "live_in_this_bridge",
  liveWriter: null,
  resumable: false,
};

const runEvent = (runId, seq, replay) => ({
  v: 1,
  type: "notification",
  method: "run.event",
  params: {
    runId,
    replay,
    event: {
      runId,
      seq,
      ts: `2026-08-09T00:00:0${seq % 10}.000Z`,
      type: seq === 1 ? "run_started" : "notice",
      actor: "system",
      iteration: 1,
      payload: { kind: seq === 1 ? "run_started" : "notice", message: `event ${seq}` },
    },
  },
});

/**
 * The sequences this run's durable log actually holds.
 *
 * `sequence-gap` leaves 3 out on purpose: Peer Loop numbers an event before it
 * records it, so a number can be spent and never appear. A consumer that treats
 * the hole as lost data would be wrong about a perfectly healthy run.
 */
const LOG_SEQUENCES = scenario === "sequence-gap" ? [1, 2, 4, 5] : [1, 2, 3, 4, 5];

/** More events than one subscriber's feed can hold, by a clear margin. */
const BIG_BACKLOG = 2_500;
const FLOOD_FIRST_SEQ = 100;
const FLOOD_COUNT = 6_000;

/**
 * The boundary each scenario reports on `run.attach`.
 *
 * Scenario-specific because it is the thing the server coordinates on: a flood
 * that ends at 6099 has to say so, or a subscriber would be declared caught up
 * on its very first event and the overflow that follows would look like a
 * success followed by a mystery.
 */
const HIGH_WATER_MARK = (() => {
  switch (scenario) {
    case "overflow":
      return FLOOD_FIRST_SEQ + FLOOD_COUNT - 1;
    case "big-backlog":
      return BIG_BACKLOG;
    // Reports a boundary its replay never reaches: the server must give up on a
    // bound rather than hold this run's attachment for ever.
    case "never-reaches-boundary":
      return 9;
    default:
      return LOG_SEQUENCES[LOG_SEQUENCES.length - 1];
  }
})();

/**
 * Replay everything after `afterSeq`, then one live event at 6.
 *
 * `slow-replay` paces the backlog and emits NO live event. The pacing is what
 * makes two attaches genuinely overlap; a live event during that window would
 * be a fixture artefact rather than anything a real bridge does — Peer Loop
 * writes a replay to stdout in one go, so nothing interleaves with it.
 */
const emitBacklogAndLive = (runId, afterSeq) => {
  const backlog = LOG_SEQUENCES.filter((seq) => seq > afterSeq);
  const step = scenario === "slow-replay" ? 25 : 0;

  backlog.forEach((seq, index) => {
    if (step === 0) write(runEvent(runId, seq, true));
    else setTimeout(() => write(runEvent(runId, seq, true)), step * (index + 1));
  });

  if (step !== 0) return;

  const liveAt = 5;
  setTimeout(() => {
    write(runEvent(runId, 6, false));
    if (scenario === "resync") {
      write({
        v: 1,
        type: "notification",
        method: "run.resync",
        params: { runId, afterSeq: 4, reason: "the bridge could not keep this stream gapless" },
      });
      setTimeout(() => write(runEvent(runId, 7, false)), 5);
    }
  }, liveAt);
};

/** Floods one run with more notifications than a subscriber's feed can hold. */
const flood = (runId, count) => {
  for (let index = 0; index < count; index += 1) {
    write(runEvent(runId, FLOOD_FIRST_SEQ + index, false));
  }
};

const respond = (id, method, result) => {
  write({ v: 1, type: "response", id, method, ok: true, result });
};

const refuse = (id, method, code, message, detail) => {
  write({
    v: 1,
    type: "response",
    id,
    method,
    ok: false,
    error: { code, message, ...(detail === undefined ? {} : { detail }) },
  });
};

const handle = (request) => {
  const { id, method, params } = request;
  const runId = typeof params["runId"] === "string" ? params["runId"] : "run-1";

  switch (method) {
    case "health":
      return respond(id, method, health);
    case "runs.list":
      return respond(id, method, {
        peerLoopHome: "/fake/.peer-loop",
        runs: [
          {
            runId: "run-1",
            projectPath: params["projectPath"] ?? "/repos/demo",
            state: "paused",
            iteration: 2,
            createdAt: "2026-08-09T00:00:00.000Z",
            updatedAt: "2026-08-09T00:05:00.000Z",
            haltReason: { kind: "OWNER_PAUSED", message: "Paused by the owner." },
            inFlight: null,
            queuedOwnerMessages: 0,
            lastSequence: 5,
            awaitingOwnerObjective: false,
            adapters,
            liveWriter: null,
            liveInThisBridge: false,
          },
        ],
        unreadable: ["run-broken"],
      });
    case "run.attach": {
      const afterSeq = typeof params["afterSeq"] === "number" ? params["afterSeq"] : 0;
      respond(id, method, {
        runId,
        state: runState(runId),
        control,
        eventHighWaterMark: HIGH_WATER_MARK,
        replayFromSeq: afterSeq,
        live: true,
      });
      if (scenario === "overflow") {
        setTimeout(() => flood(runId, FLOOD_COUNT), 5);
        return;
      }
      if (scenario === "big-backlog") {
        // More than the server's per-subscriber bound, written at once. A
        // subscription that only starts consuming after the replay is over
        // cannot possibly keep this.
        for (let seq = afterSeq + 1; seq <= BIG_BACKLOG; seq += 1) {
          write(runEvent(runId, seq, true));
        }
        return;
      }
      if (scenario === "never-reaches-boundary") {
        // Announces a boundary at 9 and stops at 3. The replay is real; it just
        // never arrives, which is what the bound exists for.
        for (const seq of [1, 2, 3]) write(runEvent(runId, seq, true));
        return;
      }
      if (scenario === "cross-run-flood") {
        // One busy run and one quiet one on the same bridge. The quiet run's
        // subscriber stays open long past the flood, so a feed that accepted
        // everything and filtered later would be full of the busy run's
        // activity by the time the quiet run moved again.
        if (runId === "run-busy") {
          setTimeout(() => flood(runId, FLOOD_COUNT), 5);
        } else {
          for (const seq of LOG_SEQUENCES.filter((value) => value > afterSeq)) {
            write(runEvent(runId, seq, true));
          }
          setTimeout(() => write(runEvent(runId, 6, false)), 400);
        }
        return;
      }
      if (scenario === "dies-mid-stream") {
        write(runEvent(runId, 1, true));
        write(runEvent(runId, 5, true));
        setTimeout(() => process.exit(9), 40);
        return;
      }
      if (scenario === "dies-before-boundary") {
        // Exits partway through a replay: the boundary is never reached and the
        // subscriber has to be told, not left looking caught up.
        write(runEvent(runId, 1, true));
        write(runEvent(runId, 2, true));
        setTimeout(() => process.exit(9), 40);
        return;
      }
      emitBacklogAndLive(runId, afterSeq);
      return;
    }
    case "run.start": {
      const projectPath = String(params["projectPath"] ?? "");
      if (projectPath.includes("busy")) {
        return refuse(
          id,
          method,
          "CONTROL_UNAVAILABLE",
          "Another Peer Loop process is already driving this project.",
          { reason: "held_by_other_process" },
        );
      }
      if (projectPath.includes("unfinished")) {
        return refuse(
          id,
          method,
          "PROJECT_HAS_UNFINISHED_RUN",
          "This project already has an unfinished run.",
          { runId: "run-1", overrideParam: "newRun" },
        );
      }
      respond(id, method, {
        runId: "run-new",
        projectPath,
        state: runState("run-new"),
        control,
        eventHighWaterMark: HIGH_WATER_MARK,
        replayFromSeq: 0,
        live: true,
        awaitingOwnerObjective: params["objective"] === undefined,
      });
      emitBacklogAndLive("run-new", 0);
      return;
    }
    case "run.resume":
      return respond(id, method, {
        runId,
        projectPath: "/repos/demo",
        state: runState(runId, { state: "interrupted" }),
        control,
        eventHighWaterMark: HIGH_WATER_MARK,
        replayFromSeq: 0,
        live: true,
        interrupted: true,
        awaitingOwnerObjective: false,
      });
    case "run.ownerMessage":
      return respond(id, method, {
        runId,
        queued: true,
        accepted: true,
        queuedOwnerMessages: 1,
      });
    case "run.pause":
      return respond(id, method, { runId, applied: "live" });
    case "run.recover": {
      const choice = params["choice"];
      if (
        choice !== "resume_to_reviewer" &&
        choice !== "replay_builder_task" &&
        choice !== "abandon"
      ) {
        return refuse(id, method, "INVALID_PARAMS", "unknown recovery choice");
      }
      return respond(id, method, { runId, choice, state: runState(runId, { state: "idle" }) });
    }
    default:
      return refuse(id, method, "UNKNOWN_METHOD", `unknown method ${method}`);
  }
};

/* -------------------------------------------------------------- scenarios */

if (scenario === "exit-before-ready") {
  // Dies without a word. A transport failure, not a protocol or version one.
  process.exit(7);
}

if (scenario === "garbage-before-ready") {
  // Writes prose where protocol belongs, and never announces itself.
  process.stdout.write("peer-loop: starting up, please wait\n");
  setInterval(() => undefined, 1_000);
} else if (scenario === "silent") {
  // Announces nothing. Exercises the handshake timeout.
  setInterval(() => undefined, 1_000);
} else {
  write({ v: 1, type: "notification", method: "bridge.ready", params: health });
}

if (scenario === "garbage") {
  process.stdout.write("this is not protocol\n");
}

if (scenario === "noisy-stderr") {
  for (let index = 0; index < 200; index += 1) {
    process.stderr.write(`[peer-loop bridge] diagnostic ${index} ${"x".repeat(1_000)}\n`);
  }
}

const pendingOutOfOrder = [];

// `deaf-stdin` never reads: the server's bounded write queue and the OS pipe
// buffer both fill, so the enqueue itself is what has to be bounded.
if (scenario === "deaf-stdin") {
  process.stdin.pause();
  setInterval(() => undefined, 1_000);
}

const lines = NodeReadline.createInterface({
  input: scenario === "deaf-stdin" ? new NodeStream.PassThrough() : process.stdin,
});
lines.on("line", (line) => {
  if (line.trim().length === 0) return;
  const request = JSON.parse(line);

  if (scenario === "exit-on-request") {
    process.exit(3);
  }

  if (scenario === "out-of-order") {
    // Hold the first request and answer the second one first, so the server's
    // correlation is proven rather than assumed from arrival order.
    pendingOutOfOrder.push(request);
    if (pendingOutOfOrder.length === 2) {
      handle(pendingOutOfOrder[1]);
      setTimeout(() => handle(pendingOutOfOrder[0]), 5);
    }
    return;
  }

  if (scenario === "bad-result") {
    write({ v: 1, type: "response", id: request.id, method: request.method, ok: true, result: {} });
    return;
  }

  if (scenario === "wrong-envelope-version") {
    write({ v: 2, type: "response", id: request.id, method: request.method, ok: true, result: {} });
    return;
  }

  if (scenario === "method-mismatch") {
    write({ v: 1, type: "response", id: request.id, method: "run.pause", ok: true, result: {} });
    return;
  }

  if (scenario === "never-answers") {
    // Reads the request and says nothing at all, ever.
    return;
  }

  if (scenario === "late-answer") {
    // Answers long after any caller could still be waiting.
    setTimeout(() => handle(request), 400);
    return;
  }

  handle(request);
});

// stdin ending is how the server asks the bridge to stop.
lines.on("close", () => {
  // `hangs-on-stop` models a bridge mid-turn: it has been asked to stop and is
  // finishing an agent turn first, which is exactly what the stop bound is for.
  if (scenario === "hangs-on-stop") return;
  process.exit(0);
});

if (scenario === "hangs-on-stop") {
  setInterval(() => undefined, 1_000);
}
