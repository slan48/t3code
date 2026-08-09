/**
 * Which program T3Code spawns for Peer Loop, and with exactly which arguments.
 *
 * Three properties matter here and none of them are negotiable:
 *
 *   - **Machine-local.** The executable is configured by the operator of this
 *     machine, through the environment or `local.json`. There is no RPC that
 *     sets it, and the resolved path is never sent to a client — a client
 *     authorized over Tailscale from a phone has no business naming a program
 *     for this machine to run.
 *   - **No shell.** The command and its arguments are separate values passed
 *     straight to the spawner. Nothing here parses a command string, and there
 *     is no interpolation anywhere near a shell.
 *   - **Exactly one command.** Every resolution ends in `bridge --stdio`. There
 *     is no path through this module that runs Peer Loop any other way.
 *
 * @module PeerLoopCommand
 */
import type { PeerLoopExecutableSource } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { loadLocalConfig, readConfiguredPath } from "../localConfig.ts";

/** The subcommand. Appended to every resolution; never configurable. */
export const PEER_LOOP_BRIDGE_ARGS = ["bridge", "--stdio"] as const;

/** The name looked up on PATH when nothing is configured. */
export const PEER_LOOP_DEFAULT_EXECUTABLE = "peer-loop";

export const PEER_LOOP_EXECUTABLE_ENV = "T3_PEER_LOOP_EXECUTABLE";
export const PEER_LOOP_NODE_ENTRY_ENV = "T3_PEER_LOOP_NODE_ENTRY";
export const PEER_LOOP_STOP_TIMEOUT_ENV = "T3_PEER_LOOP_STOP_TIMEOUT_SECONDS";

/**
 * Bounds on the machine-local stop timeout.
 *
 * A floor because anything shorter than a minute cannot mean "let the turn
 * finish"; a ceiling because a server shutdown must still terminate.
 */
export const PEER_LOOP_STOP_TIMEOUT_MIN_SECONDS = 60;
export const PEER_LOOP_STOP_TIMEOUT_MAX_SECONDS = 3_600;

export interface PeerLoopCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly source: PeerLoopExecutableSource;
}

/**
 * Read the machine-local stop timeout, or null to use the default.
 *
 * A value outside the sane range, or one that is not a number at all, is
 * ignored rather than obeyed: a typo must not turn shutdown into either an
 * instant kill or an unbounded hang.
 */
export function readStopTimeoutSeconds(
  fromEnv: string | undefined,
  fromFile: number | undefined,
): number | null {
  const parsedEnv = fromEnv === undefined ? Number.NaN : Number.parseInt(fromEnv.trim(), 10);
  const candidate = Number.isFinite(parsedEnv) ? parsedEnv : fromFile;
  if (candidate === undefined || !Number.isFinite(candidate)) return null;
  const rounded = Math.round(candidate);
  return rounded >= PEER_LOOP_STOP_TIMEOUT_MIN_SECONDS &&
    rounded <= PEER_LOOP_STOP_TIMEOUT_MAX_SECONDS
    ? rounded
    : null;
}

/**
 * Everything machine-local this integration needs, read in one pass.
 *
 * The stop timeout rides along with the executable because both come out of the
 * same `local.json` and both are true of one machine for as long as it is up.
 * Resolving them together means one read and no chance of the two answers
 * coming from different moments.
 */
export type PeerLoopCommandResolution =
  | {
      readonly kind: "resolved";
      readonly command: PeerLoopCommand;
      /** Machine-local override in seconds, or null for the documented default. */
      readonly stopTimeoutSeconds: number | null;
    }
  /**
   * Something was configured and cannot be used. Distinct from "nothing is
   * configured": an operator who typed a relative path needs to be told, not
   * silently fall back to PATH and then wonder which build ran.
   */
  | {
      readonly kind: "invalid";
      readonly source: PeerLoopExecutableSource;
      readonly reason: string;
      readonly stopTimeoutSeconds: number | null;
    };

/**
 * An executable name or absolute path.
 *
 * A bare name (`peer-loop`) is fine and is resolved by the spawner on PATH. A
 * value with a separator must be absolute: a relative path would be resolved
 * against whatever the server's working directory happens to be, which is not
 * something an operator can reason about from a config file.
 */
