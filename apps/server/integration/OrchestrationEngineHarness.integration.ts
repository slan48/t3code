// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  CodexSettings,
  ProviderDriverKind,
  type OrchestrationEvent,
  type OrchestrationThread,
  type PeerLoopListRunsInput,
  type PeerLoopRunStateFile,
  type PeerLoopRunSummary,
  type PeerLoopStartRunInput,
  type PeerLoopSubscriptionEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../src/checkpointing/CheckpointStore.ts";
import { TextGeneration, type TextGenerationShape } from "../src/textGeneration/TextGeneration.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionCheckpointRepositoryLive } from "../src/persistence/Layers/ProjectionCheckpoints.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../src/persistence/Layers/ProjectionPendingApprovals.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../src/persistence/Layers/ProviderSessionRuntime.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { ProjectionCheckpointRepository } from "../src/persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionPendingApprovalRepository } from "../src/persistence/Services/ProjectionPendingApprovals.ts";
import { makeAdapterRegistryMock } from "../src/provider/testUtils/providerAdapterRegistryMock.ts";
import { ProviderAdapterRegistry } from "../src/provider/Services/ProviderAdapterRegistry.ts";
import { makeProviderRegistryLayer } from "../src/provider/testUtils/providerRegistryMock.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../src/serverSettings.ts";
import { makeProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import { makeCodexAdapter } from "../src/provider/Layers/CodexAdapter.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../src/provider/Layers/ProviderEventLoggers.ts";
import { ProviderService } from "../src/provider/Services/ProviderService.ts";
import { AnalyticsService } from "../src/telemetry/Services/AnalyticsService.ts";
import { CheckpointReactorLive } from "../src/orchestration/Layers/CheckpointReactor.ts";
import * as RepositoryIdentityResolver from "../src/project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBusTest } from "../src/orchestration/Layers/RuntimeReceiptBus.ts";
import { OrchestrationReactorLive } from "../src/orchestration/Layers/OrchestrationReactor.ts";
import { ProviderCommandReactorLive } from "../src/orchestration/Layers/ProviderCommandReactor.ts";
import * as NavigatorExecutionContext from "../src/peerLoop/NavigatorExecutionContext.ts";
import * as PeerLoopExecutionCoordinator from "../src/peerLoop/ExecutionCoordinator.ts";
import { PeerLoopService } from "../src/peerLoop/Service.ts";
import { ProviderRuntimeIngestionLive } from "../src/orchestration/Layers/ProviderRuntimeIngestion.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../src/orchestration/Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../src/orchestration/Services/ThreadDeletionReactor.ts";
import { OrchestrationReactor } from "../src/orchestration/Services/OrchestrationReactor.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  RuntimeReceiptBus,
  type OrchestrationRuntimeReceipt,
} from "../src/orchestration/Services/RuntimeReceiptBus.ts";

import {
  makeTestProviderAdapterHarness,
  type TestProviderAdapterHarness,
} from "./TestProviderAdapter.integration.ts";
import { deriveServerPaths, ServerConfig } from "../src/config.ts";
import * as WorkspaceEntries from "../src/workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../src/workspace/WorkspacePaths.ts";
import * as VcsDriverRegistry from "../src/vcs/VcsDriverRegistry.ts";
import { VcsStatusBroadcaster } from "../src/vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../src/git/GitWorkflowService.ts";
import * as VcsProcess from "../src/vcs/VcsProcess.ts";
import * as AgentAwarenessRelay from "../src/relay/AgentAwarenessRelay.ts";

const decodeCodexSettings = Schema.decodeEffect(CodexSettings);

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

const initializeGitWorkspace = Effect.fn(function* (cwd: string) {
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  const fileSystem = yield* FileSystem.FileSystem;
  const { join } = yield* Path.Path;
  yield* fileSystem.writeFileString(join(cwd, "README.md"), "v1\n");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
});

export function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

export function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string {
  return runGit(cwd, ["show", `${ref}:${filePath}`]);
}

