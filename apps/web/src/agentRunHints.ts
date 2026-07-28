/**
 * The one piece of setup an operator has to do outside the UI.
 *
 * A path to another tool's private state directory is not something a remote
 * client should be able to set, so it comes from the server's environment
 * rather than from settings. Stated here once so the empty state and the
 * technical details cannot drift apart.
 */
export const ORCHESTRATOR_HOME_ENV = "T3_ORCHESTRATOR_HOME";

export const ORCHESTRATOR_HOME_ENV_HINT = `${ORCHESTRATOR_HOME_ENV}=/path/to/project/.orchestrator t3`;
