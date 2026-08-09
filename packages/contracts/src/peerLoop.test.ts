import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  PEER_LOOP_PROTOCOL_VERSION,
  PEER_LOOP_WS_METHODS,
  PeerLoopBridgeErrorBody,
  PeerLoopBridgeNotification,
  PeerLoopBridgeOutbound,
  PeerLoopBridgeResponse,
  PeerLoopCommandRefusedError,
  PeerLoopEvent,
  PeerLoopHaltReason,
  PeerLoopRecoveryChoice,
  PeerLoopReviewerDecision,
  PeerLoopRunOutcome,
  PeerLoopRunStateFile,
  PeerLoopRunSummary,
  PeerLoopStartRunInput,
  PeerLoopSubscriptionEvent,
  isPeerLoopBridgeErrorCode,
  isPeerLoopRecoverableHalt,
  isPeerLoopRunTerminal,
} from "./peerLoop.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const decodeOutbound = Schema.decodeUnknownSync(PeerLoopBridgeOutbound);
const decodeEvent = Schema.decodeUnknownSync(PeerLoopEvent);
const decodeRunState = Schema.decodeUnknownSync(PeerLoopRunStateFile);

const adapters = {
  reviewer: "codex",
  reviewerVersion: "1.2.3",
  builder: "claude-code",
  builderVersion: null,
} as const;

const runStateWire = {
  schemaVersion: 1,
  runId: "20260809T000000Z-abcd1234",
  projectPath: "/repos/demo",
  state: "paused",
  iteration: 3,
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:05:00.000Z",
  ownerPolicy: { gitPush: { requireOwner: true }, ownerNotes: [] },
  ownerPolicyText: "OWNER POLICY …",
  builderSessionId: "session-1",
  reviewerThreadId: "thread-1",
  repo: {
    head: "abc",
    branch: "main",
    worktreeDigest: "digest",
    isGitRepo: true,
    capturedAt: "2026-08-09T00:04:00.000Z",
  },
  lastBuilderTask: "Write NOTES.md. Then STOP.",
  lastBuilderReport: "Done.",
  lastBuilderFailure: null,
  lastReviewerDecision: {
    decision: "CONTINUE",
    summary: "Baseline established.",
    builderTask: "Write NOTES.md. Then STOP.",
  },
  queuedOwnerMessages: [{ id: "m1", text: "keep it local", queuedAt: "2026-08-09T00:03:00.000Z" }],
  ownerObjectiveRecordedAt: "2026-08-09T00:01:00.000Z",
  pendingOperationalNotes: ["a note this build does not model"],
  lastTurnTelemetry: { actor: "builder", iteration: 3 },
  inFlight: null,
  haltReason: { kind: "OWNER_PAUSED", message: "Paused by the owner." },
  stopRequested: false,
  adapters,
  safetyLimit: null,
  lastSequence: 42,
} as const;

describe("Peer Loop bridge protocol", () => {
  it("decodes a success response and keeps its result opaque", () => {
    const decoded = decodeOutbound({
      v: PEER_LOOP_PROTOCOL_VERSION,
      type: "response",
      id: "req-1",
      method: "health",
      ok: true,
      result: { protocolVersion: 1 },
    });
    expect(decoded.type).toBe("response");
    if (decoded.type !== "response" || decoded.ok !== true) throw new Error("unreachable");
    expect(decoded.result).toEqual({ protocolVersion: 1 });
  });

  it("decodes a refusal with its stable code and structured detail", () => {
    const decoded = Schema.decodeUnknownSync(PeerLoopBridgeResponse)({
      v: 1,
      type: "response",
      id: "req-2",
      method: "run.start",
      ok: false,
      error: {
        code: "PROJECT_HAS_UNFINISHED_RUN",
        message: "This project already has an unfinished run.",
        detail: { runId: "run-1", overrideParam: "newRun" },
      },
    });
    if (decoded.ok !== false) throw new Error("unreachable");
    expect(decoded.error.code).toBe("PROJECT_HAS_UNFINISHED_RUN");
    expect(isPeerLoopBridgeErrorCode(decoded.error.code)).toBe(true);
    expect(decoded.error.detail).toEqual({ runId: "run-1", overrideParam: "newRun" });
  });

  it("keeps an unfamiliar refusal code rather than dropping it", () => {
    const decoded = Schema.decodeUnknownSync(PeerLoopBridgeErrorBody)({
      code: "SOMETHING_NEWER",
      message: "from a future build",
    });
    expect(decoded.code).toBe("SOMETHING_NEWER");
    expect(isPeerLoopBridgeErrorCode(decoded.code)).toBe(false);
  });

  it("rejects a line that is not a protocol envelope", () => {
    expect(() => decodeOutbound({ hello: "world" })).toThrow();
    expect(() => decodeOutbound({ v: 1, type: "response", id: "x", ok: true })).toThrow();
    expect(() =>
      decodeOutbound({ v: 1, type: "notification", method: "run.unknown", params: {} }),
    ).toThrow();
  });

  it("decodes every notification the bridge documents", () => {
    const ready = Schema.decodeUnknownSync(PeerLoopBridgeNotification)({
      v: 1,
      type: "notification",
      method: "bridge.ready",
      params: {
        protocolVersion: 1,
        bridge: { name: "peer-loop", pid: 10, host: "h", node: "v24" },
        peerLoopHome: "/home/.peer-loop",
        methods: ["health"],
        notifications: ["run.event"],
        errorCodes: ["RUN_NOT_FOUND"],
        recoveryChoices: ["abandon"],
        capabilities: { liveEvents: true, crossProcessControl: false },
        liveRuns: [],
      },
    });
    expect(ready.method).toBe("bridge.ready");

    const resync = Schema.decodeUnknownSync(PeerLoopBridgeNotification)({
      v: 1,
      type: "notification",
      method: "run.resync",
      params: { runId: "run-1", afterSeq: 12, reason: "re-attach" },
    });
    expect(resync.method).toBe("run.resync");
  });
});

