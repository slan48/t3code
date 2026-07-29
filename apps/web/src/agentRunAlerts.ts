import type { AgentRunSummary } from "@t3tools/contracts";

/**
 * What the operator is told about a run, and when they are told it once.
 *
 * The bug this exists to kill: reloading the page replayed every terminal
 * toast, including for runs that finished days ago. On a phone, where reloading
 * is how you check whether anything changed, that made the cockpit unusable —
 * the act of looking produced a wall of notifications about things already
 * known.
 *
 * The fix separates two things that were one:
 *
 *   announced     — a toast has been shown for this transition. Durable, so a
 *                   reload does not show it again.
 *   acknowledged  — the operator has actually dealt with it. Drives the badge.
 *
 * Announcement is keyed by *transition*, not by run. A run that goes
 * HUMAN_REQUIRED → resolved → FAILED → recovered → COMPLETED reaches several
 * announceable states, and each is genuinely new information. The key uses the
 * orchestrator's durable event sequence, which is monotonic and survives
 * everything; a client-side timestamp would make the same outcome look new on
 * every poll.
 *
 * Nothing here is written back to the orchestrator. Whether a human has glanced
 * at a browser tab is not part of the engine's history.
 */

export const AGENT_RUN_ACK_STORAGE_KEY = "t3code:agent-run-acknowledgements:v2";

export interface AgentRunAlert {
  readonly key: string;
  readonly runId: string;
  readonly title: string;
  readonly message: string;
  readonly tone: "success" | "attention" | "failure";
  /** True when the operator is blocking something, not merely informed. */
  readonly actionable: boolean;
}

/**
 * Identity of one announceable transition.
 *
 * `lastEventSeq` is the orchestrator's own durable sequence number. Two
 * different outcomes of the same run always differ; the same outcome observed
 * twice never does.
 */
export function alertKey(run: AgentRunSummary): string {
  return `${run.id}::${run.lastEventSeq}::${run.state}`;
}

/** Terminal or parked: the states worth telling someone about. */
function isAnnounceable(run: AgentRunSummary): boolean {
  return run.terminal || run.state === "RECOVERY_REQUIRED";
}

/**
 * How many toasts may be raised at once.
 *
 * Opening the cockpit after a week away should not bury the app. Past this
 * point the badge carries the count and the run list carries the detail, which
 * is a better way to read six outcomes than six toasts fighting for a corner.
 */
export const MAX_CONCURRENT_ALERTS = 3;

export interface AlertDecision {
  /** Toasts to raise now. */
  readonly alerts: readonly AgentRunAlert[];
  /**
   * Keys to record as announced without showing anything.
   *
   * This is the first-load baseline: history that was already over before the
   * cockpit opened is absorbed silently, so it never toasts — not now, and not
   * on any later reload.
   */
  readonly silence: readonly string[];
}

export interface AlertInput {
  readonly runs: readonly AgentRunSummary[];
  readonly announced: readonly string[];
  /**
   * True the first time this browser sees any runs at all.
   *
   * On that pass, finished history is absorbed silently — except for runs still
   * *actively asking* for something, which are announced once because the
   * request is still open and was simply made while nobody was looking.
   */
  readonly firstLoad: boolean;
}

export function decideAgentRunAlerts(input: AlertInput): AlertDecision {
  const seen = new Set(input.announced);
  const alerts: AgentRunAlert[] = [];
  const silence: string[] = [];

  for (const run of input.runs) {
    if (!isAnnounceable(run)) continue;
    const key = alertKey(run);
    if (seen.has(key)) continue;

    // Finished history discovered on a cold start is absorbed, not announced.
    // A run still waiting on a decision is announced even then: the ask is
    // open, and "you were not watching" must not mean "you never find out".
    if (input.firstLoad && !run.attention.actionable) {
      silence.push(key);
      continue;
    }

    if (alerts.length >= MAX_CONCURRENT_ALERTS) {
      // Over the cap, but still recorded as announced so the next reload does
      // not surface it as though it were new.
      silence.push(key);
      continue;
    }

    alerts.push({
      key,
      runId: run.id,
      title: run.title,
      message: alertMessage(run),
      tone: alertTone(run),
      actionable: run.attention.actionable,
    });
  }

  return { alerts, silence };
}