class WaitForTimeoutError extends Schema.TaggedErrorClass<WaitForTimeoutError>()(
  "WaitForTimeoutError",
  {
    description: Schema.String,
  },
) {}

function waitFor<A, E>(
  read: Effect.Effect<A, E>,
  predicate: (value: A) => boolean,
  description: string,
  timeoutMs?: number,
): Effect.Effect<A, never>;
function waitFor<A, B extends A, E>(
  read: Effect.Effect<A, E>,
  predicate: (value: A) => value is B,
  description: string,
  timeoutMs?: number,
): Effect.Effect<B, never>;
function waitFor<A, E>(
  read: Effect.Effect<A, E>,
  predicate: (value: A) => boolean,
  description: string,
  timeoutMs = 40_000,
): Effect.Effect<A, never> {
  const RETRY_SIGNAL = "wait_for_retry";
  const retryIntervalMs = 10;
  const maxRetries = Math.max(0, Math.floor(timeoutMs / retryIntervalMs));
  const retrySchedule = Schedule.spaced(`${retryIntervalMs} millis`);

  return read.pipe(
    Effect.filterOrFail(predicate, () => RETRY_SIGNAL),
    Effect.retry({
      schedule: retrySchedule,
      times: maxRetries,
      while: (error) => error === RETRY_SIGNAL,
    }),
    Effect.mapError((error) =>
      error === RETRY_SIGNAL ? new WaitForTimeoutError({ description }) : error,
    ),
    Effect.orDie,
  );
}

class OrchestrationHarnessRuntimeError extends Schema.TaggedErrorClass<OrchestrationHarnessRuntimeError>()(
  "OrchestrationHarnessRuntimeError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const tryRuntimePromise = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new OrchestrationHarnessRuntimeError({ operation, cause }),
  });

