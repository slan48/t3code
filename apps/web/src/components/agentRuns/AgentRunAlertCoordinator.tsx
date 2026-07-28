import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect, useRef } from "react";

import {
  AGENT_RUN_ACK_STORAGE_KEY,
  pendingAgentRunAlerts,
  withAcknowledgement,
} from "~/agentRunAlerts";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { agentRunsListAtom } from "~/state/agentRuns";
import { toastManager } from "../ui/toast";

export const AcknowledgementsSchema = Schema.Struct({ keys: Schema.Array(Schema.String) });

/**
 * Tells the operator when a run reaches a terminal state.
 *
 * Deliberately not a transition watcher. T3Code may have been closed, asleep,
 * or on another device when the run finished, and an alert that only fires
 * for transitions it personally witnessed would silently skip exactly the
 * cases this feature exists for. Instead it alerts on *unacknowledged terminal
 * state*, which survives a reload, a reconnect, and a phone that was in a
 * pocket.
 *
 * Acknowledgement is stored locally, per run *and* outcome. Nothing is written
 * back to the orchestrator: whether a human has looked at a browser tab is not
 * part of the engine's history.
 */
export function AgentRunAlertCoordinator() {
  const navigate = useNavigate();
  const runs = useAtomValue(agentRunsListAtom).runs;
  const [acknowledged, setAcknowledged] = useLocalStorage(
    AGENT_RUN_ACK_STORAGE_KEY,
    { keys: [] as readonly string[] },
    AcknowledgementsSchema,
  );

  // Guards against re-raising a toast on every poll while the operator has
  // simply not clicked it yet.
  const raised = useRef(new Set<string>());

  useEffect(() => {
    const alerts = pendingAgentRunAlerts(runs, acknowledged.keys);
    for (const alert of alerts) {
      if (raised.current.has(alert.key)) continue;
      raised.current.add(alert.key);

      toastManager.add({
        type: alert.tone === "success" ? "success" : alert.tone === "failure" ? "error" : "warning",
        title: `${alert.title} ${alert.message}`,
        // No timeout for anything asking for a decision — a toast that
        // disappears on its own is not how you tell someone they are blocking
        // a run.
        ...(alert.tone === "success" ? { timeout: 8_000 } : { timeout: 0 }),
        actionProps: {
          children: "View run",
          onClick: () => {
            setAcknowledged((current) => ({
              keys: withAcknowledgement(current.keys, alert.key),
            }));
            void navigate({ to: "/agent-runs/$runId", params: { runId: alert.runId } });
          },
        },
      });
    }
  }, [runs, acknowledged.keys, navigate, setAcknowledged]);

  return null;
}
