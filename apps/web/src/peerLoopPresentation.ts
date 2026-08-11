/**
 * Everything the Peer Loop surface renders, as pure functions.
 *
 * Peer Loop decides; this file only chooses words. Every value here is read
 * from Peer Loop's own structured state, outcome or halt reason — nothing is
 * derived from prose, and nothing infers that a run should continue, has
 * finished, or may be controlled. Those are Peer Loop's calls and the owner's.
 *
 * Kept separate from the components so the interesting part — which run needs
 * attention, which control is legitimately available, how an unfamiliar event
 * is shown without dumping a wall of JSON — is testable without a browser.
 *
 * @module PeerLoopPresentation
 */
import {
  type PeerLoopControlAvailability,
  type PeerLoopError,
  type PeerLoopEvent,
  type PeerLoopHaltKind,
  type PeerLoopReviewerDecision,
  type PeerLoopRunStateFile,
  type PeerLoopRunSummary,
  type PeerLoopTransportStatus,
} from "@t3tools/contracts";
import type { PeerLoopRunView } from "@t3tools/client-runtime/state/peer-loop-reducer";

export type PeerLoopTone = "neutral" | "info" | "warning" | "danger" | "success";

/* ------------------------------------------------------------- transport */

export interface PeerLoopTransportPresentation {
  readonly label: string;
  readonly tone: PeerLoopTone;
  /** Peer Loop's or the server's own words, already category-only. */
  readonly detail: string | null;
}

const TRANSPORT_LABELS: Readonly<Record<PeerLoopTransportStatus["state"], string>> = {
  unavailable: "Not available",
  starting: "Starting",
  connected: "Connected",
  interrupted: "Connection ended",
  stopped: "Stopped",
};

const TRANSPORT_TONES: Readonly<Record<PeerLoopTransportStatus["state"], PeerLoopTone>> = {
  unavailable: "warning",
  starting: "info",
  connected: "success",
  interrupted: "warning",
  stopped: "neutral",
};

export function describeTransport(
  status: PeerLoopTransportStatus,
  configured: boolean,
): PeerLoopTransportPresentation {
  if (!configured && status.state === "unavailable") {
    return {
      label: "Peer Loop is not set up on this machine",
      tone: "neutral",
      detail: status.detail,
    };
  }
  return {
    label: TRANSPORT_LABELS[status.state],
    tone: TRANSPORT_TONES[status.state],
    detail: status.detail,
  };
}

/* ------------------------------------------------------------ attention */

/**
 * What a run is waiting on, in the owner's terms.
 *
 * One entry per halt kind Peer Loop can report, plus the three conditions that
 * are not halts: finished, interrupted transport, and nothing at all. Every one
 * of them reads differently on purpose — "sign in to a CLI" and "the Reviewer
 * has a question for you" are fixed in completely different places, and a
 * single "needs attention" badge would hide that.
 */
export type PeerLoopAttentionKey =
  | "none"
  | "running"
  | "driver-missing"
  | "owner-decision"
  | "needs-objective"
  | "capacity-exhausted"
  | "auth-required"
  | "transport-interrupted"
  | "recovery-required"
  | "paused"
  | "safety-limit"
  | "blocked"
  | "failed"
  | "done";

export interface PeerLoopAttentionPresentation {
  readonly key: PeerLoopAttentionKey;
  readonly label: string;
  readonly tone: PeerLoopTone;
  /** True when a person has to do something before the run can move. */
  readonly actionable: boolean;
  /** Peer Loop's own message, when it gave one. Never invented here. */
  readonly detail: string | null;
}

const ATTENTION: Readonly<
  Record<PeerLoopAttentionKey, { readonly label: string; readonly tone: PeerLoopTone }>
> = {
  none: { label: "Idle", tone: "neutral" },
  running: { label: "Working", tone: "info" },
  "driver-missing": {
    label: "Interrupted — no Reviewer or Builder running",
    tone: "warning",
  },
  "owner-decision": { label: "The Reviewer needs your decision", tone: "warning" },
  "needs-objective": { label: "Needs an objective", tone: "warning" },
  "capacity-exhausted": { label: "Agent capacity exhausted", tone: "warning" },
  "auth-required": { label: "An agent CLI needs signing in", tone: "warning" },
  "transport-interrupted": { label: "A turn was cut off", tone: "warning" },
  "recovery-required": { label: "Interrupted turn — choose how to continue", tone: "danger" },
  paused: { label: "Paused", tone: "neutral" },
  "safety-limit": { label: "Stopped at its safety limit", tone: "neutral" },
  blocked: { label: "Blocked", tone: "danger" },
  failed: { label: "Failed", tone: "danger" },
  done: { label: "Done", tone: "success" },
};

