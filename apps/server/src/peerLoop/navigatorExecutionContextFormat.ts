/**
 * Turning Peer Loop's structured records into the block a Navigator turn sees.
 *
 * Pure, so the part that actually matters — what reaches a provider — is
 * assertable without a bridge, a projection or a layer. Three rules shape all
 * of it:
 *
 *   - **Narrowed by construction.** A run summary carries a project path, an
 *     adapter identity and a sequence number; none of them belong in a provider
 *     request, so {@link factsFromSummary} projects the summary down to the
 *     fields that do, and the serializer can only see those. Excluding a field
 *     by remembering not to print it is a rule somebody breaks in six months.
 *   - **Bounded everywhere.** Per link, per attachment, per Reviewer field, per
 *     option, and in total. An unbounded context is a way for arbitrary
 *     repository text to reach a model on every turn.
 *   - **Observations, not authorization.** The heading says so, and the frame
 *     text below says it again in the words the model reads.
 *
 * NOTHING HERE IS DERIVED FROM PROSE. Every fact comes from Peer Loop's own
 * structured state: no Builder report is parsed, no prompt is read, no activity
 * event is consulted.
 *
 * @module NavigatorExecutionContextFormat
 */
import type {
  OrchestrationPeerLoopExecution,
  PeerLoopRunStateFile,
  PeerLoopRunSummary,
} from "@t3tools/contracts";

/* --------------------------------------------------------------- bounds */

/** How many linked executions one turn describes. Newest first. */
export const NAVIGATOR_CONTEXT_MAX_LINKS = 8;
/**
 * How many of those get a second, structured read.
 *
 * Each one is a `run.attach` against the bridge. Four is enough for "what
 * happened" while keeping a Navigator turn's cost flat no matter how long the
 * conversation's history grows.
 */
export const NAVIGATOR_CONTEXT_MAX_ATTACHMENTS = 4;
/** The whole block. A deterministic marker replaces whatever does not fit. */
export const NAVIGATOR_CONTEXT_MAX_CHARS = 12_000;

export const NAVIGATOR_CONTEXT_SUMMARY_CHARS = 600;
export const NAVIGATOR_CONTEXT_FINAL_STATE_CHARS = 200;
export const NAVIGATOR_CONTEXT_QUESTION_CHARS = 1_000;
export const NAVIGATOR_CONTEXT_OPTION_CHARS = 200;
export const NAVIGATOR_CONTEXT_OPTION_LIMIT = 8;
/** A git ref is short. Anything longer is not one. */
export const NAVIGATOR_CONTEXT_REF_CHARS = 64;

export const NAVIGATOR_CONTEXT_TRUNCATION_MARKER = "[context truncated]";

export const NAVIGATOR_CONTEXT_HEADING =
  "Linked Peer Loop executions (structured, read-only context)";

/**
 * What the model is told about what it is reading.
 *
 * Every sentence is load-bearing. The failure this prevents is a Navigator that
 * has just been handed a run's state describing itself as having done something
 * to that run — "I approved it", "I resumed it" — which is false, and which an
 * owner reading the conversation would have no way to check.
 */
const CONTEXT_PREAMBLE = [
  "These are observations read from Peer Loop's own structured records. They are",
  "not authorization, and reading them changes nothing.",
  "",
  "You may explain or summarize them for the Owner in plain language. You must",
  "not claim that you approved, resumed, recovered, paused, messaged or otherwise",
  "changed any run — you did not, and you cannot from this conversation. Owner",
  "decisions and recovery stay in T3 Code's explicit Peer Loop controls.",
].join("\n");

/** Said instead of the list when Peer Loop could not be read at all. */
export const NAVIGATOR_CONTEXT_STATUS_UNAVAILABLE =
  "Structured execution status is unavailable right now, so nothing can be said about the state of these runs. Say so plainly if the Owner asks.";

/** Said when the conversation's project cannot be resolved. */
export const NAVIGATOR_CONTEXT_RECORDS_UNAVAILABLE =
  "Execution records are unavailable for this conversation right now. Say so plainly if the Owner asks.";

/* ---------------------------------------------------------------- facts */

/**
 * The mutable facts about one run that may reach a provider.
 *
 * Deliberately a projection, not the summary. `projectPath`, the adapter
 * identity, the live writer's pid and host, and the durable sequence number are
 * all in a `PeerLoopRunSummary` and none of them are the model's business.
 */
