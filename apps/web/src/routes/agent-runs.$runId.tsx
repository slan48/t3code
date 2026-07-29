import { useAtomValue } from "@effect/atom-react";
import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { AGENT_RUN_ACK_STORAGE_KEY, alertKey, withKeys } from "~/agentRunAlerts";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { AgentRunDetailView } from "../components/agentRuns/AgentRunDetailView";
import { Spinner } from "../components/ui/spinner";
import { agentRunDetailAtom } from "../state/agentRuns";

const AcknowledgementsSchema = Schema.Struct({
  keys: Schema.Array(Schema.String),
  announced: Schema.optional(Schema.Array(Schema.String)),
  initialised: Schema.optional(Schema.Boolean),
});

function AgentRunDetailRoute() {
  const { runId } = Route.useParams();
  const detail = useAtomValue(agentRunDetailAtom(runId));
  const [, setAcknowledged] = useLocalStorage(
    AGENT_RUN_ACK_STORAGE_KEY,
    {
      keys: [] as readonly string[],
      announced: [] as readonly string[],
      initialised: false,
    },
    AcknowledgementsSchema,
  );

  // Opening the run *is* the acknowledgement: it clears the badge for this exact
  // transition. It deliberately does not touch `announced`, which is what stops
  // a reload from re-toasting.
  const summary = detail?.summary ?? null;
  useEffect(() => {
    if (summary === null) return;
    const key = alertKey(summary);
    setAcknowledged((current) => ({
      keys: withKeys(current.keys, [key]),
      announced: current.announced ?? [],
      initialised: current.initialised ?? false,
    }));
  }, [summary, setAcknowledged]);

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
