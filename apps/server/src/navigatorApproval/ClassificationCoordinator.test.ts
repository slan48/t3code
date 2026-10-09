import {
  type NavigatorApprovalClassificationRpcInput,
  NavigatorApprovalClassificationRpcResult,
  ProjectId,
  ProviderInstanceId,
  TextGenerationError,
  ThreadId,
  TurnId,
  type NavigatorApprovalTraits,
  type OrchestrationProjectShell,
  type OrchestrationProposedPlan,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Fiber from "effect/Fiber";
import { describe, expect } from "vite-plus/test";

import { peerLoopProposalFingerprint } from "@t3tools/shared/peerLoopProposalFingerprint";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  make,
  navigatorApprovalProposalIsSettled,
  navigatorApprovalUnsettledTurnId,
  findLatestNavigatorApprovalProposal,
} from "./ClassificationCoordinator.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT_ID = ProjectId.make("project-navigator");
const THREAD_ID = ThreadId.make("thread-navigator");
const PLAN_ID = "proposal-1";
const PLAN_MARKDOWN = "# Current plan\n\n1. Use the server projection.";
const WORKSPACE_ROOT = "/workspace/project";
const WORKTREE_PATH = "/workspace/project-worktree";
const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} as const;

const VALID_TRAITS: NavigatorApprovalTraits = {
  expressesApproval: true,
  addsCondition: false,
  requestsModification: false,
  asksQuestion: false,
  expressesDoubt: false,
  isNegation: false,
  isQuotationOrHypothetical: false,
  referencesSomethingElse: false,
  isBareAffirmation: false,
  confidence: "high",
};