export interface OrchestrationIntegrationHarness {
  readonly rootDir: string;
  readonly workspaceDir: string;
  readonly dbPath: string;
  readonly adapterHarness: TestProviderAdapterHarness | null;
  readonly engine: OrchestrationEngineShape;
  readonly snapshotQuery: ProjectionSnapshotQuery["Service"];
  readonly providerService: ProviderService["Service"];
  readonly checkpointStore: CheckpointStore.CheckpointStore["Service"];
  readonly checkpointRepository: ProjectionCheckpointRepository["Service"];
  readonly pendingApprovalRepository: ProjectionPendingApprovalRepository["Service"];
  /** The recording fake bridge. Its call lists are the point. */
  readonly peerLoop: PeerLoopFake;
  /** The real coordinator, over that fake bridge. */
  readonly peerLoopExecutionCoordinator: PeerLoopExecutionCoordinator.PeerLoopExecutionCoordinatorShape;
  readonly waitForThread: (
    threadId: string,
    predicate: (thread: OrchestrationThread) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<OrchestrationThread, never>;
  readonly waitForDomainEvent: (
    predicate: (event: OrchestrationEvent) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, never>;
  readonly waitForPendingApproval: (
    requestId: string,
    predicate: (row: {
      readonly status: "pending" | "resolved";
      readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
      readonly resolvedAt: string | null;
    }) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<
    {
      readonly status: "pending" | "resolved";
      readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
      readonly resolvedAt: string | null;
    },
    never
  >;
  readonly waitForReceipt: {
    (
      predicate: (receipt: OrchestrationRuntimeReceipt) => boolean,
      timeoutMs?: number,
    ): Effect.Effect<OrchestrationRuntimeReceipt, never>;
    <Receipt extends OrchestrationRuntimeReceipt>(
      predicate: (receipt: OrchestrationRuntimeReceipt) => receipt is Receipt,
      timeoutMs?: number,
    ): Effect.Effect<Receipt, never>;
  };
  readonly dispose: Effect.Effect<void, never>;
}

/**
 * A fake Peer Loop bridge, and a record of everything asked of it.
 *
 * Mutable so a test can advance the run between turns — Peer Loop is the source
 * of every mutable run fact, so "the run finished" is expressed here and
 * nowhere else. `calls` is the point of the whole thing: an integration test
 * that only asserted on rendered strings could not tell the difference between
 * a read-only context build and one that had quietly started something.
 */
export interface PeerLoopFakeCalls {
  readonly startRun: Array<PeerLoopStartRunInput>;
  readonly listRuns: Array<PeerLoopListRunsInput>;
  readonly attachRun: Array<string>;
  readonly resumeRun: Array<string>;
  readonly pauseRun: Array<string>;
  readonly recoverRun: Array<string>;
  readonly sendOwnerMessage: Array<string>;
  readonly subscribeEvents: Array<string>;
}

export interface PeerLoopFake {
  readonly calls: PeerLoopFakeCalls;
  /** What `listRuns` reports. Set by the test as the fake run progresses. */
  readonly setRuns: (runs: ReadonlyArray<PeerLoopRunSummary>) => void;
  /** What `attachRun` reports, by run id. */
  readonly setSnapshot: (runId: string, state: PeerLoopRunStateFile) => void;
  /** The run id the next `startRun` returns. */
  readonly setNextRunId: (runId: string) => void;
  /**
   * A finite replay for one run, ending at its own `run-synced`.
   *
   * Unset by default, and the subscription stays fatal until it is: an
   * ordinary Navigator turn that opened one has to fail loudly, or every
   * "zero subscriptions" assertion in the loop is vacuous.
   */
  readonly setReplay: (runId: string, events: ReadonlyArray<PeerLoopSubscriptionEvent>) => void;
}

interface MakeOrchestrationIntegrationHarnessOptions {
  readonly provider?: ProviderDriverKind;
  readonly realCodex?: boolean;
  /**
   * Wire a recording fake Peer Loop, the real `NavigatorExecutionContext` and
   * the real `PeerLoopExecutionCoordinator`.
   *
   * Off by default, and the default stays a stub that dies on a Navigator
   * path: a harness that silently tolerated an unconfigured Navigator turn
   * would make the zero-call assertions meaningless.
   */
  readonly peerLoop?: boolean;
}

export const makeOrchestrationIntegrationHarness = (
  options?: MakeOrchestrationIntegrationHarnessOptions,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;

    const provider = options?.provider ?? ProviderDriverKind.make("codex");
    const useRealCodex = options?.realCodex === true;
    const adapterHarness = useRealCodex
      ? null
      : yield* makeTestProviderAdapterHarness({
          provider,
        });
    const fakeRegistry = adapterHarness
      ? Layer.succeed(
          ProviderAdapterRegistry,
          makeAdapterRegistryMock({ [adapterHarness.provider]: adapterHarness.adapter }),
        )
      : null;
    const rootDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-orchestration-integration-",
    });
    const workspaceDir = path.join(rootDir, "workspace");
    const { stateDir, dbPath } = yield* deriveServerPaths(rootDir, undefined).pipe(
      Effect.provideService(Path.Path, path),
    );
    yield* fileSystem.makeDirectory(workspaceDir, { recursive: true });
    yield* fileSystem.makeDirectory(stateDir, { recursive: true });
    yield* initializeGitWorkspace(workspaceDir);

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    );
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(ProviderSessionRuntimeRepositoryLive),
    );
    const realCodexRegistry = Layer.effect(
      ProviderAdapterRegistry,
      Effect.gen(function* () {
        const codexSettings = yield* decodeCodexSettings({});
        const codexAdapter = yield* makeCodexAdapter(codexSettings);
        return makeAdapterRegistryMock({
          [ProviderDriverKind.make("codex")]: codexAdapter,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(workspaceDir, rootDir)),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(providerSessionDirectoryLayer),
    );
    const providerEventLoggersLayer = Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers);
    const providerLayer = useRealCodex
      ? makeProviderServiceLive().pipe(
          Layer.provide(providerSessionDirectoryLayer),
          Layer.provide(realCodexRegistry),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(providerEventLoggersLayer),
        )
      : makeProviderServiceLive().pipe(
          Layer.provide(providerSessionDirectoryLayer),
          Layer.provide(fakeRegistry!),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(providerEventLoggersLayer),
        );
    const providerRegistryLayer = makeProviderRegistryLayer();

    const checkpointStoreLayer = CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer));
    const projectionSnapshotQueryLayer = OrchestrationProjectionSnapshotQueryLive;
    const runtimeServicesLayer = Layer.mergeAll(
      projectionSnapshotQueryLayer,
      orchestrationLayer.pipe(Layer.provide(projectionSnapshotQueryLayer)),
      ProjectionCheckpointRepositoryLive,
      ProjectionPendingApprovalRepositoryLive,
      checkpointStoreLayer,
      providerLayer,
      RuntimeReceiptBusTest,
    );
    const serverSettingsLayer = ServerSettingsService.layerTest();
    const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(serverSettingsLayer),
    );
    const gitWorkflowLayer = Layer.mock(GitWorkflowService)({
      renameBranch: (input: {
        readonly cwd: string;
        readonly oldBranch: string;
        readonly newBranch: string;
      }) => Effect.succeed({ branch: input.newBranch }),
    });
    const textGenerationLayer = Layer.succeed(TextGeneration, {
      generateBranchName: () => Effect.succeed({ branch: "update" }),
      generateThreadTitle: () => Effect.succeed({ title: "New thread" }),
    } as unknown as TextGenerationShape);
    /*
     * Peer Loop, faked and recorded — or absent and fatal.
     *
     * Off by default the harness runs coding threads, which never reach Peer
     * Loop at all, and a stub that dies on a Navigator path is the honest
     * wiring: a harness that tolerated an unconfigured Navigator turn would
     * make every zero-call assertion vacuous.
     *
     * On, the fake records every method and the REAL `NavigatorExecutionContext`
     * and `PeerLoopExecutionCoordinator` sit on top of it. Nothing about which
     * methods get called, in what order, or with what arguments is faked.
     */
    const peerLoopRuns: { current: ReadonlyArray<PeerLoopRunSummary> } = { current: [] };
    const peerLoopSnapshots = new Map<string, PeerLoopRunStateFile>();
    const peerLoopNextRunId = { current: "run-1" };
    const peerLoopReplays = new Map<string, ReadonlyArray<PeerLoopSubscriptionEvent>>();
    const peerLoopCalls: PeerLoopFakeCalls = {
      startRun: [],
      listRuns: [],
      attachRun: [],
      resumeRun: [],
      pauseRun: [],
      recoverRun: [],
      sendOwnerMessage: [],
      subscribeEvents: [],
    };
    const peerLoopFake: PeerLoopFake = {
      calls: peerLoopCalls,
      setRuns: (runs) => {
        peerLoopRuns.current = runs;
      },
      setSnapshot: (runId, state) => {
        peerLoopSnapshots.set(runId, state);
      },
      setNextRunId: (runId) => {
        peerLoopNextRunId.current = runId;
      },
      setReplay: (runId, events) => {
        peerLoopReplays.set(runId, events);
      },
    };
    const peerLoopServiceLayer = Layer.mock(PeerLoopService)({
      status: () => Effect.die("peer loop status is not part of this harness"),
      listRuns: (input) => {
        peerLoopCalls.listRuns.push(input);
        return Effect.succeed({ runs: peerLoopRuns.current, unreadable: [] });
      },
      attachRun: (input) => {
        peerLoopCalls.attachRun.push(input.runId);
        const state = peerLoopSnapshots.get(input.runId);
        return state === undefined
          ? Effect.die(`no fake snapshot for run '${input.runId}'`)
          : Effect.succeed({
              runId: input.runId,
              state,
              control: {
                available: false,
                reason: "not_attached" as const,
                resumable: true,
                liveWriter: null,
              },
              eventHighWaterMark: 0,
              replayFromSeq: 0,
              live: false,
            });
      },
      startRun: (input) => {
        peerLoopCalls.startRun.push(input);
        const runId = peerLoopNextRunId.current;
        return Effect.succeed({
          runId,
          state: {
            state: "reviewer_working" as const,
            iteration: 0,
            haltReason: null,
            inFlight: null,
          },
          control: {
            available: true,
            reason: "live_in_this_bridge" as const,
            resumable: false,
            liveWriter: null,
          },
          eventHighWaterMark: 0,
          replayFromSeq: 0,
          live: true,
          projectPath: input.projectPath,
          awaitingOwnerObjective: false,
        } as never);
      },
      /*
       * The mutations and the subscription record AND die. Recording makes the
       * zero-call assertion readable; dying makes an accidental call fail the
       * test that provoked it rather than pass quietly.
       */
      resumeRun: (input) => {
        peerLoopCalls.resumeRun.push(input.runId);
        return Effect.die("resumeRun must not be reached by the Navigator loop");
      },
      pauseRun: (input) => {
        peerLoopCalls.pauseRun.push(input.runId);
        return Effect.die("pauseRun must not be reached by the Navigator loop");
      },
      recoverRun: (input) => {
        peerLoopCalls.recoverRun.push(input.runId);
        return Effect.die("recoverRun must not be reached by the Navigator loop");
      },
      sendOwnerMessage: (input) => {
        peerLoopCalls.sendOwnerMessage.push(input.runId);
        return Effect.die("sendOwnerMessage must not be reached by the Navigator loop");
      },
      subscribeEvents: (input) => {
        peerLoopCalls.subscribeEvents.push(input.runId);
        const replay = peerLoopReplays.get(input.runId);
        // Fatal unless a test explicitly scripted a replay for this run. An
        // ordinary turn reaching here is a bug, not a configuration gap.
        return replay === undefined
          ? Stream.die("subscribeEvents must not be reached by an ordinary Navigator turn")
          : Stream.fromIterable(replay);
      },
      diagnostics: Effect.succeed([]),
    });
    const navigatorExecutionContextLayer =
      options?.peerLoop === true
        ? // `ProjectionSnapshotQuery` deliberately stays a requirement here so it
          // is satisfied by the same `runtimeServicesLayer` everything else
          // reads — a locally provided copy would be a second database.
          NavigatorExecutionContext.layer.pipe(Layer.provide(peerLoopServiceLayer))
        : Layer.succeed(NavigatorExecutionContext.NavigatorExecutionContext, {
            forThread: ({ thread }) =>
              thread.purpose === "navigator"
                ? Effect.die("navigator execution context is not configured in this harness")
                : Effect.succeed(null),
          });
    const providerCommandReactorLayer = ProviderCommandReactorLive.pipe(
      Layer.provideMerge(navigatorExecutionContextLayer),
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(gitWorkflowLayer),
      Layer.provideMerge(textGenerationLayer),
      Layer.provideMerge(serverSettingsLayer),
    );
    const checkpointReactorLayer = CheckpointReactorLive.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(
        Layer.succeed(VcsStatusBroadcaster, {
          getStatus: () => Effect.die("getStatus should not be called in this test"),
          refreshLocalStatus: () =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: false,
              isDefaultRef: true,
              refName: "main",
              hasWorkingTreeChanges: false,
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
          refreshStatus: () => Effect.die("refreshStatus should not be called in this test"),
          streamStatus: () => Stream.empty,
        }),
      ),
      Layer.provideMerge(
        WorkspaceEntries.layer.pipe(
          Layer.provide(WorkspacePaths.layer),
          Layer.provideMerge(VcsDriverRegistry.layer),
          Layer.provide(NodeServices.layer),
        ),
      ),
      Layer.provideMerge(WorkspacePaths.layer),
      Layer.provideMerge(VcsProcess.layer),
    );
    const orchestrationReactorLayer = OrchestrationReactorLive.pipe(
      Layer.provideMerge(runtimeIngestionLayer),
      Layer.provideMerge(providerCommandReactorLayer),
      Layer.provideMerge(checkpointReactorLayer),
      Layer.provideMerge(
        Layer.succeed(ThreadDeletionReactor, {
          start: () => Effect.void,
          drain: Effect.void,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(AgentAwarenessRelay.AgentAwarenessRelay, {
          publishThread: () => Effect.void,
          start: () => Effect.void,
        }),
      ),
    );
    /*
     * The real coordinator, over the same fake bridge and the same projection.
     *
     * Execution is the one place the loop leaves orchestration, and it is the
     * step most worth exercising for real: the validation, the at-most-once
     * gate and the immutable link are all its own.
     */
    const peerLoopExecutionCoordinatorLayer = PeerLoopExecutionCoordinator.layer.pipe(
      Layer.provide(peerLoopServiceLayer),
    );
    const baseLayer = Layer.empty.pipe(
      Layer.provideMerge(runtimeServicesLayer),
      Layer.provideMerge(orchestrationReactorLayer),
      Layer.provideMerge(providerRegistryLayer),
      Layer.provide(persistenceLayer),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(workspaceDir, rootDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    /*
     * The coordinator sits ABOVE the runtime: it coordinates the orchestration
     * engine and the Peer Loop bridge, so both have to exist before it does.
     *
     * Always wired, unlike the context service. Nothing reaches it without an
     * explicit call from a test — no reactor does — so there is no accidental
     * path for it to make loud, and always having it keeps the recorded call
     * list available to the control tests that assert it stays empty.
     */
    const layer = peerLoopExecutionCoordinatorLayer.pipe(Layer.provideMerge(baseLayer));

    const runtime = ManagedRuntime.make(layer);
    const engine = yield* tryRuntimePromise("load OrchestrationEngine service", () =>
      runtime.runPromise(Effect.service(OrchestrationEngineService)),
    ).pipe(Effect.orDie);
    const reactor = yield* tryRuntimePromise("load OrchestrationReactor service", () =>
      runtime.runPromise(Effect.service(OrchestrationReactor)),
    ).pipe(Effect.orDie);
    const snapshotQuery = yield* tryRuntimePromise("load ProjectionSnapshotQuery service", () =>
      runtime.runPromise(Effect.service(ProjectionSnapshotQuery)),
    ).pipe(Effect.orDie);
    const providerService = yield* tryRuntimePromise("load ProviderService service", () =>
      runtime.runPromise(Effect.service(ProviderService)),
    ).pipe(Effect.orDie);
    const checkpointStore = yield* tryRuntimePromise("load CheckpointStore service", () =>
      runtime.runPromise(Effect.service(CheckpointStore.CheckpointStore)),
    ).pipe(Effect.orDie);
    const checkpointRepository = yield* tryRuntimePromise(
      "load ProjectionCheckpointRepository service",
      () => runtime.runPromise(Effect.service(ProjectionCheckpointRepository)),
    ).pipe(Effect.orDie);
    const pendingApprovalRepository = yield* tryRuntimePromise(
      "load ProjectionPendingApprovalRepository service",
      () => runtime.runPromise(Effect.service(ProjectionPendingApprovalRepository)),
    ).pipe(Effect.orDie);
    const runtimeReceiptBus = yield* tryRuntimePromise("load RuntimeReceiptBus service", () =>
      runtime.runPromise(Effect.service(RuntimeReceiptBus)),
    ).pipe(Effect.orDie);
    const peerLoopExecutionCoordinator = yield* tryRuntimePromise(
      "load PeerLoopExecutionCoordinator service",
      () =>
        runtime.runPromise(
          Effect.service(PeerLoopExecutionCoordinator.PeerLoopExecutionCoordinator),
        ),
    ).pipe(Effect.orDie);

    const scope = yield* Scope.make("sequential");
    yield* tryRuntimePromise("start OrchestrationReactor", () =>
      runtime.runPromise(reactor.start().pipe(Scope.provide(scope))),
    ).pipe(Effect.orDie);
    const receiptHistory = yield* Ref.make<ReadonlyArray<OrchestrationRuntimeReceipt>>([]);
    yield* Stream.runForEach(runtimeReceiptBus.streamEventsForTest, (receipt) =>
      Ref.update(receiptHistory, (history) => [...history, receipt]).pipe(Effect.asVoid),
    ).pipe(Effect.forkIn(scope));
    yield* Effect.sleep(10);

    const waitForThread: OrchestrationIntegrationHarness["waitForThread"] = (
      threadId,
      predicate,
      timeoutMs,
    ) =>
      waitFor(
        snapshotQuery
          .getSnapshot()
          .pipe(
            Effect.map(
              (snapshot) => snapshot.threads.find((thread) => thread.id === threadId) ?? null,
            ),
          ),
        (thread): thread is OrchestrationThread => thread !== null && predicate(thread),
        `projected thread '${threadId}'`,
        timeoutMs,
      ) as Effect.Effect<OrchestrationThread, never>;

    const waitForDomainEvent: OrchestrationIntegrationHarness["waitForDomainEvent"] = (
      predicate,
      timeoutMs,
    ) =>
      waitFor(
        Stream.runCollect(engine.readEvents(0)).pipe(
          Effect.map((chunk): ReadonlyArray<OrchestrationEvent> => Array.from(chunk)),
        ),
        (events) => events.some(predicate),
        "domain event",
        timeoutMs,
      );

    const waitForPendingApproval: OrchestrationIntegrationHarness["waitForPendingApproval"] = (
      requestId,
      predicate,
      timeoutMs,
    ) =>
      waitFor(
        pendingApprovalRepository
          .getByRequestId({ requestId: ApprovalRequestId.make(requestId) })
          .pipe(
            Effect.map((row) =>
              Option.match(row, {
                onNone: () => null,
                onSome: (value) => ({
                  status: value.status,
                  decision: value.decision,
                  resolvedAt: value.resolvedAt,
                }),
              }),
            ),
          ),
        (
          row,
        ): row is {
          readonly status: "pending" | "resolved";
          readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
          readonly resolvedAt: string | null;
        } => row !== null && predicate(row),
        `pending approval '${requestId}'`,
        timeoutMs,
      ) as Effect.Effect<
        {
          readonly status: "pending" | "resolved";
          readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
          readonly resolvedAt: string | null;
        },
        never
      >;

    function waitForReceipt(
      predicate: (receipt: OrchestrationRuntimeReceipt) => boolean,
      timeoutMs?: number,
    ): Effect.Effect<OrchestrationRuntimeReceipt, never>;
    function waitForReceipt<Receipt extends OrchestrationRuntimeReceipt>(
      predicate: (receipt: OrchestrationRuntimeReceipt) => receipt is Receipt,
      timeoutMs?: number,
    ): Effect.Effect<Receipt, never>;
    function waitForReceipt(
      predicate: (receipt: OrchestrationRuntimeReceipt) => boolean,
      timeoutMs?: number,
    ) {
      const readMatchingReceipt = Ref.get(receiptHistory).pipe(
        Effect.map((history) => history.find(predicate)),
      );

      return waitFor(
        readMatchingReceipt,
        (receipt): receipt is OrchestrationRuntimeReceipt => receipt !== undefined,
        "runtime receipt",
        timeoutMs,
      );
    }

    let disposed = false;
    const dispose = Effect.gen(function* () {
      if (disposed) {
        return;
      }
      disposed = true;

      const shutdown = Effect.gen(function* () {
        const closeScopeExit = yield* Effect.exit(Scope.close(scope, Exit.void));
        const disposeRuntimeExit = yield* Effect.exit(Effect.promise(() => runtime.dispose()));

        const failureCause = Exit.isFailure(closeScopeExit)
          ? closeScopeExit.cause
          : Exit.isFailure(disposeRuntimeExit)
            ? disposeRuntimeExit.cause
            : null;

        if (failureCause) {
          return yield* Effect.failCause(failureCause);
        }
      });

      yield* shutdown;
    });

    return {
      rootDir,
      workspaceDir,
      dbPath,
      adapterHarness,
      engine,
      snapshotQuery,
      providerService,
      checkpointStore,
      checkpointRepository,
      pendingApprovalRepository,
      peerLoop: peerLoopFake,
      peerLoopExecutionCoordinator,
      waitForThread,
      waitForDomainEvent,
      waitForPendingApproval,
      waitForReceipt,
      dispose,
    } satisfies OrchestrationIntegrationHarness;
  });
