import { useAtomValue } from "@effect/atom-react";
import { createFileRoute } from "@tanstack/react-router";

import { AgentRunList } from "../components/agentRuns/AgentRunList";
import { agentRunsListAtom } from "../state/agentRuns";

function AgentRunsIndexRoute() {
  const list = useAtomValue(agentRunsListAtom);
  return <AgentRunList data={list} />;
}

export const Route = createFileRoute("/agent-runs/")({
  component: AgentRunsIndexRoute,
});