describe("Peer Loop additive compatibility", () => {
  it("keeps run-state fields this build does not model", () => {
    const decoded = decodeRunState(runStateWire);
    expect(decoded.state).toBe("paused");
    expect(decoded.lastSequence).toBe(42);
    // Unmodeled but preserved verbatim, so a newer bridge is never undecodable
    // and the extra data is still there for a UI that learns about it.
    expect(decoded["pendingOperationalNotes"]).toEqual(["a note this build does not model"]);
    expect(decoded["ownerPolicy"]).toEqual(runStateWire.ownerPolicy);
  });

  it("keeps event payload members this build does not interpret", () => {
    const decoded = decodeEvent({
      runId: "run-1",
      seq: 7,
      ts: "2026-08-09T00:00:00.000Z",
      type: "some_future_event",
      actor: "system",
      iteration: 2,
      payload: { kind: "some_future_kind", nested: { detail: 1 }, note: "hi" },
    });
    expect(decoded.seq).toBe(7);
    expect(decoded.type).toBe("some_future_event");
    expect(decoded.payload.kind).toBe("some_future_kind");
    expect(decoded.payload["nested"]).toEqual({ detail: 1 });
  });

  it("still rejects a malformed event envelope", () => {
    const base = {
      runId: "run-1",
      seq: 7,
      ts: "2026-08-09T00:00:00.000Z",
      type: "notice",
      actor: "system",
      iteration: 2,
      payload: { kind: "notice" },
    };
    // seq is the cursor every replay is built on: it must be a positive int.
    expect(() => decodeEvent({ ...base, seq: 0 })).toThrow();
    expect(() => decodeEvent({ ...base, seq: "7" })).toThrow();
    // An unknown actor is a defect, not something to render as a blank label.
    expect(() => decodeEvent({ ...base, actor: "nobody" })).toThrow();
    // A payload without a discriminant cannot be routed at all.
    expect(() => decodeEvent({ ...base, payload: {} })).toThrow();
  });
});

describe("Peer Loop discriminants stay strict", () => {
  it("refuses an unknown run state", () => {
    expect(() => decodeRunState({ ...runStateWire, state: "vibing" })).toThrow();
  });

  it("refuses an unknown halt kind", () => {
    expect(() =>
      Schema.decodeUnknownSync(PeerLoopHaltReason)({ kind: "GAVE_UP", message: "x" }),
    ).toThrow();
  });

  it("keeps the three reviewer decisions distinguishable", () => {
    const done = Schema.decodeUnknownSync(PeerLoopReviewerDecision)({
      decision: "DONE",
      summary: "verified",
      finalState: "clean",
    });
    expect(done.decision).toBe("DONE");
    expect(() =>
      Schema.decodeUnknownSync(PeerLoopReviewerDecision)({ decision: "MAYBE", summary: "x" }),
    ).toThrow();
  });

  it("keeps DONE distinguishable from a pause and an error outcome", () => {
    const done = Schema.decodeUnknownSync(PeerLoopRunOutcome)({
      kind: "done",
      finalState: "clean",
      summary: "all good",
    });
    expect(done.kind).toBe("done");

    const paused = Schema.decodeUnknownSync(PeerLoopRunOutcome)({
      kind: "paused",
      reason: { kind: "CAPACITY_EXHAUSTED", message: "spent" },
    });
    if (paused.kind !== "paused") throw new Error("unreachable");
    expect(paused.reason.kind).toBe("CAPACITY_EXHAUSTED");
  });

  it("accepts only the three explicit recovery choices", () => {
    expect(Schema.decodeUnknownSync(PeerLoopRecoveryChoice)("abandon")).toBe("abandon");
    expect(() => Schema.decodeUnknownSync(PeerLoopRecoveryChoice)("just_fix_it")).toThrow();
  });

  it("classifies terminal and recoverable states without inventing any", () => {
    expect(isPeerLoopRunTerminal("done")).toBe(true);
    expect(isPeerLoopRunTerminal("paused")).toBe(false);
    expect(isPeerLoopRecoverableHalt("CAPACITY_EXHAUSTED")).toBe(true);
    expect(isPeerLoopRecoverableHalt("PROCESS_ERROR")).toBe(false);
  });
});

