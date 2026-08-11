/**
 * Peer Loop - a controllable Reviewer/Builder loop that T3Code drives from the
 * outside.
 *
 * Peer Loop is a separate tool. It owns the policy, the lifecycle, the durable
 * state, the runtime ownership of a project, and every recovery decision.
 * T3Code is a structured control and observation surface over it: it forwards
 * owner intent and renders what Peer Loop reports, and it decides nothing.
 *
 * The whole integration speaks one language — `peer-loop bridge --stdio`, one
 * JSON object per line. Everything in the first half of this module is a
 * transcription of *its* protocol version 1, decoded as untrusted input. T3Code
 * never reads Peer Loop's state directory, never parses its terminal output,
 * and never reimplements its state machine. If a fact is not in a response or a
 * notification, T3Code does not have it.
 *
 * Two rules shape the schemas here, and they pull in opposite directions:
 *
 *   - **Discriminants and safety-critical fields are strict.** A run state, a
 *     halt kind, a reviewer decision or a recovery choice this build has never
 *     heard of fails validation loudly rather than rendering as a blank badge
 *     or, worse, as the wrong one.
 *   - **Everything else is additive-tolerant.** A newer Peer Loop that adds a
 *     field or an event payload member must not become undecodable. Those
 *     structs keep unmodeled keys verbatim as structured unknown data
 *     (`Schema.StructWithRest`), so the information survives the boundary even
 *     when this build has no idea what it means.
 *
 * @module PeerLoop
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/* ------------------------------------------------------- protocol version */

/**
 * The bridge protocol this build speaks.
 *
 * Peer Loop bumps this only for a breaking change to an envelope or to an
 * existing method's shape; adding a method or an optional field is additive.
 * A bridge announcing anything else is refused at the handshake rather than
 * interpreted optimistically — guessing at the shape of `run.recover` would be
 * guessing about an irreversible choice.
 */
export const PEER_LOOP_PROTOCOL_VERSION = 1;

/**
 * The envelope version, as a value every message must literally carry.
 *
 * A positive integer would have accepted a v2 envelope and then interpreted it
 * with v1 rules, which is the one thing a version field exists to prevent.
 * `bridge.ready.params.protocolVersion` is deliberately NOT this: a bridge that
 * still frames v1 envelopes but announces a newer protocol must be decodable so
 * it can be classified as incompatible rather than as garbage.
 */
export const PeerLoopEnvelopeVersion = Schema.Literal(PEER_LOOP_PROTOCOL_VERSION);

/** The `state.json` schema this build understands. Not any positive integer. */
export const PEER_LOOP_RUN_STATE_SCHEMA_VERSION = 1;

/**
 * Unmodeled keys, kept verbatim.
 *
 * Applied to the structs Peer Loop is expected to grow. The modeled fields are
 * still validated; anything else rides along as `unknown` so a newer bridge
 * stays decodable and its extra data stays available to a UI that learns about
 * it later.
 */
const additiveRest = [Schema.Record(Schema.String, Schema.Unknown)] as const;

/* ------------------------------------------------------------ run domain */

/** Peer Loop's run states, verbatim. Strict: an unknown state is a defect. */
export const PEER_LOOP_RUN_STATES = [
  "idle",
  "reviewer_working",
  "builder_working",
  "owner_required",
  "paused",
  "interrupted",
  "done",
  "error",
] as const;

export const PeerLoopRunState = Schema.Literals(PEER_LOOP_RUN_STATES);
export type PeerLoopRunState = typeof PeerLoopRunState.Type;

/** States Peer Loop will not move out of on its own. */
export const PEER_LOOP_TERMINAL_RUN_STATES = [
  "done",
  "error",
] as const satisfies readonly PeerLoopRunState[];

export function isPeerLoopRunTerminal(state: PeerLoopRunState): boolean {
  return (PEER_LOOP_TERMINAL_RUN_STATES as readonly PeerLoopRunState[]).includes(state);
}

/**
 * Why a run stopped.
 *
 * Strict, and deliberately so: the whole point of the integration is that
 * `CAPACITY_EXHAUSTED`, `AUTH_REQUIRED`, `TRANSPORT_INTERRUPTED` and
 * `OWNER_REQUIRED` stay distinguishable all the way to the operator instead of
 * collapsing into "it stopped".
 */
export const PEER_LOOP_HALT_KINDS = [
  "OWNER_REQUIRED",
  "OWNER_PAUSED",
  "SYSTEM_BLOCKED",
  "SAFETY_LIMIT",
  "CAPABILITY_MISMATCH",
  "PROTOCOL_ERROR",
  "PROCESS_ERROR",
  "CAPACITY_EXHAUSTED",
  "AUTH_REQUIRED",
  "TRANSPORT_INTERRUPTED",
  "OWNER_OBJECTIVE_REQUIRED",
  "AMBIGUOUS_INTERRUPTED_TURN",
] as const;

export const PeerLoopHaltKind = Schema.Literals(PEER_LOOP_HALT_KINDS);
export type PeerLoopHaltKind = typeof PeerLoopHaltKind.Type;

/**
 * Halts the owner can clear without Peer Loop having failed.
 *
 * Presentation help only. Whether a run may actually continue is Peer Loop's
 * judgement, expressed by accepting or refusing a command.
 */