const HALT_ATTENTION: Readonly<Record<PeerLoopHaltKind, PeerLoopAttentionKey>> = {
  OWNER_REQUIRED: "owner-decision",
  OWNER_OBJECTIVE_REQUIRED: "needs-objective",
  CAPACITY_EXHAUSTED: "capacity-exhausted",
  AUTH_REQUIRED: "auth-required",
  TRANSPORT_INTERRUPTED: "transport-interrupted",
  AMBIGUOUS_INTERRUPTED_TURN: "recovery-required",
  OWNER_PAUSED: "paused",
  SAFETY_LIMIT: "safety-limit",
  SYSTEM_BLOCKED: "blocked",
  CAPABILITY_MISMATCH: "failed",
  PROTOCOL_ERROR: "failed",
  PROCESS_ERROR: "failed",
};

const NOT_ACTIONABLE: ReadonlySet<PeerLoopAttentionKey> = new Set([
  "none",
  "running",
  "done",
  "paused",
  "safety-limit",
]);

const present = (
  key: PeerLoopAttentionKey,
  detail: string | null,
): PeerLoopAttentionPresentation => ({
  key,
  label: ATTENTION[key].label,
  tone: ATTENTION[key].tone,
  actionable: !NOT_ACTIONABLE.has(key),
  detail,
});

/**
 * T3 Code's own words for a working state nobody is driving.
 *
 * Not Peer Loop's message — Peer Loop reported a fact (no live writer) rather
 * than a sentence — so it is kept out of `detail`, which stays reserved for
 * what Peer Loop actually said.
 */
export const PEER_LOOP_NO_DRIVER_NOTE =
  "Peer Loop's record still says a turn is in progress, but no Reviewer or Builder is running it. " +
  "The run stopped part-way rather than finishing. Nothing is resumed for you.";

/**
 * Read a run's condition off Peer Loop's structured state.
 *
 * `done` wins over a halt reason, because a finished run's last halt is
 * history. `interrupted` outranks the rest because it is the one state where
 * the repository may already have changed and only the owner can say what
 * happens next.
 *
 * `hasActiveDriver` is the one fact a working state cannot supply on its own. A
 * run state file says the Builder was working when it was last written; it does
 * not say anybody still is. When Peer Loop reports no live writer, the run is
 * stale rather than busy, and it needs a person. It defaults to true because
 * "no driver" has to be Peer Loop's answer, never this file's guess: an unknown
 * driver is shown as working, which is what it was before this existed.
 */
export function describeAttention(input: {
  readonly state: PeerLoopRunSummary["state"];
  readonly haltReason: PeerLoopRunSummary["haltReason"];
  readonly inFlight: PeerLoopRunSummary["inFlight"];
  readonly awaitingOwnerObjective?: boolean;
  readonly hasActiveDriver?: boolean;
}): PeerLoopAttentionPresentation {
  if (input.state === "done") return present("done", input.haltReason?.message ?? null);
  if (input.state === "interrupted") {
    return present("recovery-required", input.haltReason?.message ?? null);
  }
  if (input.haltReason !== null) {
    return present(HALT_ATTENTION[input.haltReason.kind], input.haltReason.message);
  }
  if (input.awaitingOwnerObjective === true) return present("needs-objective", null);
  if (input.state === "error") return present("failed", null);
  if (input.state === "reviewer_working" || input.state === "builder_working") {
    return present(input.hasActiveDriver === false ? "driver-missing" : "running", null);
  }
  if (input.state === "owner_required") return present("owner-decision", null);
  if (input.state === "paused") return present("paused", null);
  return present("none", null);
}

export function describeRunAttention(run: PeerLoopRunSummary): PeerLoopAttentionPresentation {
  return describeAttention({
    state: run.state,
    haltReason: run.haltReason,
    inFlight: run.inFlight,
    awaitingOwnerObjective: run.awaitingOwnerObjective,
    // A live writer is the whole of it. Whose process it is does not matter:
    // another Peer Loop driving this run is still a run being driven.
    hasActiveDriver: run.liveWriter !== null,
  });
}