describe("Peer Loop T3 surface", () => {
  it("decodes a run summary", () => {
    const summary = Schema.decodeUnknownSync(PeerLoopRunSummary)({
      runId: "run-1",
      projectPath: "/repos/demo",
      state: "owner_required",
      iteration: 4,
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:06:00.000Z",
      haltReason: { kind: "OWNER_REQUIRED", message: "Push or keep local?" },
      inFlight: null,
      queuedOwnerMessages: 0,
      lastSequence: 51,
      awaitingOwnerObjective: false,
      adapters,
      liveWriter: null,
      liveInThisBridge: true,
    });
    expect(summary.state).toBe("owner_required");
    expect(summary.haltReason?.kind).toBe("OWNER_REQUIRED");
  });

  it("requires a non-empty objective when one is supplied", () => {
    const decoded = Schema.decodeUnknownSync(PeerLoopStartRunInput)({
      projectPath: "/repos/demo",
      objective: "  Harden the repo.  ",
    });
    expect(decoded.objective).toBe("Harden the repo.");
    expect(() =>
      Schema.decodeUnknownSync(PeerLoopStartRunInput)({
        projectPath: "/repos/demo",
        objective: " ",
      }),
    ).toThrow();
    expect(() => Schema.decodeUnknownSync(PeerLoopStartRunInput)({ projectPath: "" })).toThrow();
  });

  it("does not accept a Builder permission mode from a remote client", () => {
    const decoded = Schema.decodeUnknownSync(PeerLoopStartRunInput)({
      projectPath: "/repos/demo",
      permissionMode: "bypassPermissions",
    });
    expect(decoded).not.toHaveProperty("permissionMode");
  });

  it("models every subscription event a client has to render", () => {
    const kinds = [
      {
        kind: "transport",
        transport: { state: "connected", changedAt: "t", detail: null, protocolVersion: 1 },
      },
      {
        kind: "run-event",
        runId: "run-1",
        replay: true,
        event: {
          runId: "run-1",
          seq: 1,
          ts: "t",
          type: "run_started",
          actor: "system",
          iteration: 0,
          payload: { kind: "run_started" },
        },
      },
      {
        kind: "run-outcome",
        runId: "run-1",
        outcome: { kind: "paused", reason: { kind: "OWNER_PAUSED", message: "x" } },
        state: null,
      },
      {
        kind: "run-finished",
        runId: "run-1",
        outcome: { kind: "done", finalState: "clean", summary: "s" },
        state: null,
        reason: "terminal",
      },
      { kind: "run-resync", runId: "run-1", afterSeq: 3, reason: "re-attach" },
    ];
    for (const wire of kinds) {
      expect(Schema.decodeUnknownSync(PeerLoopSubscriptionEvent)(wire).kind).toBe(wire.kind);
    }
  });

  it("carries a refusal code through the typed T3 error", () => {
    const error = new PeerLoopCommandRefusedError({
      code: "CONTROL_UNAVAILABLE",
      detail: "another Peer Loop process holds this project",
      data: { reason: "held_by_other_process" },
    });
    expect(error.code).toBe("CONTROL_UNAVAILABLE");
    expect(error.message).toContain("CONTROL_UNAVAILABLE");
  });

  it("registers every Peer Loop method on the websocket group", () => {
    for (const method of Object.values(PEER_LOOP_WS_METHODS)) {
      expect(WsRpcGroup.requests.has(method)).toBe(true);
    }
    expect(WS_METHODS.peerLoopStatus).toBe(PEER_LOOP_WS_METHODS.status);
  });
});
