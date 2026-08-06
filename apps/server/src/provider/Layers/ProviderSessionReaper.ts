import {
  DEFAULT_PROVIDER_SESSION_IDLE_TIMEOUT,
  MAX_PROVIDER_SESSION_IDLE_TIMEOUT,
  MIN_PROVIDER_SESSION_IDLE_TIMEOUT,
} from "@t3tools/contracts/settings";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { forkParked } from "../../serverActivation.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderService } from "../Services/ProviderService.ts";

/**
 * Fallback only. The live value comes from
 * `ServerSettings.providerSessionIdleTimeout`, re-read on every sweep so a
 * settings change takes effect without a restart; this is used when settings
 * cannot be read at all.
 *
 * Reaping a session is expensive: the next message resumes it, which
 * re-ingests the transcript and rewrites the prompt-cache prefix at the 1.25x
 * cache-creation rate. Anthropic's cache lives for an hour, so a threshold
 * under that kills sessions whose cache would still have been reused.
 */
const DEFAULT_INACTIVITY_THRESHOLD_MS = Duration.toMillis(DEFAULT_PROVIDER_SESSION_IDLE_TIMEOUT);
const MIN_INACTIVITY_THRESHOLD_MS = Duration.toMillis(MIN_PROVIDER_SESSION_IDLE_TIMEOUT);
const MAX_INACTIVITY_THRESHOLD_MS = Duration.toMillis(MAX_PROVIDER_SESSION_IDLE_TIMEOUT);
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const serverSettings = yield* ServerSettingsService;

    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    /**
     * Re-read per sweep so changing the setting takes effect without a
     * restart. An explicit option always wins (tests pin it to sub-second
     * values); otherwise the configured duration is clamped to the supported
     * range, keeping the threshold above the one-hour prompt-cache lifetime.
     */
    const resolveInactivityThresholdMs = Effect.gen(function* () {
      if (options?.inactivityThresholdMs !== undefined) {
        return Math.max(1, options.inactivityThresholdMs);
      }
      const configured = yield* serverSettings.getSettings.pipe(
        Effect.map((settings) => Duration.toMillis(settings.providerSessionIdleTimeout)),
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.session.reaper.settings-read-failed", {
            cause,
            fallbackMs: DEFAULT_INACTIVITY_THRESHOLD_MS,
          }).pipe(Effect.as(DEFAULT_INACTIVITY_THRESHOLD_MS)),
        ),
      );
      return Math.min(
        MAX_INACTIVITY_THRESHOLD_MS,
        Math.max(MIN_INACTIVITY_THRESHOLD_MS, configured),
      );
    });

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const now = yield* Clock.currentTimeMillis;
      const inactivityThresholdMs = yield* resolveInactivityThresholdMs;
      let reapedCount = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        const idleDurationMs = now - lastSeenMs;
        if (idleDurationMs < inactivityThresholdMs) {
          continue;
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (thread?.session?.activeTurnId != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: thread.session.activeTurnId,
            idleDurationMs,
          });
          continue;
        }

        const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              reason: "inactivity_threshold",
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* forkParked(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs: yield* resolveInactivityThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