/**
 * Whether anything is driving the run this subscription is attached to.
 *
 * Peer Loop's own control snapshot, and nothing else — not elapsed time, not
 * the last event, not whether this bridge happens to hold the lease, and not
 * the transport, which says whether T3 Code can hear Peer Loop rather than
 * whether Peer Loop is working. `held_by_other_process` is a driven run this
 * page merely cannot command. Anything unrecognised counts as driven, so a
 * newer Peer Loop can never make T3 Code call a live run interrupted.
 */
function hasActiveDriver(control: PeerLoopControlAvailability | null): boolean {
  if (control === null) return true;
  if (control.liveWriter !== null) return true;
  return control.reason !== "not_attached";
}

/**
 * The run's condition, from the subscription's own snapshot.
 *
 * `DONE` is Peer Loop's outcome, not a guess from the state file, so a finished
 * run reads as finished even before its state file is re-read.
 */
export function describeViewAttention(view: PeerLoopRunView): PeerLoopAttentionPresentation {
  if (view.outcome?.kind === "done") return present("done", view.outcome.summary);
  const state = view.state;
  if (state === null) return present("none", null);
  return describeAttention({
    state: state.state,
    haltReason: state.haltReason,
    inFlight: state.inFlight,
    hasActiveDriver: hasActiveDriver(view.control),
  });
}

/* -------------------------------------------------------------- grouping */

export interface PeerLoopRunGroups {
  /** Waiting on a person. Shown first, because nothing moves until they act. */
  readonly attention: readonly PeerLoopRunSummary[];
  /** An agent is working, or the run is simply between turns. */
  readonly active: readonly PeerLoopRunSummary[];
  /** Finished or failed. History. */
  readonly recent: readonly PeerLoopRunSummary[];
}

const TERMINAL_STATES: ReadonlySet<PeerLoopRunSummary["state"]> = new Set(["done", "error"]);

const byRecency = (a: PeerLoopRunSummary, b: PeerLoopRunSummary): number =>
  b.updatedAt.localeCompare(a.updatedAt);

export function groupRuns(runs: readonly PeerLoopRunSummary[]): PeerLoopRunGroups {
  const attention: PeerLoopRunSummary[] = [];
  const active: PeerLoopRunSummary[] = [];
  const recent: PeerLoopRunSummary[] = [];

  for (const run of runs) {
    if (TERMINAL_STATES.has(run.state)) {
      recent.push(run);
      continue;
    }
    (describeRunAttention(run).actionable ? attention : active).push(run);
  }

  return {
    attention: attention.sort(byRecency),
    active: active.sort(byRecency),
    recent: recent.sort(byRecency),
  };
}

/** The last path segment, which is what an operator actually recognises. */
export function projectLabel(projectPath: string): string {
  const trimmed = projectPath.replace(/[/\\]+$/u, "");
  const segments = trimmed.split(/[/\\]/u);
  return segments[segments.length - 1] || projectPath;
}

/* ---------------------------------------------------------------- events */

export interface PeerLoopEventPresentation {
  readonly title: string;
  /** One line at most. Long values are truncated rather than wrapped. */
  readonly detail: string | null;
  readonly tone: PeerLoopTone;
}

/** How much of an unfamiliar payload is worth showing before it is noise. */
export const PEER_LOOP_EVENT_DETAIL_CHARS = 240;

const truncate = (value: string, limit = PEER_LOOP_EVENT_DETAIL_CHARS): string => {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
};

const readString = (payload: PeerLoopEventPayloadLike, key: string): string | null => {
  const value = payload[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
};

type PeerLoopEventPayloadLike = Readonly<Record<string, unknown>> & { readonly kind: string };

/**
 * A summary of an unfamiliar payload, without dumping it.
 *
 * Peer Loop grows event types, and an unknown one must neither break the feed
 * nor fill a phone with serialised objects. Scalars are shown because they are
 * usually the interesting part; anything nested becomes its key and its shape.
 */
function summariseUnknownPayload(payload: PeerLoopEventPayloadLike): string | null {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (key === "kind") continue;
    if (typeof value === "string") parts.push(`${key}: ${truncate(value, 80)}`);
    else if (typeof value === "number" || typeof value === "boolean") {
      parts.push(`${key}: ${String(value)}`);
    } else if (value === null) parts.push(`${key}: none`);
    else if (Array.isArray(value)) parts.push(`${key}: ${value.length} item(s)`);
    else if (typeof value === "object") parts.push(`${key}: …`);
    if (parts.join(", ").length >= PEER_LOOP_EVENT_DETAIL_CHARS) break;
  }
  return parts.length === 0 ? null : truncate(parts.join(", "));
}