function alertTone(run: AgentRunSummary): "success" | "attention" | "failure" {
  if (run.state === "COMPLETED") return "success";
  if (run.attention.actionable) return "attention";
  return "failure";
}

function alertMessage(run: AgentRunSummary): string {
  switch (run.attention.kind) {
    case "product-decision":
      return "needs a product decision";
    case "orchestrator-recovery":
      return "needs orchestrator recovery";
    case "run-failed":
      return run.state === "TIMED_OUT" ? "timed out" : "stopped without completing";
    default:
      return run.state === "COMPLETED" ? "completed" : "finished";
  }
}

/* --------------------------------------------------------------- delivery */

/**
 * Handing a decision to the toast system, and only then calling it announced.
 *
 * `decideAgentRunAlerts` says what the operator should be told; it cannot know
 * whether the telling worked. That distinction matters because the toast
 * manager underneath is a bare event emitter: `add()` notifies whatever
 * listeners exist at that instant and returns an id whether or not anybody was
 * listening, and it never replays. A provider attaches its listener from an
 * effect, so there are real windows — a StrictMode remount, for one — in which
 * nobody is. Treating the returned id as delivery would mark an escalation
 * told, durably, when it was in fact dropped, and it would never be raised
 * again.
 *
 * So delivery reports back. An alert is recorded only when the channel
 * accepted it; one that was not accepted stays unannounced and is retried on
 * the next pass. Silenced history needs no delivery and is recorded straight
 * away.
 *
 * `alreadyDelivered` keeps this idempotent within a mounted session — under
 * StrictMode's double-invoked effects, re-renders and the three-second poll —
 * so a repeated pass cannot raise a second copy of a toast whose durable write
 * has not landed yet. Across a reload, `announced` does that job. The gap
 * between the two is a crash in the microseconds between raising and
 * persisting, which costs at most one duplicate; the alternative ordering
 * costs a permanently missed HUMAN_REQUIRED, which is far worse.
 */
export interface AlertDeliveryInput {
  readonly decision: AlertDecision;
  /** Keys this mounted session has already handed to the toast system. */
  readonly alreadyDelivered: ReadonlySet<string>;
  /**
   * Hand one alert to the toast system.
   *
   * Must return false when the notification could not be accepted, so the
   * alert is retried rather than silently recorded as told.
   */
  readonly deliver: (alert: AgentRunAlert) => boolean;
}

export interface AlertDeliveryResult {
  /** Keys safe to persist as announced. */
  readonly announced: readonly string[];
  /** Keys handed to the toast system in this pass. */
  readonly delivered: readonly string[];
}

export function deliverAgentRunAlerts(input: AlertDeliveryInput): AlertDeliveryResult {
  const announced: string[] = [...input.decision.silence];
  const delivered: string[] = [];

  for (const alert of input.decision.alerts) {
    if (input.alreadyDelivered.has(alert.key)) continue;
    if (!input.deliver(alert)) continue;
    delivered.push(alert.key);
    announced.push(alert.key);
  }

  return { announced, delivered };
}

/**
 * The sidebar badge: what is actionable *now*.
 *
 * Not "terminal outcomes this browser has not clicked". The badge previously
 * showed 5 because five historical runs had never been acknowledged, which is
 * not a number anyone can act on. A finished run belongs in the list; only a
 * run actually waiting on a person belongs in the badge.
 */
export function agentRunBadgeCount(
  runs: readonly AgentRunSummary[],
  acknowledged: readonly string[],
): number {
  const seen = new Set(acknowledged);
  return runs.filter((run) => run.attention.actionable && !seen.has(alertKey(run))).length;
}

/** Keep the stored keys from growing without bound. */
export const MAX_ACKNOWLEDGEMENTS = 200;

export function withKeys(existing: readonly string[], added: readonly string[]): readonly string[] {
  if (added.length === 0) return existing;
  const merged = [...existing];
  for (const key of added) if (!merged.includes(key)) merged.push(key);
  return merged.slice(-MAX_ACKNOWLEDGEMENTS);
}