export const PEER_LOOP_RECOVERABLE_HALT_KINDS = [
  "OWNER_REQUIRED",
  "OWNER_PAUSED",
  "OWNER_OBJECTIVE_REQUIRED",
  "CAPACITY_EXHAUSTED",
  "AUTH_REQUIRED",
  "TRANSPORT_INTERRUPTED",
  "AMBIGUOUS_INTERRUPTED_TURN",
] as const satisfies readonly PeerLoopHaltKind[];

export function isPeerLoopRecoverableHalt(kind: PeerLoopHaltKind): boolean {
  return (PEER_LOOP_RECOVERABLE_HALT_KINDS as readonly PeerLoopHaltKind[]).includes(kind);
}

export const PeerLoopHaltReason = Schema.StructWithRest(
  Schema.Struct({
    kind: PeerLoopHaltKind,
    message: Schema.String,
    detail: Schema.optional(Schema.String),
  }),
  additiveRest,
);
export type PeerLoopHaltReason = typeof PeerLoopHaltReason.Type;

/**
 * A Builder transport failure Peer Loop recognised as recoverable.
 *
 * `resetAt` is null unless Claude actually stated one. T3Code never invents a
 * reset time, and must never present the absence of one as "no limit".
 */
export const PeerLoopBuilderFailure = Schema.StructWithRest(
  Schema.Struct({
    kind: Schema.Literals(["CAPACITY_EXHAUSTED", "AUTH_REQUIRED", "TRANSPORT_INTERRUPTED"]),
    source: Schema.Literals(["result", "assistant", "stderr", "transport"]),
    /** Bounded excerpt of what the CLI said, produced by Peer Loop. */
    evidence: Schema.String,
    resetAt: Schema.NullOr(IsoDateTime),
  }),
  additiveRest,
);
export type PeerLoopBuilderFailure = typeof PeerLoopBuilderFailure.Type;

/**
 * The one structured decision a Reviewer turn produces.
 *
 * A discriminated union on `decision`, because the three branches mean
 * completely different things to an operator and flattening them would lose
 * exactly the distinction the loop exists to make.
 */
export const PeerLoopReviewerDecision = Schema.Union([
  Schema.StructWithRest(
    Schema.Struct({
      decision: Schema.Literal("CONTINUE"),
      summary: Schema.String,
      builderTask: Schema.String,
    }),
    additiveRest,
  ),
  Schema.StructWithRest(
    Schema.Struct({
      decision: Schema.Literal("OWNER_REQUIRED"),
      summary: Schema.String,
      ownerQuestion: Schema.String,
      whyOwnerIsRequired: Schema.String,
      options: Schema.Array(Schema.String),
    }),
    additiveRest,
  ),
  Schema.StructWithRest(
    Schema.Struct({
      decision: Schema.Literal("DONE"),
      summary: Schema.String,
      finalState: Schema.String,
    }),
    additiveRest,
  ),
]);
export type PeerLoopReviewerDecision = typeof PeerLoopReviewerDecision.Type;

export const PeerLoopRepoSnapshot = Schema.StructWithRest(
  Schema.Struct({
    head: Schema.NullOr(Schema.String),
    branch: Schema.NullOr(Schema.String),
    worktreeDigest: Schema.NullOr(Schema.String),
    isGitRepo: Schema.Boolean,
    capturedAt: IsoDateTime,
  }),
  additiveRest,
);
export type PeerLoopRepoSnapshot = typeof PeerLoopRepoSnapshot.Type;

export const PeerLoopQueuedOwnerMessage = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    text: Schema.String,
    queuedAt: IsoDateTime,
  }),
  additiveRest,
);
export type PeerLoopQueuedOwnerMessage = typeof PeerLoopQueuedOwnerMessage.Type;

/** A turn that was running when Peer Loop stopped. Never replayed on its own. */
export const PeerLoopInFlightTurn = Schema.StructWithRest(
  Schema.Struct({
    actor: Schema.Literals(["reviewer", "builder"]),
    startedAt: IsoDateTime,
    iteration: NonNegativeInt,
    taskDigest: Schema.NullOr(Schema.String),
    pid: Schema.NullOr(Schema.Int),
  }),
  additiveRest,
);
export type PeerLoopInFlightTurn = typeof PeerLoopInFlightTurn.Type;

export const PeerLoopAdapterIdentity = Schema.StructWithRest(
  Schema.Struct({
    reviewer: Schema.String,
    reviewerVersion: Schema.NullOr(Schema.String),
    builder: Schema.String,
    builderVersion: Schema.NullOr(Schema.String),
  }),
  additiveRest,
);
export type PeerLoopAdapterIdentity = typeof PeerLoopAdapterIdentity.Type;

/**
 * Peer Loop's durable run state, as it writes it.
 *
 * The fields T3Code renders are modeled and validated; the rest — the
 * structured owner policy, pending operational notes, per-turn telemetry, and
 * whatever a later build adds — travels verbatim rather than being dropped.
 */
