import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { AGENT_RUN_ACK_STORAGE_KEY, decideAgentRunAlerts, withKeys } from "~/agentRunAlerts";
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

  useEffect(() => {
    // Nothing to baseline against yet; an empty list is not a cold start.
    if (runs.length === 0) return;

    const { alerts, silence } = decideAgentRunAlerts({
      runs,
      announced,
      firstLoad: !initialised,
    });

    if (alerts.length === 0 && silence.length === 0 && initialised) return;

    // Record everything decided in this pass *before* raising anything, so a
    // reload mid-toast cannot produce a second copy.
    setStore((current) => ({
      keys: current.keys,
      announced: withKeys(current.announced ?? [], [
        ...silence,
        ...alerts.map((alert) => alert.key),
      ]),
      initialised: true,
    }));

    for (const alert of alerts) {
      toastManager.add({
        type: alert.tone === "success" ? "success" : alert.tone === "failure" ? "error" : "warning",
        title: `${alert.title} ${alert.message}`,
        // No timeout for anything asking for a decision — a toast that
        // disappears on its own is not how you tell someone they are blocking
        // a run. Informational outcomes may fade.
        ...(alert.actionable ? { timeout: 0 } : { timeout: 8_000 }),
        actionProps: {
          children: "View run",
          onClick: () => {
            // Clicking through is the acknowledgement: it clears the badge,
            // separately from the announcement already recorded above.
            setStore((current) => ({
              keys: withKeys(current.keys, [alert.key]),
              announced: current.announced ?? [],
              initialised: current.initialised ?? true,
            }));
            void navigate({ to: "/agent-runs/$runId", params: { runId: alert.runId } });
          },
        },
      });
    }
  }, [runs, announced, initialised, navigate, setStore]);

  return null;
}
