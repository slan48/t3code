import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect, useRef } from "react";

import {
  AGENT_RUN_ACK_STORAGE_KEY,
  decideAgentRunAlerts,
  deliverAgentRunAlerts,
  withKeys,
} from "~/agentRunAlerts";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { agentRunsListAtom } from "~/state/agentRuns";
import { toastManager } from "../ui/toast";

/**
 * Two lists, deliberately.
 *
 * `announced` is "a toast was shown for this transition", and it is what stops
 * a reload from replaying history. `keys` is "the operator dealt with it", and
 * it is what clears the badge. Conflating them is what made reloading the page
 * re-announce every terminal run that had never been clicked.
 *
 * `initialised` records that this browser has completed one pass over the run
 * list, so the first pass can absorb finished history silently instead of
 * announcing all of it at once.
 */
export const AcknowledgementsSchema = Schema.Struct({
  keys: Schema.Array(Schema.String),
  announced: Schema.optional(Schema.Array(Schema.String)),
  initialised: Schema.optional(Schema.Boolean),
});

/**
 * Tells the operator, once, when a run reaches a state worth knowing about.
 *
 * Not a transition watcher: T3Code may have been closed, asleep, or on another
 * device, and an alert that only fires for transitions it personally witnessed
 * would skip exactly the cases this exists for. But equally not a function of
 * current state alone, which is what replayed old news on every reload. What is
 * announced is a *transition it has not announced before*, identified by the
 * orchestrator's own durable event sequence.
 */
export function AgentRunAlertCoordinator() {
  const navigate = useNavigate();
  const runs = useAtomValue(agentRunsListAtom).runs;
  const [store, setStore] = useLocalStorage(
    AGENT_RUN_ACK_STORAGE_KEY,
    {
      keys: [] as readonly string[],
      announced: [] as readonly string[],
      initialised: false,
    },
    AcknowledgementsSchema,
  );

  const announced = store.announced ?? [];
  const initialised = store.initialised ?? false;

  /**
   * Keys already handed to the toast system by this mounted page.
   *
   * Survives StrictMode's double-invoked effects and every poll tick, so a
   * repeated pass cannot raise a second copy of a toast whose durable write
   * has not landed yet.
   */
  const deliveredRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    // Nothing to baseline against yet; an empty list is not a cold start.
    if (runs.length === 0) return;

    const decision = decideAgentRunAlerts({ runs, announced, firstLoad: !initialised });
    if (decision.alerts.length === 0 && decision.silence.length === 0 && initialised) return;

    const { announced: toRecord, delivered } = deliverAgentRunAlerts({
      decision,
      alreadyDelivered: deliveredRef.current,
      deliver: (alert) => {
        toastManager.add({
          type:
            alert.tone === "success" ? "success" : alert.tone === "failure" ? "error" : "warning",
          title: `${alert.title} ${alert.message}`,
          // No timeout for anything asking for a decision — a toast that
          // disappears on its own is not how you tell someone they are blocking
          // a run. Informational outcomes may fade.
          ...(alert.actionable ? { timeout: 0 } : { timeout: 8_000 }),
          actionProps: {
            children: "View run",
            onClick: () => {
              // Clicking through is the acknowledgement: it clears the badge,
              // separately from the announcement recorded on delivery.
              setStore((current) => ({
                keys: withKeys(current.keys, [alert.key]),
                announced: current.announced ?? [],
                initialised: current.initialised ?? true,
              }));
              void navigate({ to: "/agent-runs/$runId", params: { runId: alert.runId } });
            },
          },
        });
        return true;
      },
    });

    for (const key of delivered) deliveredRef.current.add(key);
    if (toRecord.length === 0 && initialised) return;

    // Recorded *after* the toast system has taken them, never before: an alert
    // that was not delivered stays unannounced and is retried next pass.
    setStore((current) => ({
      keys: current.keys,
      announced: withKeys(current.announced ?? [], toRecord),
      initialised: true,
    }));
  }, [runs, announced, initialised, navigate, setStore]);

  return null;
}