export const PeerLoopRunStateFile = Schema.StructWithRest(
  Schema.Struct({
    schemaVersion: Schema.Literal(PEER_LOOP_RUN_STATE_SCHEMA_VERSION),
    runId: TrimmedNonEmptyString,
    projectPath: Schema.String,
    state: PeerLoopRunState,
    iteration: NonNegativeInt,
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    /** The owner policy exactly as Peer Loop renders it. Never rewritten here. */
    ownerPolicyText: Schema.String,
    builderSessionId: Schema.NullOr(Schema.String),
    reviewerThreadId: Schema.NullOr(Schema.String),
    repo: Schema.NullOr(PeerLoopRepoSnapshot),
    lastBuilderTask: Schema.NullOr(Schema.String),
    lastBuilderReport: Schema.NullOr(Schema.String),
    /** Additive in Peer Loop: absent on state files written before it existed. */
    lastBuilderFailure: Schema.optional(Schema.NullOr(PeerLoopBuilderFailure)),
    lastReviewerDecision: Schema.NullOr(PeerLoopReviewerDecision),
    queuedOwnerMessages: Schema.Array(PeerLoopQueuedOwnerMessage),
    ownerObjectiveRecordedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
    inFlight: Schema.NullOr(PeerLoopInFlightTurn),
    haltReason: Schema.NullOr(PeerLoopHaltReason),
    stopRequested: Schema.Boolean,
    adapters: PeerLoopAdapterIdentity,
    safetyLimit: Schema.NullOr(PositiveInt),
    lastSequence: NonNegativeInt,
  }),
  additiveRest,
);
export type PeerLoopRunStateFile = typeof PeerLoopRunStateFile.Type;

/* ---------------------------------------------------------- run ownership */

/** The process holding a project's Peer Loop runtime-ownership lease. */
export const PeerLoopLiveWriter = Schema.StructWithRest(
  Schema.Struct({
    pid: Schema.Int,
    host: Schema.String,
    command: Schema.Literals(["start", "resume"]),
    runId: Schema.NullOr(Schema.String),
    acquiredAt: IsoDateTime,
    renewedAt: IsoDateTime,
    /** True when the lease belongs to the bridge this server spawned. */
    isThisProcess: Schema.Boolean,
  }),
  additiveRest,
);
export type PeerLoopLiveWriter = typeof PeerLoopLiveWriter.Type;

/**
 * Whether the bridge may mutate a run right now.
 *
 * Peer Loop derives this from its own ownership record. T3Code reports it and
 * greys out controls; it never second-guesses it, and it never touches another
 * process's lease.
 */
export const PeerLoopControlAvailability = Schema.StructWithRest(
  Schema.Struct({
    available: Schema.Boolean,
    reason: Schema.Literals(["live_in_this_bridge", "held_by_other_process", "not_attached"]),
    liveWriter: Schema.NullOr(PeerLoopLiveWriter),
    resumable: Schema.Boolean,
  }),
  additiveRest,
);
export type PeerLoopControlAvailability = typeof PeerLoopControlAvailability.Type;

/* ------------------------------------------------------------- run lists */

export const PeerLoopRunSummary = Schema.StructWithRest(
  Schema.Struct({
    runId: TrimmedNonEmptyString,
    projectPath: Schema.String,
    state: PeerLoopRunState,
    iteration: NonNegativeInt,
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    haltReason: Schema.NullOr(PeerLoopHaltReason),
    inFlight: Schema.NullOr(PeerLoopInFlightTurn),
    queuedOwnerMessages: NonNegativeInt,
    lastSequence: NonNegativeInt,
    awaitingOwnerObjective: Schema.Boolean,
    adapters: PeerLoopAdapterIdentity,
    liveWriter: Schema.NullOr(PeerLoopLiveWriter),
    liveInThisBridge: Schema.Boolean,
  }),
  additiveRest,
);
export type PeerLoopRunSummary = typeof PeerLoopRunSummary.Type;

/* ---------------------------------------------------------------- events */

export const PEER_LOOP_ACTORS = ["owner", "reviewer", "builder", "system"] as const;
export const PeerLoopActor = Schema.Literals(PEER_LOOP_ACTORS);
export type PeerLoopActor = typeof PeerLoopActor.Type;

/**
 * One durable Peer Loop event.
 *
 * The envelope is strict — `seq` in particular, because every reconnect and
 * every duplicate check in this integration is built on it. `type` and
 * `payload.kind` are open strings on purpose: Peer Loop adds event types as it
 * grows, and a stream that refused to decode an unfamiliar one would take the
 * whole activity feed down over an event the UI would simply have ignored.
 * The payload is carried whole so a client can render what it recognises and
 * keep the rest.
 */
export const PeerLoopEventPayload = Schema.StructWithRest(
  Schema.Struct({ kind: TrimmedNonEmptyString }),
  additiveRest,
);
export type PeerLoopEventPayload = typeof PeerLoopEventPayload.Type;

export const PeerLoopEvent = Schema.StructWithRest(
  Schema.Struct({
    runId: TrimmedNonEmptyString,
    /**
     * Per-run and strictly increasing, but NOT contiguous. The cursor for
     * every replay.
     *
     * Peer Loop numbers an event before it records it, so a number can be
     * spent and never appear. A skip is ordinary data; nothing may infer loss
     * from one.
     */
    seq: PositiveInt,
    ts: IsoDateTime,
    type: TrimmedNonEmptyString,
    actor: PeerLoopActor,
    iteration: NonNegativeInt,
    payload: PeerLoopEventPayload,
  }),
  additiveRest,
);
export type PeerLoopEvent = typeof PeerLoopEvent.Type;

/**
 * Why a run stopped, as reported at a halt or at the end.
 *
 * Peer Loop's own outcome union, so `DONE` stays distinguishable from a pause
 * and from an error without anyone reading prose.
 */