export interface NavigatorExecutionFacts {
  readonly state: PeerLoopRunSummary["state"];
  readonly iteration: number;
  readonly updatedAt: string;
  /** Peer Loop's own halt kind. Never its message, which is free text. */
  readonly haltKind: string | null;
  readonly queuedOwnerMessages: number;
  readonly hasLiveWriter: boolean;
  /**
   * True only when a writer exists, it is this process, AND Peer Loop says the
   * run is live in this bridge.
   *
   * BOTH SIGNALS, because they answer different questions and can disagree.
   * `liveWriter.isThisProcess` is about who holds the project's lease;
   * `liveInThisBridge` is about this run. Either one alone would let T3 Code
   * tell a model it is driving a run that another process is actually driving.
   */
  readonly liveWriterIsThisBridge: boolean;
}

export function factsFromSummary(summary: PeerLoopRunSummary): NavigatorExecutionFacts {
  return {
    state: summary.state,
    iteration: summary.iteration,
    updatedAt: summary.updatedAt,
    haltKind: summary.haltReason?.kind ?? null,
    queuedOwnerMessages: summary.queuedOwnerMessages,
    hasLiveWriter: summary.liveWriter !== null,
    // Peer Loop's own two answers, and both must agree. See the field's doc.
    liveWriterIsThisBridge:
      summary.liveWriter !== null && summary.liveWriter.isThisProcess && summary.liveInThisBridge,
  };
}

/* ------------------------------------------------------------- entries */

export type NavigatorExecutionDetail =
  | { readonly kind: "none" }
  /** Attach failed, or the snapshot carried no structured decision. */
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "done";
      readonly summary: string;
      readonly finalState: string;
      readonly head: string | null;
      readonly branch: string | null;
    }
  | {
      readonly kind: "owner-required";
      readonly question: string;
      readonly why: string;
      readonly options: ReadonlyArray<string>;
    };

export interface NavigatorExecutionEntry {
  readonly runId: string;
  readonly proposedPlanId: string;
  /** When T3 Code recorded the link — not when Peer Loop started the run. */
  readonly linkedAt: string;
  /** Null when Peer Loop's list does not carry this run at all. */
  readonly facts: NavigatorExecutionFacts | null;
  /** True when Peer Loop named this run as one it could not read. */
  readonly unreadable: boolean;
  readonly detail: NavigatorExecutionDetail;
}

/* ----------------------------------------------------------- selection */

/**
 * The most recent links, newest first, deterministically.
 *
 * `createdAt` descending, then run id ascending. The tie-break is not cosmetic:
 * two links recorded in the same millisecond would otherwise order by whatever
 * the projection happened to return, and a context that reorders between turns
 * reads to a model as though something changed.
 */
export function selectRecentExecutionLinks(
  links: ReadonlyArray<OrchestrationPeerLoopExecution>,
  limit: number = NAVIGATOR_CONTEXT_MAX_LINKS,
): ReadonlyArray<OrchestrationPeerLoopExecution> {
  return links
    .toSorted(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.runId.localeCompare(right.runId),
    )
    .slice(0, Math.max(0, limit));
}

/** States where a second, structured read tells the Owner something new. */
const ATTACH_WORTHY: ReadonlySet<PeerLoopRunSummary["state"]> = new Set(["done", "owner_required"]);

export function shouldAttachForFacts(facts: NavigatorExecutionFacts | null): boolean {
  return facts !== null && ATTACH_WORTHY.has(facts.state);
}

/**
 * Which of the selected links get a `run.attach`, in list order.
 *
 * The list is already newest-first, so taking the first qualifying four is
 * "the most recent qualifying runs" without a second sort.
 */
export function selectAttachTargets(
  entries: ReadonlyArray<{
    readonly runId: string;
    readonly facts: NavigatorExecutionFacts | null;
  }>,
  limit: number = NAVIGATOR_CONTEXT_MAX_ATTACHMENTS,
): ReadonlyArray<string> {
  return entries
    .filter((entry) => shouldAttachForFacts(entry.facts))
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.runId);
}

/* ---------------------------------------------------------- attachment */

const bounded = (value: string, limit: number): string => {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
};

const boundedRef = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : bounded(trimmed, NAVIGATOR_CONTEXT_REF_CHARS);
};

/**
 * The structured detail in a run's durable snapshot, and nothing else.
 *
 * Only `lastReviewerDecision` and `repo` are read. `lastBuilderTask`,
 * `lastBuilderReport`, `ownerPolicyText` and the queued message bodies are all
 * present on the same object and are all free text somebody else wrote; none of
 * them is a structured answer to "what happened", and manufacturing one out of
 * them is exactly the mistake this avoids.
 */