const ACTOR_LABEL: Readonly<Record<PeerLoopEvent["actor"], string>> = {
  owner: "You",
  reviewer: "Reviewer",
  builder: "Builder",
  system: "Peer Loop",
};

/**
 * Recognised payload kinds, and how each one reads.
 *
 * Deliberately a small set. Everything else falls through to the summary
 * above, which is what keeps this list from being a second copy of Peer Loop's
 * event catalogue that has to be kept in step with it.
 */
const RECOGNISED: Readonly<
  Record<
    string,
    (payload: PeerLoopEventPayloadLike) => {
      readonly title: string;
      readonly detail: string | null;
    }
  >
> = {
  run_started: () => ({ title: "Run started", detail: null }),
  owner_objective: (payload) => ({
    title: "Objective recorded",
    detail: readString(payload, "text"),
  }),
  owner_message: (payload) => ({
    title: "Your message",
    detail: readString(payload, "text"),
  }),
  reviewer_decision: (payload) => ({
    title: `Reviewer decided: ${readString(payload, "decision") ?? "unknown"}`,
    detail: readString(payload, "summary"),
  }),
  builder_task: (payload) => ({
    title: "Builder task",
    detail: readString(payload, "task"),
  }),
  builder_report: (payload) => ({
    title: "Builder reported back",
    detail: readString(payload, "report"),
  }),
  builder_failure: (payload) => ({
    title: "Builder turn failed",
    detail: readString(payload, "message") ?? readString(payload, "reason"),
  }),
  turn_started: (payload) => ({
    title: `${readString(payload, "actor") ?? "A turn"} started`,
    detail: null,
  }),
  halted: (payload) => ({
    title: `Halted: ${readString(payload, "kind") ?? "unknown"}`,
    detail: readString(payload, "message"),
  }),
  paused: (payload) => ({ title: "Paused", detail: readString(payload, "message") }),
  resumed: () => ({ title: "Resumed", detail: null }),
  recovered: (payload) => ({
    title: `Recovery: ${readString(payload, "choice") ?? "unknown"}`,
    detail: readString(payload, "message"),
  }),
  notice: (payload) => ({ title: "Note", detail: readString(payload, "message") }),
  run_finished: (payload) => ({
    title: "Run finished",
    detail: readString(payload, "summary"),
  }),
};

const FAILURE_KINDS: ReadonlySet<string> = new Set(["builder_failure", "halted"]);

export function describeEvent(event: PeerLoopEvent): PeerLoopEventPresentation {
  const payload = event.payload as PeerLoopEventPayloadLike;
  const recognised = RECOGNISED[payload.kind];
  if (recognised !== undefined) {
    const { title, detail } = recognised(payload);
    return {
      title,
      detail: detail === null ? null : truncate(detail),
      tone: FAILURE_KINDS.has(payload.kind) ? "warning" : "neutral",
    };
  }
  // Unfamiliar, and shown as such rather than pretending to understand it.
  return {
    title: `${ACTOR_LABEL[event.actor]}: ${payload.kind}`,
    detail: summariseUnknownPayload(payload),
    tone: "neutral",
  };
}

/* ------------------------------------------------------------- controls */

export interface PeerLoopControls {
  readonly canSendOwnerMessage: boolean;
  readonly canPause: boolean;
  readonly canResume: boolean;
  readonly canRecover: boolean;
  /**
   * True for an interrupted run nobody is currently driving.
   *
   * Recovery needs a live controller, so the honest answer here is "resume
   * first" rather than a Recover button that Peer Loop would refuse.
   */
  readonly resumeBeforeRecover: boolean;
  /** Why the live controls are off, when they are. Peer Loop's reason, not ours. */
  readonly unavailableReason: string | null;
}