export const PeerLoopRunOutcome = Schema.Union([
  Schema.StructWithRest(
    Schema.Struct({
      kind: Schema.Literal("done"),
      finalState: Schema.String,
      summary: Schema.String,
    }),
    additiveRest,
  ),
  Schema.StructWithRest(
    Schema.Struct({
      kind: Schema.Literal("owner_required"),
      question: Schema.String,
      why: Schema.String,
      options: Schema.Array(Schema.String),
    }),
    additiveRest,
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal("paused"), reason: PeerLoopHaltReason }),
    additiveRest,
  ),
  Schema.StructWithRest(
    Schema.Struct({ kind: Schema.Literal("error"), reason: PeerLoopHaltReason }),
    additiveRest,
  ),
]);
export type PeerLoopRunOutcome = typeof PeerLoopRunOutcome.Type;

/* --------------------------------------------------- bridge wire results */

export const PeerLoopHealth = Schema.StructWithRest(
  Schema.Struct({
    protocolVersion: PositiveInt,
    bridge: Schema.StructWithRest(
      Schema.Struct({
        name: Schema.String,
        pid: Schema.Int,
        host: Schema.String,
        node: Schema.String,
      }),
      additiveRest,
    ),
    peerLoopHome: Schema.String,
    methods: Schema.Array(Schema.String),
    notifications: Schema.Array(Schema.String),
    errorCodes: Schema.Array(Schema.String),
    recoveryChoices: Schema.Array(Schema.String),
    capabilities: Schema.Record(Schema.String, Schema.Unknown),
    liveRuns: Schema.Array(Schema.String),
  }),
  additiveRest,
);
export type PeerLoopHealth = typeof PeerLoopHealth.Type;

export const PeerLoopRunsListResult = Schema.StructWithRest(
  Schema.Struct({
    peerLoopHome: Schema.String,
    runs: Schema.Array(PeerLoopRunSummary),
    unreadable: Schema.Array(Schema.String),
  }),
  additiveRest,
);
export type PeerLoopRunsListResult = typeof PeerLoopRunsListResult.Type;

const runSnapshotFields = {
  runId: TrimmedNonEmptyString,
  state: PeerLoopRunStateFile,
  control: PeerLoopControlAvailability,
  /** The authoritative high-water mark of the durable event log. */
  eventHighWaterMark: NonNegativeInt,
  replayFromSeq: NonNegativeInt,
  /** True when live events will follow. False for a read-only attach. */
  live: Schema.Boolean,
} as const;

export const PeerLoopAttachResult = Schema.StructWithRest(
  Schema.Struct(runSnapshotFields),
  additiveRest,
);
export type PeerLoopAttachResult = typeof PeerLoopAttachResult.Type;

export const PeerLoopStartResult = Schema.StructWithRest(
  Schema.Struct({
    ...runSnapshotFields,
    projectPath: Schema.String,
    /** True when no objective has been stated: no agent turn will start yet. */
    awaitingOwnerObjective: Schema.Boolean,
  }),
  additiveRest,
);
export type PeerLoopStartResult = typeof PeerLoopStartResult.Type;

export const PeerLoopResumeResult = Schema.StructWithRest(
  Schema.Struct({
    ...runSnapshotFields,
    projectPath: Schema.String,
    /** A turn was in flight. Nothing is replayed until the owner chooses. */
    interrupted: Schema.Boolean,
    awaitingOwnerObjective: Schema.Boolean,
  }),
  additiveRest,
);
export type PeerLoopResumeResult = typeof PeerLoopResumeResult.Type;

export const PeerLoopOwnerMessageResult = Schema.StructWithRest(
  Schema.Struct({
    runId: TrimmedNonEmptyString,
    /** True when an agent was mid-turn: delivered at the next Reviewer turn. */
    queued: Schema.Boolean,
    accepted: Schema.Boolean,
    queuedOwnerMessages: NonNegativeInt,
  }),
  additiveRest,
);
export type PeerLoopOwnerMessageResult = typeof PeerLoopOwnerMessageResult.Type;

export const PeerLoopPauseResult = Schema.StructWithRest(
  Schema.Struct({
    runId: TrimmedNonEmptyString,
    /** `live` asked a running loop to stop; `durable` recorded the request. */
    applied: Schema.Literals(["live", "durable"]),
  }),
  additiveRest,
);
export type PeerLoopPauseResult = typeof PeerLoopPauseResult.Type;

export const PEER_LOOP_RECOVERY_CHOICES = [
  "resume_to_reviewer",
  "replay_builder_task",
  "abandon",
] as const;
export const PeerLoopRecoveryChoice = Schema.Literals(PEER_LOOP_RECOVERY_CHOICES);
export type PeerLoopRecoveryChoice = typeof PeerLoopRecoveryChoice.Type;

export const PeerLoopRecoverResult = Schema.StructWithRest(
  Schema.Struct({
    runId: TrimmedNonEmptyString,
    choice: PeerLoopRecoveryChoice,
    state: PeerLoopRunStateFile,
  }),
  additiveRest,
);
export type PeerLoopRecoverResult = typeof PeerLoopRecoverResult.Type;

/* ------------------------------------------------- bridge wire envelopes */

export const PEER_LOOP_BRIDGE_METHODS = [
  "health",
  "runs.list",
  "run.attach",
  "run.start",
  "run.resume",
  "run.ownerMessage",
  "run.pause",
  "run.recover",
] as const;
export const PeerLoopBridgeMethod = Schema.Literals(PEER_LOOP_BRIDGE_METHODS);
export type PeerLoopBridgeMethod = typeof PeerLoopBridgeMethod.Type;

