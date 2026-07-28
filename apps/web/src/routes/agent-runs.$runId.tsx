import { useAtomValue } from "@effect/atom-react";
import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import {
  AGENT_RUN_ACK_STORAGE_KEY,
  acknowledgementKey,
  withAcknowledgement,
} from "~/agentRunAlerts";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { AgentRunDetailView } from "../components/agentRuns/AgentRunDetailView";
import { Spinner } from "../components/ui/spinner";
import { agentRunDetailAtom } from "../state/agentRuns";

const AcknowledgementsSchema = Schema.Struct({ keys: Schema.Array(Schema.String) });

function AgentRunDetailRoute() {
  const { runId } = Route.useParams();
  const detail = useAtomValue(agentRunDetailAtom(runId));
  const [, setAcknowledged] = useLocalStorage(
    AGENT_RUN_ACK_STORAGE_KEY,
    { keys: [] as readonly string[] },
    AcknowledgementsSchema,
  );

  // Opening the run *is* the acknowledgement. Making the operator also dismiss
  // a banner they have just read would be asking twice for the same signal.
  const state = detail?.summary.state ?? null;
  useEffect(() => {
    if (state === null) return;
    setAcknowledged((current) => ({
      keys: withAcknowledgement(current.keys, acknowledgementKey({ id: runId, state })),
    }));
  }, [runId, state, setAcknowledged]);

  if (detail === null) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
        <Spinner className="size-4" />
        Reading run evidence…
      </div>
    );
  }

  return <AgentRunDetailView detail={detail} />;
}

export const Route = createFileRoute("/agent-runs/$runId")({
  component: AgentRunDetailRoute,
});