export function detailFromSnapshot(input: {
  readonly state: PeerLoopRunStateFile;
  readonly expected: "done" | "owner-required";
}): NavigatorExecutionDetail {
  const decision = input.state.lastReviewerDecision;
  if (decision === null || decision === undefined) return { kind: "unavailable" };

  if (input.expected === "done") {
    if (decision.decision !== "DONE") return { kind: "unavailable" };
    return {
      kind: "done",
      summary: bounded(decision.summary, NAVIGATOR_CONTEXT_SUMMARY_CHARS),
      finalState: bounded(decision.finalState, NAVIGATOR_CONTEXT_FINAL_STATE_CHARS),
      head: boundedRef(input.state.repo?.head),
      branch: boundedRef(input.state.repo?.branch),
    };
  }

  if (decision.decision !== "OWNER_REQUIRED") return { kind: "unavailable" };
  return {
    kind: "owner-required",
    question: bounded(decision.ownerQuestion, NAVIGATOR_CONTEXT_QUESTION_CHARS),
    why: bounded(decision.whyOwnerIsRequired, NAVIGATOR_CONTEXT_QUESTION_CHARS),
    options: decision.options
      .slice(0, NAVIGATOR_CONTEXT_OPTION_LIMIT)
      .map((option) => bounded(option, NAVIGATOR_CONTEXT_OPTION_CHARS))
      .filter((option) => option.length > 0),
  };
}

/* --------------------------------------------------------- serialization */

const liveWriterLine = (facts: NavigatorExecutionFacts): string => {
  if (!facts.hasLiveWriter) return "no";
  return facts.liveWriterIsThisBridge ? "yes (this bridge)" : "yes (another process)";
};

function renderEntry(entry: NavigatorExecutionEntry, index: number): string {
  const lines: string[] = [
    `${index + 1}. run ${entry.runId}`,
    `   proposal: ${entry.proposedPlanId}`,
    `   linked at: ${entry.linkedAt}`,
  ];

  if (entry.facts === null) {
    lines.push(
      entry.unreadable
        ? "   status: Peer Loop could not read this run's record."
        : "   status: Peer Loop is not currently listing this run. Nothing is known about its state.",
    );
    return lines.join("\n");
  }

  const facts = entry.facts;
  lines.push(
    `   state: ${facts.state}; iteration: ${String(facts.iteration)}; updated at: ${facts.updatedAt}`,
    `   halt: ${facts.haltKind ?? "none"}; queued owner messages: ${String(facts.queuedOwnerMessages)}`,
    `   live writer: ${liveWriterLine(facts)}`,
  );

  const detail = entry.detail;
  if (detail.kind === "unavailable") {
    lines.push("   structured detail unavailable");
  } else if (detail.kind === "done") {
    lines.push(`   reviewer summary: ${detail.summary}`);
    lines.push(`   final state: ${detail.finalState}`);
    if (detail.head !== null) {
      lines.push(
        `   repository: HEAD ${detail.head}${detail.branch === null ? "" : ` on ${detail.branch}`}`,
      );
    }
  } else if (detail.kind === "owner-required") {
    lines.push(`   owner question: ${detail.question}`);
    lines.push(`   why the owner is required: ${detail.why}`);
    for (const option of detail.options) lines.push(`   option: ${option}`);
  }

  return lines.join("\n");
}

/**
 * The whole block, or null when there is nothing to say.
 *
 * Null — not an empty section — for a conversation with no links, so a thread
 * that has never executed anything receives the static frame byte for byte.
 */
export function renderNavigatorExecutionContext(input: {
  readonly entries: ReadonlyArray<NavigatorExecutionEntry>;
  /**
   * Why the entries are thin, when they are.
   *
   * `records-unavailable`: the project could not be resolved.
   * `status-unavailable`: Peer Loop's list could not be read.
   */
  readonly degraded?: "records-unavailable" | "status-unavailable" | undefined;
}): string | null {
  if (input.entries.length === 0 && input.degraded === undefined) return null;

  const sections: string[] = [NAVIGATOR_CONTEXT_HEADING, "", CONTEXT_PREAMBLE];
  if (input.degraded === "records-unavailable") {
    sections.push("", NAVIGATOR_CONTEXT_RECORDS_UNAVAILABLE);
  } else if (input.degraded === "status-unavailable") {
    sections.push("", NAVIGATOR_CONTEXT_STATUS_UNAVAILABLE);
  }
  for (const [index, entry] of input.entries.entries()) {
    sections.push("", renderEntry(entry, index));
  }

  const rendered = sections.join("\n");
  if (rendered.length <= NAVIGATOR_CONTEXT_MAX_CHARS) return rendered;
  // Deterministic: cut to the budget minus the marker, then say so. A model
  // reading a silently-clipped block would treat a half-sentence as a fact.
  const room = NAVIGATOR_CONTEXT_MAX_CHARS - NAVIGATOR_CONTEXT_TRUNCATION_MARKER.length - 1;
  return `${rendered.slice(0, Math.max(0, room))}\n${NAVIGATOR_CONTEXT_TRUNCATION_MARKER}`;
}