/**
 * What a version-1 bridge must offer before T3Code will send it a command.
 *
 * Announcing version 1 is not the same as implementing it. A bridge missing a
 * method this build will call, or a notification it depends on to stay in sync,
 * is incompatible however it labels itself — and finding that out at the
 * handshake is far better than finding it out halfway through a run.
 * Extra methods and notifications are additive and always fine.
 */
export const PEER_LOOP_REQUIRED_METHODS = PEER_LOOP_BRIDGE_METHODS;
export const PEER_LOOP_REQUIRED_NOTIFICATIONS = [
  "bridge.ready",
  "run.event",
  "run.outcome",
  "run.finished",
  "run.resync",
] as const;

/** Names a v1 ready announcement is missing, or empty when it is complete. */
export function missingPeerLoopCapabilities(health: {
  readonly methods: readonly string[];
  readonly notifications: readonly string[];
}): readonly string[] {
  const methods = new Set(health.methods);
  const notifications = new Set(health.notifications);
  return [
    ...PEER_LOOP_REQUIRED_METHODS.filter((method) => !methods.has(method)),
    ...PEER_LOOP_REQUIRED_NOTIFICATIONS.filter((name) => !notifications.has(name)),
  ];
}

/**
 * Peer Loop's stable refusal codes.
 *
 * Modeled as a strict union because these are the whole reason the integration
 * can say something useful when a command is refused. An unrecognised code
 * from a newer bridge is still surfaced — see `PeerLoopBridgeErrorBody` — it
 * simply cannot be pattern-matched.
 */
export const PEER_LOOP_BRIDGE_ERROR_CODES = [
  "INVALID_JSON",
  "INVALID_REQUEST",
  "UNSUPPORTED_PROTOCOL_VERSION",
  "UNKNOWN_METHOD",
  "INVALID_PARAMS",
  "LINE_TOO_LONG",
  "RUN_NOT_FOUND",
  "PROJECT_HAS_UNFINISHED_RUN",
  "CONTROL_UNAVAILABLE",
  "RUN_ALREADY_LIVE",
  "REVIEWER_THREAD_BUSY",
  "INVALID_RUN_STATE",
  "INTERNAL_ERROR",
] as const;
export type PeerLoopBridgeErrorCode = (typeof PEER_LOOP_BRIDGE_ERROR_CODES)[number];