const HELD_BY_OTHER =
  "Another Peer Loop process is driving this project. You can read the run here; nothing will be sent.";
const NOT_ATTACHED =
  "Peer Loop is not driving this run right now. Resume takes control; the other controls need it.";

const NO_CONTROLS = {
  canSendOwnerMessage: false,
  canPause: false,
  canResume: false,
  canRecover: false,
  resumeBeforeRecover: false,
} as const;

/**
 * Which controls Peer Loop will actually accept, from the snapshot it sent.
 *
 * THE THREE COMBINATIONS THAT EXIST, AND THEY ARE NOT INTERCHANGEABLE:
 *
 *   - `available: true` / `live_in_this_bridge` — this bridge is the live
 *     writer. Owner messages, pause and recovery are all live commands and are
 *     only offered here;
 *   - `available: false` / `held_by_other_process` — someone else holds the
 *     project lease. Entirely read-only. T3 Code does not signal, take over or
 *     shut down the other session;
 *   - `available: false` / `not_attached` — the ordinary snapshot of a stopped
 *     run. `resumable` says whether `run.resume` may take control, and that is
 *     the *only* thing offered: reading `available: false` as "nothing is
 *     possible" would leave every stopped run permanently unstartable.
 *
 * An interrupted run in that third state therefore shows Resume, not Recover.
 * Recovery is a live command; resuming establishes control first — and it does
 * not replay the interrupted task, which stays an explicit owner choice.
 */
export function describeControls(view: PeerLoopRunView): PeerLoopControls {
  const control = view.control;
  const state = view.state;
  if (control === null || state === null) return { ...NO_CONTROLS, unavailableReason: null };

  const terminal = state.state === "done" || state.state === "error";
  const interrupted = state.state === "interrupted";

  if (!control.available) {
    if (control.reason === "held_by_other_process") {
      return { ...NO_CONTROLS, unavailableReason: HELD_BY_OTHER };
    }
    // `not_attached`: nobody is driving. Resume is the way in, when Peer Loop
    // says the run can be resumed at all.
    const canResume = control.resumable && !terminal;
    return {
      ...NO_CONTROLS,
      canResume,
      resumeBeforeRecover: canResume && interrupted,
      unavailableReason: terminal ? null : NOT_ATTACHED,
    };
  }

  if (terminal) return { ...NO_CONTROLS, unavailableReason: null };

  return {
    // Queued for the next Reviewer turn, so it is legitimate whenever this
    // bridge is driving and the run can still move. Not while interrupted:
    // nothing will read the queue until the turn is resolved.
    canSendOwnerMessage: !interrupted,
    // Pause is a live command against the bridge that is driving.
    canPause: !interrupted,
    // Peer Loop says whether a run can be resumed. Nothing here infers it.
    canResume: control.resumable,
    canRecover: interrupted,
    resumeBeforeRecover: false,
    unavailableReason: null,
  };
}

/** True while the run is working, so a pause takes effect at a boundary. */
export function pauseTakesEffectLater(view: PeerLoopRunView): boolean {
  const state = view.state?.state;
  return state === "reviewer_working" || state === "builder_working";
}

export const RECOVERY_CHOICES = [
  {
    choice: "resume_to_reviewer",
    label: "Hand it back to the Reviewer",
    description:
      "The Reviewer looks at where things stand and decides the next task. The interrupted task is not run again.",
    confirm: false,
  },
  {
    choice: "replay_builder_task",
    label: "Run the interrupted task again",
    description:
      "The Builder is given the same task a second time. It may already have changed the repository, so this can repeat work that was partly done.",
    confirm: true,
  },
  {
    choice: "abandon",
    label: "Abandon the run",
    description: "Peer Loop stops here. Nothing else is run and the record is kept.",
    confirm: false,
  },
] as const;

export type PeerLoopRecoveryOption = (typeof RECOVERY_CHOICES)[number];

/* --------------------------------------------------------------- errors */

export interface PeerLoopErrorPresentation {
  readonly title: string;
  readonly detail: string | null;
  /** Peer Loop's stable refusal code, when there was one. */
  readonly code: string | null;
  readonly tone: PeerLoopTone;
  /** True when the command may have taken effect anyway. Never retried for you. */
  readonly mayHaveApplied: boolean;
}

