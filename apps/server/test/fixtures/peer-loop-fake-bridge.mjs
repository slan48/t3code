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

const scenario = process.env["T3_PEER_LOOP_FAKE_SCENARIO"] ?? "ready";

/** The last two argv entries must be the bridge subcommand, exactly. */
const invokedArgs = process.argv.slice(2);

const write = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const health = {
  protocolVersion: scenario === "bad-version" ? 99 : 1,
  bridge: { name: "peer-loop", pid: process.pid, host: "fake-host", node: process.version },
  peerLoopHome: "/fake/.peer-loop",
  methods: [
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

/** Replay every seq after `afterSeq` up to 5, then one live event at 6. */
const emitBacklogAndLive = (runId, afterSeq) => {
  for (let seq = afterSeq + 1; seq <= 5; seq += 1) write(runEvent(runId, seq, true));
  setTimeout(() => write(runEvent(runId, 6, false)), 5);
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
        eventHighWaterMark: 5,
        replayFromSeq: afterSeq,
        live: true,
      });
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
        eventHighWaterMark: 5,
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
        eventHighWaterMark: 5,
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

if (scenario === "silent") {
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

const lines = NodeReadline.createInterface({ input: process.stdin });
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

  handle(request);
});

// stdin ending is how the server asks the bridge to stop.
lines.on("close", () => {
  process.exit(0);
});