export function isPeerLoopBridgeErrorCode(value: string): value is PeerLoopBridgeErrorCode {
  return (PEER_LOOP_BRIDGE_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * A refusal, as it came off the wire.
 *
 * `code` stays a plain string: a newer bridge may refuse for a reason this
 * build has no literal for, and dropping the code would leave an operator with
 * prose. Callers narrow with `isPeerLoopBridgeErrorCode`.
 */
export const PeerLoopBridgeErrorBody = Schema.StructWithRest(
  Schema.Struct({
    code: TrimmedNonEmptyString,
    message: Schema.String,
    detail: Schema.optional(Schema.Unknown),
  }),
  additiveRest,
);
export type PeerLoopBridgeErrorBody = typeof PeerLoopBridgeErrorBody.Type;

/**
 * One request, as it goes onto the bridge's stdin.
 *
 * A schema rather than a hand-built string so the only way to produce a
 * request line is to produce a valid one, and so `method` is checked against
 * the methods that exist before anything is written.
 */
export const PeerLoopBridgeRequest = Schema.Struct({
  v: PeerLoopEnvelopeVersion,
  type: Schema.Literal("request"),
  /** Echoed on the response. Correlation is the caller's business. */
  id: TrimmedNonEmptyString,
  method: PeerLoopBridgeMethod,
  params: Schema.Record(Schema.String, Schema.Unknown),
});
export type PeerLoopBridgeRequest = typeof PeerLoopBridgeRequest.Type;

const bridgeEnvelopeFields = {
  v: PeerLoopEnvelopeVersion,
  type: Schema.Literal("response"),
  id: Schema.NullOr(Schema.String),
  method: Schema.NullOr(Schema.String),
} as const;

export const PeerLoopBridgeSuccessResponse = Schema.Struct({
  ...bridgeEnvelopeFields,
  ok: Schema.Literal(true),
  result: Schema.Unknown,
});
export type PeerLoopBridgeSuccessResponse = typeof PeerLoopBridgeSuccessResponse.Type;

export const PeerLoopBridgeErrorResponse = Schema.Struct({
  ...bridgeEnvelopeFields,
  ok: Schema.Literal(false),
  error: PeerLoopBridgeErrorBody,
});
export type PeerLoopBridgeErrorResponse = typeof PeerLoopBridgeErrorResponse.Type;

export const PeerLoopBridgeResponse = Schema.Union([
  PeerLoopBridgeSuccessResponse,
  PeerLoopBridgeErrorResponse,
]);
export type PeerLoopBridgeResponse = typeof PeerLoopBridgeResponse.Type;

const notification = <M extends string, P extends Schema.Top>(method: M, params: P) =>
  Schema.Struct({
    v: PeerLoopEnvelopeVersion,
    type: Schema.Literal("notification"),
    method: Schema.Literal(method),
    params,
  });

export const PeerLoopBridgeReadyNotification = notification("bridge.ready", PeerLoopHealth);

export const PeerLoopRunEventNotification = notification(
  "run.event",
  Schema.StructWithRest(
    Schema.Struct({
      runId: TrimmedNonEmptyString,
      event: PeerLoopEvent,
      /** True while the bridge is replaying the durable log rather than live. */
      replay: Schema.Boolean,
    }),
    additiveRest,
  ),
);

export const PeerLoopRunOutcomeNotification = notification(
  "run.outcome",
  Schema.StructWithRest(
    Schema.Struct({
      runId: TrimmedNonEmptyString,
      outcome: PeerLoopRunOutcome,
      state: Schema.NullOr(PeerLoopRunStateFile),
    }),
    additiveRest,
  ),
);

export const PeerLoopRunFinishedNotification = notification(
  "run.finished",
  Schema.StructWithRest(
    Schema.Struct({
      runId: TrimmedNonEmptyString,
      outcome: PeerLoopRunOutcome,
      state: Schema.NullOr(PeerLoopRunStateFile),
      /** Why the bridge stopped driving it. */
      reason: Schema.Literals(["terminal", "shutdown"]),
    }),
    additiveRest,
  ),
);

export const PeerLoopRunResyncNotification = notification(
  "run.resync",
  Schema.StructWithRest(
    Schema.Struct({
      runId: TrimmedNonEmptyString,
      afterSeq: NonNegativeInt,
      reason: Schema.String,
    }),
    additiveRest,
  ),
);

export const PeerLoopBridgeNotification = Schema.Union([
  PeerLoopBridgeReadyNotification,
  PeerLoopRunEventNotification,
  PeerLoopRunOutcomeNotification,
  PeerLoopRunFinishedNotification,
  PeerLoopRunResyncNotification,
]);
export type PeerLoopBridgeNotification = typeof PeerLoopBridgeNotification.Type;

/**
 * Anything the bridge can write on stdout.
 *
 * A line that does not decode to one of these is a protocol violation, not
 * something to guess about — see `PeerLoopProtocolError`.
 */
export const PeerLoopBridgeOutbound = Schema.Union([
  PeerLoopBridgeResponse,
  PeerLoopBridgeNotification,
]);
export type PeerLoopBridgeOutbound = typeof PeerLoopBridgeOutbound.Type;

/* ------------------------------------------------------- transport state */

/**
 * What T3Code can say about the bridge subprocess it owns.
 *
 * `interrupted` is the one that matters: the bridge exited while T3Code was
 * still using it. It never means a run failed, and it never authorises T3Code
 * to resume anything — Peer Loop's durable state is untouched and resuming is
 * an explicit owner command.
 */
export const PEER_LOOP_TRANSPORT_STATES = [
  "unavailable",
  "starting",
  "connected",
  "interrupted",
  "stopped",
] as const;
export const PeerLoopTransportState = Schema.Literals(PEER_LOOP_TRANSPORT_STATES);
export type PeerLoopTransportState = typeof PeerLoopTransportState.Type;

export const PeerLoopTransportStatus = Schema.Struct({
  state: PeerLoopTransportState,
  changedAt: IsoDateTime,
  /** Bounded, operator-facing. Never a path, a token, or raw child output. */
  detail: Schema.NullOr(Schema.String),
  protocolVersion: Schema.NullOr(PositiveInt),
});
export type PeerLoopTransportStatus = typeof PeerLoopTransportStatus.Type;

/**
 * How the executable was configured, without saying where it is.
 *
 * The path itself is machine-local and deliberately never leaves the server:
 * a client authorized over Tailscale from a phone has no business learning the
 * filesystem layout of the machine, and no RPC can set it either.
 */
export const PEER_LOOP_EXECUTABLE_SOURCES = [
  "none",
  "path",
  "env-executable",
  "env-node-entry",
  "local-config-executable",
  "local-config-node-entry",
] as const;
export const PeerLoopExecutableSource = Schema.Literals(PEER_LOOP_EXECUTABLE_SOURCES);
export type PeerLoopExecutableSource = typeof PeerLoopExecutableSource.Type;

/* --------------------------------------------------------- T3-side errors */

export class PeerLoopUnavailableError extends Schema.TaggedErrorClass<PeerLoopUnavailableError>()(
  "PeerLoopUnavailableError",
  { reason: Schema.String },
) {
  override get message() {
    return `Peer Loop is not available on this environment: ${this.reason}`;
  }
}

export class PeerLoopIncompatibleError extends Schema.TaggedErrorClass<PeerLoopIncompatibleError>()(
  "PeerLoopIncompatibleError",
  { expected: PositiveInt, reported: Schema.NullOr(Schema.Int), detail: Schema.String },
) {
  override get message() {
    return `Peer Loop bridge speaks protocol ${this.reported ?? "an unknown version"}; this build requires ${this.expected}.`;
  }
}

/** The bridge wrote something on stdout that is not protocol. Fail closed. */
export class PeerLoopProtocolError extends Schema.TaggedErrorClass<PeerLoopProtocolError>()(
  "PeerLoopProtocolError",
  { detail: Schema.String },
) {
  override get message() {
    return `Peer Loop bridge produced invalid protocol output: ${this.detail}`;
  }
}

/** The bridge exited, or its stdio was cut, while T3Code was using it. */
export class PeerLoopTransportError extends Schema.TaggedErrorClass<PeerLoopTransportError>()(
  "PeerLoopTransportError",
  { detail: Schema.String, exitCode: Schema.NullOr(Schema.Int) },
) {
  override get message() {
    return `Peer Loop bridge transport failed: ${this.detail}`;
  }
}

/**
 * Peer Loop did not answer in time.
 *
 * A timeout is the absence of an answer, not evidence of anything. For a
 * mutation Peer Loop may already have accepted it — started a run, queued an
 * owner message, resolved an interrupted turn — and finished after T3Code
 * stopped waiting. So `mayHaveApplied` is true for those, and T3Code never
 * retries automatically: repeating a `run.start` that actually succeeded would
 * fork a session, and repeating a `run.recover` would replay a Builder task.
 * The owner re-reads the run and decides.
 */
export class PeerLoopTimeoutError extends Schema.TaggedErrorClass<PeerLoopTimeoutError>()(
  "PeerLoopTimeoutError",
  { method: Schema.String, timeoutMs: PositiveInt, mayHaveApplied: Schema.Boolean },
) {
  override get message() {
    return this.mayHaveApplied
      ? `Peer Loop did not answer ${this.method} within ${this.timeoutMs}ms. It may still have accepted or completed it; nothing was retried.`
      : `Peer Loop did not answer ${this.method} within ${this.timeoutMs}ms.`;
  }
}

/**
 * Peer Loop refused the command, and said why.
 *
 * Passed through with its stable code intact. `CONTROL_UNAVAILABLE`,
 * `PROJECT_HAS_UNFINISHED_RUN`, `REVIEWER_THREAD_BUSY` and `INVALID_RUN_STATE`
 * all mean different things to an operator and stay distinguishable here
 * rather than collapsing into a generic failure.
 */
export class PeerLoopCommandRefusedError extends Schema.TaggedErrorClass<PeerLoopCommandRefusedError>()(
  "PeerLoopCommandRefusedError",
  {
    code: Schema.String,
    detail: Schema.String,
    /** Structured extra facts Peer Loop attached. Safe: never a secret. */
    data: Schema.NullOr(Schema.Unknown),
  },
) {
  override get message() {
    return `Peer Loop refused the command (${this.code}): ${this.detail}`;
  }
}

export const PeerLoopError = Schema.Union([
  PeerLoopUnavailableError,
  PeerLoopIncompatibleError,
  PeerLoopProtocolError,
  PeerLoopTransportError,
  PeerLoopTimeoutError,
  PeerLoopCommandRefusedError,
]);
export type PeerLoopError = typeof PeerLoopError.Type;

/* -------------------------------------------------------- T3 RPC surface */

export const PEER_LOOP_WS_METHODS = {
  status: "peerLoop.status",
  listRuns: "peerLoop.listRuns",
  attachRun: "peerLoop.attachRun",
  startRun: "peerLoop.startRun",
  resumeRun: "peerLoop.resumeRun",
  sendOwnerMessage: "peerLoop.sendOwnerMessage",
  pauseRun: "peerLoop.pauseRun",
  recoverRun: "peerLoop.recoverRun",
  subscribeEvents: "peerLoop.subscribeEvents",
  /**
   * Execute one agreed Navigator Execution Proposal as a run.
   *
   * Coordination, not a second start path: the server derives the project and
   * the objective from its own read model. Its input and result live in
   * `peerLoopExecution.ts`, which is allowed to know about orchestration
   * types; this module stays a pure bridge contract.
   */
  executeProposal: "peerLoop.executeProposal",
} as const;

/**
 * An absolute project directory.
 *
 * Peer Loop canonicalises and owns it; T3Code only forwards the workspace root
 * it already knows about.
 */
export const PeerLoopProjectPath = TrimmedNonEmptyString;

export const PeerLoopStatusInput = Schema.Struct({
  /** Scope run counts to one project. Omit for the environment-wide view. */
  projectPath: Schema.optional(PeerLoopProjectPath),
});
export type PeerLoopStatusInput = typeof PeerLoopStatusInput.Type;

export const PeerLoopStatusResult = Schema.Struct({
  /** False when no executable is configured or resolvable on this machine. */
  configured: Schema.Boolean,
  executableSource: PeerLoopExecutableSource,
  transport: PeerLoopTransportStatus,
  /** Present once a `bridge.ready` handshake has been accepted. */
  health: Schema.NullOr(PeerLoopHealth),
});
export type PeerLoopStatusResult = typeof PeerLoopStatusResult.Type;

export const PeerLoopListRunsInput = Schema.Struct({
  projectPath: Schema.optional(PeerLoopProjectPath),
});
export type PeerLoopListRunsInput = typeof PeerLoopListRunsInput.Type;

export const PeerLoopListRunsResult = Schema.Struct({
  runs: Schema.Array(PeerLoopRunSummary),
  /** Run directories Peer Loop could not read. Named, never silently dropped. */
  unreadable: Schema.Array(Schema.String),
});
export type PeerLoopListRunsResult = typeof PeerLoopListRunsResult.Type;

export const PeerLoopRunIdInput = Schema.Struct({ runId: TrimmedNonEmptyString });
export type PeerLoopRunIdInput = typeof PeerLoopRunIdInput.Type;

export const PeerLoopAttachRunInput = Schema.Struct({
  runId: TrimmedNonEmptyString,
  /** The highest `seq` the caller already holds. Replay starts strictly after. */
  afterSeq: Schema.optional(NonNegativeInt),
});
export type PeerLoopAttachRunInput = typeof PeerLoopAttachRunInput.Type;

/**
 * Start a run.
 *
 * Deliberately narrower than the Peer Loop CLI. The Builder permission mode is
 * not exposed: it decides what an agent may do on this machine, and it is not
 * something a remotely authorized client should be able to widen. Peer Loop's
 * own default applies, and an operator who needs another one sets it where
 * every other machine-local decision is made.
 */
export const PeerLoopStartRunInput = Schema.Struct({
  projectPath: PeerLoopProjectPath,
  /** Delivered verbatim to Reviewer turn 1. Omit and the run waits for one. */
  objective: Schema.optional(TrimmedNonEmptyString),
  /** Bypasses ONLY Peer Loop's duplicate-run preflight. */
  newRun: Schema.optional(Schema.Boolean),
  safetyLimit: Schema.optional(PositiveInt),
});
export type PeerLoopStartRunInput = typeof PeerLoopStartRunInput.Type;

export const PeerLoopSendOwnerMessageInput = Schema.Struct({
  runId: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
});
export type PeerLoopSendOwnerMessageInput = typeof PeerLoopSendOwnerMessageInput.Type;

export const PeerLoopRecoverRunInput = Schema.Struct({
  runId: TrimmedNonEmptyString,
  /**
   * One of Peer Loop's three explicit choices. There is no default here and
   * there is none in Peer Loop: an interrupted Builder turn may already have
   * changed the repository, so replaying it is the owner's call.
   */
  choice: PeerLoopRecoveryChoice,
});
export type PeerLoopRecoverRunInput = typeof PeerLoopRecoverRunInput.Type;

export const PeerLoopSubscribeEventsInput = Schema.Struct({
  runId: TrimmedNonEmptyString,
  /**
   * Where to resume from. A reconnecting web or mobile client sends the last
   * `seq` it rendered and receives the durable backlog after it, then live
   * activity, with no gap and no duplicate.
   */
  afterSeq: Schema.optional(NonNegativeInt),
});
export type PeerLoopSubscribeEventsInput = typeof PeerLoopSubscribeEventsInput.Type;

/**
 * What a subscriber receives.
 *
 * A union rather than a bare event stream because transport changes, halts and
 * completions are facts a UI has to render, and inferring them from the
 * absence of events would be exactly the kind of guessing this integration
 * exists to avoid.
 */
export const PeerLoopSubscriptionEvent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("transport"), transport: PeerLoopTransportStatus }),
  /**
   * The snapshot this subscription's own `run.attach` already produced.
   *
   * A T3 transport convenience and nothing more: it is Peer Loop's validated
   * answer, forwarded verbatim. Without it a UI would have to issue a second
   * `run.attach` purely to learn the run's state and whether it may be
   * controlled — a duplicate replay, serialised behind the first one, for data
   * this server already had. Emitted once, before any backlog activity.
   */
  Schema.Struct({
    kind: Schema.Literal("run-attached"),
    runId: TrimmedNonEmptyString,
    snapshot: PeerLoopAttachResult,
  }),
  Schema.Struct({
    kind: Schema.Literal("run-event"),
    runId: TrimmedNonEmptyString,
    event: PeerLoopEvent,
    replay: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("run-outcome"),
    runId: TrimmedNonEmptyString,
    outcome: PeerLoopRunOutcome,
    state: Schema.NullOr(PeerLoopRunStateFile),
  }),
  Schema.Struct({
    kind: Schema.Literal("run-finished"),
    runId: TrimmedNonEmptyString,
    outcome: PeerLoopRunOutcome,
    state: Schema.NullOr(PeerLoopRunStateFile),
    reason: Schema.Literals(["terminal", "shutdown"]),
  }),
  /**
   * The stream could not be kept gapless. Re-subscribe from `afterSeq`; the
   * durable log is unaffected and nothing about the run has changed.
   */
  Schema.Struct({
    kind: Schema.Literal("run-resync"),
    runId: TrimmedNonEmptyString,
    afterSeq: NonNegativeInt,
    reason: Schema.String,
  }),
  /**
   * This subscriber has caught up: it has been delivered every event through
   * the high-water mark its own `run.attach` reported.
   *
   * A T3 TRANSPORT FACT, NOT A PEER LOOP ONE. It says nothing about the run —
   * not that it finished, not that it is idle, not that anything was decided.
   * It exists because "the backlog is behind you" is otherwise unknowable to a
   * client: sequences skip legitimately, so a client cannot compute it, and the
   * first replayed event certainly does not prove it. Emitted at most once per
   * subscription and never after a resync, an overflow, a replay that did not
   * reach its boundary, or a transport that ended.
   */
  Schema.Struct({
    kind: Schema.Literal("run-synced"),
    runId: TrimmedNonEmptyString,
    /** The cursor actually delivered. Never ahead of a real event. */
    afterSeq: NonNegativeInt,
    /** The boundary this attach reported, and which `afterSeq` has reached. */
    eventHighWaterMark: NonNegativeInt,
  }),
]);
export type PeerLoopSubscriptionEvent = typeof PeerLoopSubscriptionEvent.Type;

/**
 * How much ordered activity a client keeps per run.
 *
 * Peer Loop's event log is the durable record and can be replayed from any
 * `seq`, so a client has no reason to hold a whole run in memory — and every
 * reason not to, on a phone.
 */
export const PEER_LOOP_CLIENT_ACTIVITY_LIMIT = 400;