const REFUSAL_TITLES: Readonly<Record<string, string>> = {
  CONTROL_UNAVAILABLE: "Another process is driving this project",
  PROJECT_HAS_UNFINISHED_RUN: "This project already has an unfinished run",
  REVIEWER_THREAD_BUSY: "The Reviewer conversation is held by another writer",
  INVALID_RUN_STATE: "The run is not in a state that allows this",
  RUN_NOT_FOUND: "Peer Loop does not know that run",
  CAPACITY_EXHAUSTED: "Agent capacity is exhausted",
  AUTH_REQUIRED: "An agent CLI needs signing in",
  INVALID_PARAMS: "Peer Loop rejected the request",
};

/**
 * What a client is told about a failed command.
 *
 * The refusal code travels because `CONTROL_UNAVAILABLE` and
 * `PROJECT_HAS_UNFINISHED_RUN` are different problems with different fixes, and
 * prose does not let an operator tell them apart. An unfamiliar code is shown
 * as itself rather than flattened into "something went wrong" — a newer Peer
 * Loop refusing for a new reason should still say which.
 */
export function describeError(error: PeerLoopError): PeerLoopErrorPresentation {
  switch (error._tag) {
    case "PeerLoopCommandRefusedError":
      return {
        title: REFUSAL_TITLES[error.code] ?? "Peer Loop refused this",
        detail: truncate(error.detail),
        code: error.code,
        tone: "warning",
        mayHaveApplied: false,
      };
    case "PeerLoopTimeoutError":
      return {
        title: "No answer in time",
        detail: error.mayHaveApplied
          ? "Peer Loop may still have accepted this and finished after T3 Code stopped waiting. Nothing was retried — re-read the run before trying again."
          : "Peer Loop did not answer in time.",
        code: null,
        tone: "warning",
        mayHaveApplied: error.mayHaveApplied,
      };
    case "PeerLoopUnavailableError":
      return {
        title: "Peer Loop is not available here",
        detail: truncate(error.reason),
        code: null,
        tone: "neutral",
        mayHaveApplied: false,
      };
    case "PeerLoopIncompatibleError":
      return {
        title: "This Peer Loop speaks a protocol this build does not",
        detail: truncate(error.detail),
        code: null,
        tone: "danger",
        mayHaveApplied: false,
      };
    case "PeerLoopTransportError":
      return {
        title: "The connection to Peer Loop ended",
        detail: truncate(error.detail),
        code: null,
        tone: "warning",
        mayHaveApplied: false,
      };
    case "PeerLoopProtocolError":
      return {
        title: "Peer Loop sent something this build could not read",
        detail: truncate(error.detail),
        code: null,
        tone: "danger",
        mayHaveApplied: false,
      };
  }
}

/** The structured run id a duplicate-run refusal points at, when it gave one. */
export function existingRunIdFromRefusal(error: PeerLoopError): string | null {
  if (error._tag !== "PeerLoopCommandRefusedError") return null;
  if (error.code !== "PROJECT_HAS_UNFINISHED_RUN") return null;
  const data = error.data;
  if (typeof data !== "object" || data === null) return null;
  const runId = (data as Record<string, unknown>)["runId"];
  return typeof runId === "string" && runId.length > 0 ? runId : null;
}

/* ------------------------------------------------------------ start form */

export interface StartRunValidation {
  readonly ok: boolean;
  readonly objectiveError: string | null;
  readonly safetyLimitError: string | null;
  readonly projectError: string | null;
}

/**
 * What can be sent, and why not.
 *
 * The objective is delivered word for word to the first Reviewer turn, so an
 * empty one is refused here rather than starting a run that immediately halts
 * asking for it. The safety limit is Peer Loop's own optional bound; a zero or
 * a fraction is a typo, not a limit.
 */
export function validateStartRun(input: {
  readonly projectId: string | null;
  readonly objective: string;
  readonly safetyLimit: string;
}): StartRunValidation {
  const objective = input.objective.trim();
  const safety = input.safetyLimit.trim();

  const projectError = input.projectId === null ? "Choose a project." : null;
  const objectiveError = objective.length === 0 ? "Say what this run should achieve." : null;

  let safetyLimitError: string | null = null;
  if (safety.length > 0) {
    if (!/^\d+$/u.test(safety) || Number(safety) < 1) {
      safetyLimitError = "Use a whole number of iterations, or leave this empty.";
    }
  }

  return {
    ok: projectError === null && objectiveError === null && safetyLimitError === null,
    objectiveError,
    safetyLimitError,
    projectError,
  };
}

