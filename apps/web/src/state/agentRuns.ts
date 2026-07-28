import type { AgentRunDetail, AgentRunsListResult } from "@t3tools/contracts";
import { createAgentRunsEnvironmentAtoms } from "@t3tools/client-runtime/state/agentRuns";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";

export const agentRunsEnvironment = createAgentRunsEnvironmentAtoms(connectionAtomRuntime);

/**
 * Runs are observed on the primary environment only.
 *
 * The orchestrator home is a directory on the machine running the T3Code
 * server. A cloud environment has no view of it, and pretending otherwise
 * would produce an empty list that looks like "no runs" rather than "not
 * here".
 */
const EMPTY_LIST: AgentRunsListResult = {
  configured: false,
  home: null,
  runs: [],
  unreadable: [],
};

export const agentRunsListAtom = Atom.make((get): AgentRunsListResult => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return EMPTY_LIST;
  return (
    Option.getOrNull(
      AsyncResult.value(get(agentRunsEnvironment.list({ environmentId, input: {} }))),
    ) ?? EMPTY_LIST
  );
}).pipe(Atom.withLabel("web-agent-runs-list"));

export const agentRunDetailAtom = Atom.family((runId: string) =>
  Atom.make((get): AgentRunDetail | null => {
    const environmentId = get(primaryEnvironmentIdAtom);
    if (environmentId === null) return null;
    return Option.getOrNull(
      AsyncResult.value(get(agentRunsEnvironment.detail({ environmentId, input: { runId } }))),
    );
  }).pipe(Atom.withLabel(`web-agent-run-detail:${runId}`)),
);
