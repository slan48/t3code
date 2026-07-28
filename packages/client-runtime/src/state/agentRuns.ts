import { AGENT_RUNS_DETAIL_POLL_MS, AGENT_RUNS_LIST_POLL_MS, WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * Agent-run observation atoms.
 *
 * Polled, not streamed. The orchestrator writes durable state at agent
 * boundaries — a worker cycle is minutes long — so a subscription would spend
 * its life idle in exchange for a second transport to maintain. Re-reading
 * every few seconds is the smaller mechanism and gives the same answer.
 *
 * `staleTimeMs` sits just under the refresh interval so a remount repaints
 * from cache instantly and then refreshes, rather than flashing a spinner at
 * an operator who only switched tabs.
 */
export function createAgentRunsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agent-runs:list",
      tag: WS_METHODS.agentRunsList,
      staleTimeMs: AGENT_RUNS_LIST_POLL_MS - 500,
      refreshIntervalMs: AGENT_RUNS_LIST_POLL_MS,
    }),
    detail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agent-runs:detail",
      tag: WS_METHODS.agentRunsGet,
      staleTimeMs: AGENT_RUNS_DETAIL_POLL_MS - 500,
      refreshIntervalMs: AGENT_RUNS_DETAIL_POLL_MS,
    }),
  };
}