export function parseSafetyLimit(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !/^\d+$/u.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return parsed >= 1 ? parsed : undefined;
}

/* ------------------------------------------------------------- snapshot */

export interface PeerLoopDetailSummary {
  readonly state: PeerLoopRunStateFile["state"] | null;
  readonly iteration: number | null;
  readonly reviewer: string | null;
  readonly builder: string | null;
  /** The actor whose turn was running when Peer Loop stopped, if any. */
  readonly inFlightActor: "reviewer" | "builder" | null;
  readonly currentTask: string | null;
  readonly lastDecision: string | null;
  readonly queuedOwnerMessages: number;
  readonly projectPath: string | null;
}

export function describeDetail(view: PeerLoopRunView): PeerLoopDetailSummary {
  const state = view.state;
  if (state === null) {
    return {
      state: null,
      iteration: null,
      reviewer: null,
      builder: null,
      inFlightActor: null,
      currentTask: null,
      lastDecision: null,
      queuedOwnerMessages: 0,
      projectPath: null,
    };
  }

  const decision = state.lastReviewerDecision;
  return {
    state: state.state,
    iteration: state.iteration,
    reviewer: state.adapters.reviewer,
    builder: state.adapters.builder,
    inFlightActor: state.inFlight?.actor ?? null,
    currentTask: state.lastBuilderTask,
    lastDecision: decision === null ? null : `${decision.decision} — ${truncate(decision.summary)}`,
    queuedOwnerMessages: state.queuedOwnerMessages.length,
    projectPath: state.projectPath,
  };
}

/* ------------------------------------------------- owner-facing structure */

export interface PeerLoopOwnerDecision {
  readonly question: string;
  readonly why: string;
  readonly options: readonly string[];
}

/**
 * The question the Reviewer escalated, as Peer Loop recorded it.
 *
 * Two places carry it and they are not redundant: the run outcome is what the
 * subscription reports the moment it happens, and `lastReviewerDecision` is what
 * the durable state file still holds afterwards. The outcome wins when both are
 * present; nothing is reconstructed from prose either way.
 */
export function describeOwnerDecision(view: PeerLoopRunView): PeerLoopOwnerDecision | null {
  const outcome = view.outcome;
  if (outcome?.kind === "owner_required") {
    return {
      question: truncate(outcome.question, PEER_LOOP_OWNER_TEXT_CHARS),
      why: truncate(outcome.why, PEER_LOOP_OWNER_TEXT_CHARS),
      options: boundedOptions(outcome.options),
    };
  }
  return describeOwnerDecisionFromRecord(view.state?.lastReviewerDecision ?? null);
}

/**
 * The same question, from a durable state file alone.
 *
 * Split out for a caller that has a snapshot and no subscription — a Navigator
 * child execution card reads `peerLoop.attachRun` and never attaches to the
 * event stream, so it has a `lastReviewerDecision` and no live outcome. It must
 * still read exactly as the advanced inspector does, which is why this is the
 * same function rather than a second one that drifts.
 *
 * The precedence above is unchanged: where there IS a live outcome it wins.
 */
export function describeOwnerDecisionFromRecord(
  decision: PeerLoopReviewerDecision | null | undefined,
): PeerLoopOwnerDecision | null {
  if (decision === null || decision === undefined) return null;
  if (decision.decision !== "OWNER_REQUIRED") return null;
  return {
    question: truncate(decision.ownerQuestion, PEER_LOOP_OWNER_TEXT_CHARS),
    why: truncate(decision.whyOwnerIsRequired, PEER_LOOP_OWNER_TEXT_CHARS),
    options: boundedOptions(decision.options),
  };
}

/** A question and its reasons get more room than a feed line, but not unbounded. */
export const PEER_LOOP_OWNER_TEXT_CHARS = 1_000;
/** However many options a Reviewer produced, a phone shows a workable number. */
export const PEER_LOOP_OWNER_OPTION_LIMIT = 8;

const boundedOptions = (options: readonly string[]): readonly string[] =>
  options
    .slice(0, PEER_LOOP_OWNER_OPTION_LIMIT)
    .map((option) => truncate(option, 200))
    .filter((option) => option.length > 0);