const plan = (overrides: Partial<OrchestrationProposedPlan> = {}): OrchestrationProposedPlan => ({
  id: PLAN_ID,
  turnId: null,
  planMarkdown: PLAN_MARKDOWN,
  implementedAt: null,
  implementationThreadId: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const navigatorThread = (overrides: Partial<OrchestrationThread> = {}): OrchestrationThread => ({
  id: THREAD_ID,
  projectId: PROJECT_ID,
  title: "Navigator",
  purpose: "navigator",
  modelSelection: MODEL_SELECTION,
  runtimeMode: "approval-required",
  interactionMode: "plan",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [plan()],
  peerLoopExecutions: [],
  activities: [],
  checkpoints: [],
  session: null,
  ...overrides,
});

const projectShell = (
  overrides: Partial<OrchestrationProjectShell> = {},
): OrchestrationProjectShell => ({
  id: PROJECT_ID,
  title: "Navigator project",
  workspaceRoot: WORKSPACE_ROOT,
  defaultModelSelection: MODEL_SELECTION,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const input = (
  overrides: Partial<NavigatorApprovalClassificationRpcInput> = {},
): NavigatorApprovalClassificationRpcInput => ({
  threadId: THREAD_ID,
  proposedPlanId: PLAN_ID,
  proposalFingerprint: peerLoopProposalFingerprint(PLAN_MARKDOWN),
  ownerUtterance: "Perfecto, me parece bien. Puedes empezar.",
  hasAttachments: false,
  ...overrides,
});

interface HarnessOptions {
  readonly thread?: OrchestrationThread | null | undefined;
  readonly project?: OrchestrationProjectShell | null | undefined;
  readonly classify?: (
    input: TextGeneration.NavigatorApprovalClassificationInput,
  ) => Effect.Effect<unknown, TextGenerationError>;
}

const makeHarness = (options: HarnessOptions = {}) =>
  Effect.gen(function* () {
    const classifierInputs: TextGeneration.NavigatorApprovalClassificationInput[] = [];
    const snapshotQuery = {
      getThreadDetailSnapshot: () =>
        options.thread === null
          ? Effect.succeed(Option.none())
          : Effect.succeed(
              Option.some({
                snapshotSequence: 1,
                thread: options.thread ?? navigatorThread(),
              }),
            ),
      getProjectShellById: () =>
        Effect.succeed(
          options.project === null ? Option.none() : Option.some(options.project ?? projectShell()),
        ),
    } as unknown as ProjectionSnapshotQuery["Service"];
    const textGeneration = {
      classifyNavigatorApproval: (
        classificationInput: TextGeneration.NavigatorApprovalClassificationInput,
      ) => {
        classifierInputs.push(classificationInput);
        return options.classify === undefined
          ? Effect.succeed(VALID_TRAITS)
          : options.classify(classificationInput);
      },
    } as TextGeneration.TextGeneration["Service"];

    const coordinator = yield* make().pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
          Layer.succeed(TextGeneration.TextGeneration, textGeneration),
        ),
      ),
    );
    return { coordinator, classifierInputs };
  });

const sendToProvider = (): NavigatorApprovalClassificationRpcResult => ({
  outcome: "send-to-provider",
});

describe("Navigator approval classification coordinator", () => {
  it.effect("uses the fresh server plan and workspace, then returns traits", () =>
    Effect.gen(function* () {
      const { coordinator, classifierInputs } = yield* makeHarness({
        thread: navigatorThread({ worktreePath: WORKTREE_PATH }),
      });

      const result = yield* coordinator.classifyProposalApproval(input());

      expect(result).toEqual({ outcome: "classified", traits: VALID_TRAITS });
      expect(classifierInputs).toEqual([
        {
          cwd: WORKTREE_PATH,
          ownerUtterance: "Perfecto, me parece bien. Puedes empezar.",
          planMarkdown: PLAN_MARKDOWN,
        },
      ]);
    }),
  );

  it.effect.each([
    {
      name: "attachments",
      request: input({ hasAttachments: true }),
    },
    {
      name: "slash-prefixed utterance",
      request: input({ ownerUtterance: "   /help" }),
    },
    {
      name: "empty utterance",
      request: input({ ownerUtterance: "   " }),
    },
    {
      name: "too-long utterance",
      request: input({ ownerUtterance: "x".repeat(241) }),
    },
    {
      name: "question utterance",
      request: input({ ownerUtterance: "Can we do this?" }),
    },
    {
      name: "inverted question utterance",
      request: input({ ownerUtterance: "¿Puedes hacerlo" }),
    },
    {
      name: "missing active thread",
      request: input(),
      thread: null,
    },
    {
      name: "coding thread",
      request: input(),
      thread: navigatorThread({ purpose: "coding" }),
    },
    {
      name: "missing proposal",
      request: input({ proposedPlanId: "missing-proposal" }),
    },
    {
      name: "non-current latest proposal",
      request: input({ proposedPlanId: "older-proposal" }),
      thread: navigatorThread({
        proposedPlans: [
          plan({ id: "older-proposal", updatedAt: "2025-12-31T00:00:00.000Z" }),
          plan({ id: PLAN_ID, updatedAt: "2026-01-02T00:00:00.000Z" }),
        ],
      }),
    },
    {
      name: "unsettled producing proposal",
      request: input(),
      thread: navigatorThread({
        latestTurn: {
          turnId: TurnId.make("turn-producing"),
          state: "running",
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: null,
          assistantMessageId: null,
        },
        session: {
          threadId: THREAD_ID,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: TurnId.make("turn-producing"),
          lastError: null,
          updatedAt: NOW,
        },
        proposedPlans: [plan({ turnId: TurnId.make("turn-producing") })],
      }),
    },
    {
      name: "implemented proposal",
      request: input(),
      thread: navigatorThread({ proposedPlans: [plan({ implementedAt: NOW })] }),
    },
    {
      name: "implementation-thread proposal",
      request: input(),
      thread: navigatorThread({
        proposedPlans: [plan({ implementationThreadId: ThreadId.make("implementation") })],
      }),
    },
    {
      name: "existing execution link",
      request: input(),
      thread: navigatorThread({
        peerLoopExecutions: [{ runId: "run-1", proposedPlanId: PLAN_ID, createdAt: NOW }],
      }),
    },
    {
      name: "changed proposal fingerprint",
      request: input({ proposalFingerprint: "b".repeat(32) }),
      thread: navigatorThread({ proposedPlans: [plan({ planMarkdown: "# F2" })] }),
    },
    {
      name: "missing active project",
      request: input(),
      project: null,
    },
  ])("returns send-to-provider without classification for $name", ({ request, thread, project }) =>
    Effect.gen(function* () {
      const { coordinator, classifierInputs } = yield* makeHarness({ thread, project });
      const result = yield* coordinator.classifyProposalApproval(request);

      expect(result).toEqual(sendToProvider());
      expect(classifierInputs).toHaveLength(0);
    }),
  );

  it.effect(
    "selects the latest plan for the latest turn, then falls back by timestamp and id",
    () =>
      Effect.gen(function* () {
        const latestTurn = {
          turnId: TurnId.make("turn-latest"),
          state: "completed" as const,
          requestedAt: NOW,
          startedAt: NOW,
          completedAt: NOW,
          assistantMessageId: null,
        };
        const matching = plan({
          id: "matching",
          turnId: TurnId.make("turn-latest"),
          updatedAt: "2026-01-03",
        });
        const fallback = plan({ id: "fallback", turnId: null, updatedAt: "2026-01-04" });
        const thread = navigatorThread({ latestTurn, proposedPlans: [fallback, matching] });

        expect(findLatestNavigatorApprovalProposal(thread)?.id).toBe("matching");
        expect(
          findLatestNavigatorApprovalProposal({
            ...thread,
            latestTurn: { ...latestTurn, turnId: TurnId.make("turn-other") },
          })?.id,
        ).toBe("fallback");
      }),
  );

  it.effect("keeps unrelated and null-turn proposals settled", () =>
    Effect.gen(function* () {
      const producingTurn = {
        turnId: TurnId.make("turn-producing"),
        state: "running" as const,
        requestedAt: NOW,
        startedAt: NOW,
        completedAt: null,
        assistantMessageId: null,
      };
      const thread = navigatorThread({
        latestTurn: producingTurn,
        session: {
          threadId: THREAD_ID,
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: TurnId.make("turn-producing"),
          lastError: null,
          updatedAt: NOW,
        },
      });
      const unsettledTurnId = navigatorApprovalUnsettledTurnId(thread);

      expect(unsettledTurnId).toBe("turn-producing");
      expect(
        navigatorApprovalProposalIsSettled({
          proposal: plan({ turnId: TurnId.make("turn-other") }),
          unsettledTurnId,
        }),
      ).toBe(true);
      expect(navigatorApprovalProposalIsSettled({ proposal: plan(), unsettledTurnId })).toBe(true);
    }),
  );

  it.effect.each([
    [
      "typed classifier error",
      Effect.fail(
        new TextGenerationError({ operation: "classifyNavigatorApproval", detail: "invalid" }),
      ),
    ],
    ["malformed traits", Effect.succeed({ expressesApproval: true })],
  ] as const)("fails closed for %s", (_name, classification) =>
    Effect.gen(function* () {
      const { coordinator, classifierInputs } = yield* makeHarness({
        classify: () => classification as never,
      });

      const result = yield* coordinator.classifyProposalApproval(input());

      expect(result).toEqual(sendToProvider());
      expect(classifierInputs).toHaveLength(1);
    }),
  );

  it.effect("fails closed at the fixed classifier deadline without sleeping", () =>
    Effect.gen(function* () {
      const { coordinator, classifierInputs } = yield* makeHarness({
        classify: () => Effect.never,
      });
      const fiber = yield* coordinator.classifyProposalApproval(input()).pipe(Effect.forkChild);

      yield* TestClock.adjust(Duration.millis(10_000));
      const result = yield* Fiber.join(fiber);

      expect(result).toEqual(sendToProvider());
      expect(classifierInputs).toHaveLength(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("has no orchestration or Peer Loop mutation dependency", () =>
    Effect.gen(function* () {
      const { coordinator } = yield* makeHarness();
      expect("executeProposal" in coordinator).toBe(false);
    }),
  );
});
