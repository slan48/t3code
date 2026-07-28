/**
 * Machine-local server configuration.
 *
 * `settings.json` is the user's settings document and is deliberately
 * writable from any authorized client — including a browser reaching the
 * server over Tailscale from a phone. That is right for preferences and wrong
 * for anything that names a path on this machine's filesystem: a remote client
 * must not be able to repoint the server at an arbitrary local directory.
 *
 * So this is a second, much smaller document with the opposite properties. It
 * is:
 *
 *   - **read-only to the server** — nothing here is ever written back, so the
 *     file stays exactly what the operator typed;
 *   - **unreachable by RPC** — no method reads it on demand, none patches it,
 *     and it is resolved once at startup;
 *   - **machine-scoped** — it lives beside the state of the install it
 *     configures and is never committed, because its values are true of one
 *     Mac and no other.
 *
 * It is not a second settings system: it holds only what genuinely cannot live
 * in settings, and an absent or malformed file simply means "not configured".
 *
 * @module LocalConfig
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

/**
 * The machine-local document.
 *
 * Every field is optional: this file is entirely opt-in, and a key nobody has
 * set must degrade to "that integration is off", never to a startup failure.
 */
export const LocalConfig = Schema.Struct({
  /**
   * Absolute path to an `agent-orchestrator` home to observe, read-only.
   *
   * Set here rather than in settings precisely because it names a directory on
   * this machine. The `T3_ORCHESTRATOR_HOME` environment variable still wins
   * when it is explicitly present, which keeps a dev shell able to point one
   * run at a different home without editing the installed app's config.
   */
  orchestratorHome: Schema.optional(Schema.String),
});
export type LocalConfig = typeof LocalConfig.Type;

export const EMPTY_LOCAL_CONFIG: LocalConfig = {};

const decodeLocalConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(LocalConfig));

/**
 * Read the machine-local document, or fall back to an empty one.
 *
 * Never fails. A missing file is the normal case — most installs have none —
 * and a malformed one is logged and then treated as absent, because refusing
 * to boot a code editor over a stray comma in an optional integration file
 * would be a poor trade.
 */
export const loadLocalConfig = Effect.fn("localConfig.load")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;

  const raw = yield* fileSystem.readFileString(filePath).pipe(
    Effect.map((contents): string | null => contents),
    Effect.catchCause(() => Effect.succeed(null)),
  );
  if (raw === null) return EMPTY_LOCAL_CONFIG;

  return yield* decodeLocalConfig(raw).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Ignoring malformed machine-local config.").pipe(
        Effect.annotateLogs({ filePath, cause: String(cause) }),
        Effect.as(EMPTY_LOCAL_CONFIG),
      ),
    ),
  );
});

/**
 * Trim a configured path down to a usable value, or null.
 *
 * A key present but blank means the same as a key that is absent; treating
 * `""` as a path would turn "I cleared this setting" into a read of the
 * process's working directory.
 */
export function readConfiguredPath(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
}