function validateExecutable(
  value: string,
  source: PeerLoopExecutableSource,
  isAbsolute: (path: string) => boolean,
  stopTimeoutSeconds: number | null,
): PeerLoopCommandResolution {
  if (value.includes("/") || value.includes("\\")) {
    return isAbsolute(value)
      ? {
          kind: "resolved",
          command: { command: value, args: PEER_LOOP_BRIDGE_ARGS, source },
          stopTimeoutSeconds,
        }
      : {
          kind: "invalid",
          source,
          reason: "a Peer Loop executable path must be absolute",
          stopTimeoutSeconds,
        };
  }
  return {
    kind: "resolved",
    command: { command: value, args: PEER_LOOP_BRIDGE_ARGS, source },
    stopTimeoutSeconds,
  };
}

/**
 * A Node entry file, run with this server's own `process.execPath`.
 *
 * Absolute only, and it must look like a JavaScript entry point. The check is
 * not a security boundary — the operator already chose what to run — it is
 * there so a typo fails with a sentence instead of an opaque spawn error.
 */
function validateNodeEntry(
  value: string,
  source: PeerLoopExecutableSource,
  execPath: string,
  isAbsolute: (path: string) => boolean,
  stopTimeoutSeconds: number | null,
): PeerLoopCommandResolution {
  if (!isAbsolute(value)) {
    return {
      kind: "invalid",
      source,
      reason: "a Peer Loop Node entry path must be absolute",
      stopTimeoutSeconds,
    };
  }
  if (!/\.[cm]?js$/.test(value)) {
    return {
      kind: "invalid",
      source,
      reason: "a Peer Loop Node entry must be a .js, .mjs or .cjs file",
      stopTimeoutSeconds,
    };
  }
  return {
    kind: "resolved",
    command: { command: execPath, args: [value, ...PEER_LOOP_BRIDGE_ARGS], source },
    stopTimeoutSeconds,
  };
}

/**
 * Resolve the command, in precedence order.
 *
 *   1. `T3_PEER_LOOP_EXECUTABLE`
 *   2. `T3_PEER_LOOP_NODE_ENTRY`
 *   3. `peerLoopExecutable` in `local.json`
 *   4. `peerLoopNodeEntry` in `local.json`
 *   5. `peer-loop` on PATH
 *
 * The environment wins so a developer can aim one shell at one build without
 * editing the installed app's config; the file exists because an app launched
 * from Finder never sees a login shell. The PATH default is last so an ordinary
 * install needs no configuration at all.
 *
 * The first source that is *present* decides, even if it turns out to be
 * invalid. Falling through from a bad value to the next source would run a
 * different Peer Loop than the operator asked for and say nothing about it.
 */
export const resolvePeerLoopCommand = Effect.fn("peerLoop.resolveCommand")(function* (
  localConfigPath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  execPath: string = process.execPath,
) {
  const path = yield* Path.Path;
  const isAbsolute = (value: string) => path.isAbsolute(value);

  // Read once: both answers come out of the same file, and the executable
  // question is settled before the environment is consulted for either.
  const local = yield* loadLocalConfig(localConfigPath);
  const stopTimeoutSeconds = readStopTimeoutSeconds(
    env[PEER_LOOP_STOP_TIMEOUT_ENV],
    local.peerLoopStopTimeoutSeconds,
  );

  const envExecutable = readConfiguredPath(env[PEER_LOOP_EXECUTABLE_ENV]);
  if (envExecutable !== null) {
    return validateExecutable(envExecutable, "env-executable", isAbsolute, stopTimeoutSeconds);
  }

  const envNodeEntry = readConfiguredPath(env[PEER_LOOP_NODE_ENTRY_ENV]);
  if (envNodeEntry !== null) {
    return validateNodeEntry(
      envNodeEntry,
      "env-node-entry",
      execPath,
      isAbsolute,
      stopTimeoutSeconds,
    );
  }

  const fileExecutable = readConfiguredPath(local.peerLoopExecutable);
  if (fileExecutable !== null) {
    return validateExecutable(
      fileExecutable,
      "local-config-executable",
      isAbsolute,
      stopTimeoutSeconds,
    );
  }

  const fileNodeEntry = readConfiguredPath(local.peerLoopNodeEntry);
  if (fileNodeEntry !== null) {
    return validateNodeEntry(
      fileNodeEntry,
      "local-config-node-entry",
      execPath,
      isAbsolute,
      stopTimeoutSeconds,
    );
  }

  const onPath: PeerLoopCommandResolution = {
    kind: "resolved",
    command: {
      command: PEER_LOOP_DEFAULT_EXECUTABLE,
      args: PEER_LOOP_BRIDGE_ARGS,
      source: "path",
    },
    stopTimeoutSeconds,
  };
  return onPath;
});
