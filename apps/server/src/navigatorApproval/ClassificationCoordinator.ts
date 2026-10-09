/**
 * Server-side, fail-closed preparation for the future Navigator approval gate.
 *
 * This service reads the authoritative T3 projection, checks the same
 * deterministic proposal/candidate rules as the web gate, and only then asks
 * the fixed TextGeneration classifier for traits. It has no orchestration or
 * Peer Loop dependency: classification cannot start a run, write a link,
 * persist a message, or otherwise change conversation state.
 *
 * The proposal and latest-turn facts are read through
 * `getThreadDetailSnapshot`, whose transaction gives those values one
 * consistent committed projection view. That is the consistency result this
 * coordinator can honestly provide. It does not claim atomicity with a later
 * external provider call or a future execution call.
 */
import {
  NavigatorApprovalClassificationRpcInput,
  NavigatorApprovalClassificationRpcResult,
  NavigatorApprovalTraits,
  type OrchestrationProposedPlan,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { peerLoopProposalFingerprint } from "@t3tools/shared/peerLoopProposalFingerprint";
import { isNavigatorApprovalClassificationCandidate } from "@t3tools/shared/navigatorApprovalCandidate";
import * as Duration from "effect/Duration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { navigatorApprovalClassifierPreset } from "../textGeneration/TextGenerationPresets.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";

const SEND_TO_PROVIDER: NavigatorApprovalClassificationRpcResult = {
  outcome: "send-to-provider",
};

/** The server-side copy of the web selection rule, kept pure for focused tests. */
export function findLatestNavigatorApprovalProposal(
  thread: Pick<OrchestrationThread, "latestTurn" | "proposedPlans">,
): OrchestrationProposedPlan | null {
  const comparePlans = (left: OrchestrationProposedPlan, right: OrchestrationProposedPlan) =>
    left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id);

  const latestTurnId = thread.latestTurn?.turnId ?? null;
  if (latestTurnId !== null) {
    const matchingTurnPlan = thread.proposedPlans
      .filter((proposedPlan) => proposedPlan.turnId === latestTurnId)
      .toSorted(comparePlans)
      .at(-1);
    if (matchingTurnPlan) return matchingTurnPlan;
  }

  return [...thread.proposedPlans].toSorted(comparePlans).at(-1) ?? null;
}

/**
 * Mirror the web `unsettledTurnId` semantics. A null-producing-turn proposal
 * is settled; only a proposal produced by the currently active/incomplete turn
 * is unsettled.
 */
export function navigatorApprovalUnsettledTurnId(
  thread: Pick<OrchestrationThread, "latestTurn" | "session">,
): string | null {
  if (thread.session?.status === "running" && thread.session.activeTurnId !== null) {
    return thread.session.activeTurnId;
  }

  const latestTurn = thread.latestTurn;
  if (latestTurn === null) return null;
  if (latestTurn.startedAt !== null && latestTurn.completedAt === null) {
    return latestTurn.turnId;
  }
  return null;
}

export function navigatorApprovalProposalIsSettled(input: {
  readonly proposal: Pick<OrchestrationProposedPlan, "turnId">;
  readonly unsettledTurnId: string | null;
}): boolean {
  if (input.unsettledTurnId === null) return true;
  if (input.proposal.turnId === null) return true;
  return input.proposal.turnId !== input.unsettledTurnId;
}

export interface NavigatorApprovalClassificationCoordinatorShape {
  readonly classifyProposalApproval: (
    input: NavigatorApprovalClassificationRpcInput,
  ) => Effect.Effect<NavigatorApprovalClassificationRpcResult>;
}

export class NavigatorApprovalClassificationCoordinator extends Context.Service<
  NavigatorApprovalClassificationCoordinator,
  NavigatorApprovalClassificationCoordinatorShape
>()("t3/navigatorApproval/ClassificationCoordinator/NavigatorApprovalClassificationCoordinator") {}

const classifyTraits = (traits: unknown): NavigatorApprovalClassificationRpcResult =>
  Schema.is(NavigatorApprovalTraits)(traits) ? { outcome: "classified", traits } : SEND_TO_PROVIDER;

const classifyWithDependencies = (
  input: NavigatorApprovalClassificationRpcInput,
  snapshotQuery: ProjectionSnapshotQuery["Service"],
  textGeneration: TextGeneration["Service"],
): Effect.Effect<NavigatorApprovalClassificationRpcResult> =>
  Effect.gen(function* () {
    // These checks do not require a projection read and keep obviously
    // ineligible utterances away from both the database and classifier.
    if (input.hasAttachments) return SEND_TO_PROVIDER;
    if (input.ownerUtterance.trimStart().startsWith("/")) return SEND_TO_PROVIDER;
    if (!isNavigatorApprovalClassificationCandidate(input.ownerUtterance)) {
      return SEND_TO_PROVIDER;
    }

    const detailOption = yield* snapshotQuery.getThreadDetailSnapshot(input.threadId);
    if (Option.isNone(detailOption)) return SEND_TO_PROVIDER;

    const thread = detailOption.value.thread;
    if (thread.deletedAt !== null || thread.archivedAt !== null) return SEND_TO_PROVIDER;
    if (thread.purpose !== "navigator") return SEND_TO_PROVIDER;

    const proposal = findLatestNavigatorApprovalProposal(thread);
    if (proposal === null || proposal.id !== input.proposedPlanId) {
      return SEND_TO_PROVIDER;
    }

    const unsettledTurnId = navigatorApprovalUnsettledTurnId(thread);
    if (!navigatorApprovalProposalIsSettled({ proposal, unsettledTurnId })) {
      return SEND_TO_PROVIDER;
    }
    if (proposal.implementedAt !== null || proposal.implementationThreadId !== null) {
      return SEND_TO_PROVIDER;
    }
    if (thread.peerLoopExecutions.some((execution) => execution.proposedPlanId === proposal.id)) {
      return SEND_TO_PROVIDER;
    }
    if (peerLoopProposalFingerprint(proposal.planMarkdown) !== input.proposalFingerprint) {
      return SEND_TO_PROVIDER;
    }

    const projectOption = yield* snapshotQuery.getProjectShellById(thread.projectId);
    if (Option.isNone(projectOption)) return SEND_TO_PROVIDER;

    const cwd = resolveThreadWorkspaceCwd({
      thread,
      projects: [projectOption.value],
    });
    if (cwd === undefined) return SEND_TO_PROVIDER;

    const traitsOption = yield* textGeneration
      .classifyNavigatorApproval({
        cwd,
        ownerUtterance: input.ownerUtterance,
        planMarkdown: proposal.planMarkdown,
      })
      .pipe(Effect.timeoutOption(Duration.millis(navigatorApprovalClassifierPreset.timeoutMs)));

    if (Option.isNone(traitsOption)) return SEND_TO_PROVIDER;
    return classifyTraits(traitsOption.value);
  }).pipe(
    // Projection failures, provider absence, typed classifier errors, defects,
    // malformed results and interruption all fail closed without crossing the
    // RPC boundary with diagnostics or provider output.
    Effect.catchCause(() => Effect.succeed(SEND_TO_PROVIDER)),
  );

export const make = Effect.fn("navigatorApproval.ClassificationCoordinator.make")(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const textGeneration = yield* TextGeneration;

  return NavigatorApprovalClassificationCoordinator.of({
    classifyProposalApproval: (input) =>
      classifyWithDependencies(input, snapshotQuery, textGeneration),
  });
});

export const layer = Layer.effect(NavigatorApprovalClassificationCoordinator, make());