export interface PeerLoopFailureEvidence {
  readonly kind: "CAPACITY_EXHAUSTED" | "AUTH_REQUIRED" | "TRANSPORT_INTERRUPTED";
  readonly title: string;
  /** Peer Loop's own bounded excerpt of what the CLI said. */
  readonly evidence: string;
  readonly source: string;
  /** Only when the CLI actually stated one. Never invented. */
  readonly resetAt: string | null;
}

const FAILURE_TITLES: Readonly<Record<PeerLoopFailureEvidence["kind"], string>> = {
  CAPACITY_EXHAUSTED: "The Builder's capacity ran out",
  AUTH_REQUIRED: "The Builder CLI needs signing in",
  TRANSPORT_INTERRUPTED: "The Builder turn was cut off",
};

/**
 * What Peer Loop recorded about the last Builder failure.
 *
 * `resetAt` is null unless the CLI stated one, and its absence is shown as
 * "no reset time given" rather than as "no limit" — inventing a time here would
 * be T3 Code guessing at somebody's quota.
 */
export function describeFailureEvidence(view: PeerLoopRunView): PeerLoopFailureEvidence | null {
  const failure = view.state?.lastBuilderFailure ?? null;
  if (failure === null || failure === undefined) return null;
  return {
    kind: failure.kind,
    title: FAILURE_TITLES[failure.kind],
    evidence: truncate(failure.evidence, PEER_LOOP_EVIDENCE_CHARS),
    source: failure.source,
    resetAt: failure.resetAt,
  };
}

export const PEER_LOOP_EVIDENCE_CHARS = 600;

export interface PeerLoopCompletion {
  /** The Reviewer's own one-line summary of the finished run. */
  readonly summary: string | null;
  /** Where it left the repository, in the Reviewer's words. */
  readonly finalState: string | null;
}

/** A summary is a sentence, not a feed line, but it is still not unbounded. */
export const PEER_LOOP_COMPLETION_SUMMARY_CHARS = 600;
export const PEER_LOOP_FINAL_STATE_CHARS = 200;

/**
 * How a finished run finished, when Peer Loop recorded it.
 *
 * The live outcome first, then the durable Reviewer decision — the same
 * precedence as every other structured field here, because the outcome is what
 * the subscription reports the moment it happens and the state file is what
 * survives afterwards. Both are Peer Loop's own structured `DONE`; nothing is
 * read out of a Builder report, a prompt or the activity feed, and a run state
 * of "done" on its own produces nothing, because it says that it finished and
 * not how.
 */
export function describeCompletion(view: PeerLoopRunView): PeerLoopCompletion | null {
  const completed = (summary: string, finalState: string): PeerLoopCompletion => ({
    summary: nonEmpty(truncate(summary, PEER_LOOP_COMPLETION_SUMMARY_CHARS)),
    finalState: nonEmpty(truncate(finalState, PEER_LOOP_FINAL_STATE_CHARS)),
  });

  const outcome = view.outcome;
  if (outcome?.kind === "done") return completed(outcome.summary, outcome.finalState);
  return describeCompletionFromRecord(view.state?.lastReviewerDecision ?? null);
}

/**
 * How a run finished, from a durable state file alone. Same wording, same
 * bounds, same refusal to derive anything from a run state of "done" on its
 * own — that says it finished, not how. See {@link describeOwnerDecisionFromRecord}.
 */
export function describeCompletionFromRecord(
  decision: PeerLoopReviewerDecision | null | undefined,
): PeerLoopCompletion | null {
  if (decision === null || decision === undefined) return null;
  if (decision.decision !== "DONE") return null;
  return {
    summary: nonEmpty(truncate(decision.summary, PEER_LOOP_COMPLETION_SUMMARY_CHARS)),
    finalState: nonEmpty(truncate(decision.finalState, PEER_LOOP_FINAL_STATE_CHARS)),
  };
}

const nonEmpty = (value: string): string | null => (value.length === 0 ? null : value);

/**
 * The final state of a finished run, when Peer Loop recorded one.
 *
 * From the outcome first, then the durable Reviewer decision. Never derived
 * from the run state alone: "done" says it finished, not how.
 */
export function describeFinalState(view: PeerLoopRunView): string | null {
  return describeCompletion(view)?.finalState ?? null;
}
