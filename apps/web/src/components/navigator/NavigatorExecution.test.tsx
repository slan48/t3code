/**
 * What an owner is actually shown around an Execution Proposal.
 *
 * Rendered to static markup, so these are assertions about the page rather than
 * about the functions behind it: which conversations get an Execute button,
 * what the button says it is about to do, what a child run card claims about a
 * run, and that a coding thread's plan card is untouched by any of it.
 */
import type {
  EnvironmentId,
  OrchestrationPeerLoopExecution,
  OrchestrationProposedPlanId,
  PeerLoopRunStateFile,
  PeerLoopRunSummary,
} from "@t3tools/contracts";
import {
  PeerLoopCommandRefusedError,
  PeerLoopExecutionCoordinationError,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  describeExecution,
  describeExecutionDetail,
  type NavigatorExecutionDetail,
} from "~/navigatorExecution";
import { navigatorExecutionKey, navigatorExecutionStore } from "~/state/navigatorExecutionCommand";
import { ProposedPlanCard } from "../chat/ProposedPlanCard";
import {
  NavigatorExecutionCard,
  NavigatorProposalExecution,
  type NavigatorExecutionContext,
} from "./NavigatorProposalExecution";

const ENVIRONMENT_ID = "environment-local" as EnvironmentId;
const THREAD_ID = ThreadId.make("thread-navigator-1");
const PLAN_ID = "plan-1" as OrchestrationProposedPlanId;
const PLAN = "# Split the migration\n\n1. Add the column.\n2. Backfill.";
/** Fixed, so the relative-time label is deterministic. */
const NOW_MS = Date.parse("2026-03-01T10:20:00.000Z");

/** Router-aware rendering: every execution surface links to the inspector. */
async function render(node: React.ReactNode): Promise<string> {
  const rootRoute = createRootRoute({ component: () => node });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
  const peerLoopRoute = createRoute({ getParentRoute: () => rootRoute, path: "/peer-loop" });
  const runRoute = createRoute({ getParentRoute: () => rootRoute, path: "/peer-loop/$runId" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, peerLoopRoute, runRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const link = (input: {
  readonly runId: string;
  readonly proposedPlanId?: string;
}): OrchestrationPeerLoopExecution => ({
  runId: input.runId,
  proposedPlanId: (input.proposedPlanId ?? PLAN_ID) as OrchestrationProposedPlanId,
  createdAt: "2026-03-01T10:00:00.000Z",
});

const summary = (overrides: Partial<PeerLoopRunSummary> = {}): PeerLoopRunSummary => ({
  runId: "run-77",
  projectPath: "/repos/demo",
  state: "builder_working",
  iteration: 4,
  createdAt: "2026-03-01T09:00:00.000Z",
  updatedAt: "2026-03-01T10:05:00.000Z",
  haltReason: null,
  inFlight: null,
  queuedOwnerMessages: 0,
  lastSequence: 12,
  awaitingOwnerObjective: false,
  adapters: {
    reviewer: "codex",
    reviewerVersion: null,
    builder: "claude-code",
    builderVersion: null,
  },
  liveWriter: {
    pid: 4242,
    host: "workstation",
    command: "start",
    runId: "run-77",
    acquiredAt: "2026-03-01T09:00:00.000Z",
    renewedAt: "2026-03-01T10:05:00.000Z",
    isThisProcess: true,
  },
  liveInThisBridge: true,
  ...overrides,
});

/** Peer Loop's durable run state, as an attach hands it over. */
const runState = (overrides: Partial<PeerLoopRunStateFile> = {}): PeerLoopRunStateFile =>
  ({
    schemaVersion: 1,
    runId: "run-77",
    projectPath: "/repos/demo",
    state: "done",
    iteration: 4,
    createdAt: "2026-03-01T09:00:00.000Z",
    updatedAt: "2026-03-01T10:05:00.000Z",
    ownerPolicyText: "",
    builderSessionId: null,
    reviewerThreadId: null,
    repo: null,
    lastBuilderTask: "do not read me",
    lastBuilderReport: "do not read me either",
    lastReviewerDecision: null,
    queuedOwnerMessages: [],
    inFlight: null,
    haltReason: null,
    stopRequested: false,
    adapters: {
      reviewer: "codex",
      reviewerVersion: null,
      builder: "claude-code",
      builderVersion: null,
    },
    safetyLimit: null,
    lastSequence: 20,
    ...overrides,
  }) as PeerLoopRunStateFile;

const context = (
  overrides: Partial<NavigatorExecutionContext> = {},
): NavigatorExecutionContext => ({
  environmentId: ENVIRONMENT_ID,
  threadId: THREAD_ID,
  purpose: "navigator",
  // A conversation loaded from the server: nothing in flight.
  unsettledTurnId: null,
  executionsByProposal: new Map(),
  ...overrides,
});

const PLAN_TURN_ID = TurnId.make("turn-that-produced-the-plan");

const proposal = {
  id: PLAN_ID,
  implementedAt: null,
  implementationThreadId: null,
  turnId: PLAN_TURN_ID,
} as const;

/* ------------------------------------------------------------- action */

describe("the Execute action", () => {
  it("offers it, and says what pressing it starts", async () => {
    const markup = await render(
      <NavigatorProposalExecution context={context()} proposal={proposal} />,
    );
    expect(markup).toContain("Execute with Peer Loop");
    // The press IS the confirmation, and the wording says so plainly rather
    // than leaving the owner to infer what a button labelled Execute does.
    expect(markup).toContain("Reviewer → Builder");
    expect(markup).toContain("Execution Proposal above");
    expect(markup).toContain("never infers it from the conversation");
  });

  it("renders nothing at all on a coding thread", async () => {
    const markup = await render(
      <NavigatorProposalExecution context={context({ purpose: "coding" })} proposal={proposal} />,
    );
    expect(markup).not.toContain("Execute with Peer Loop");
    expect(markup).not.toContain("Peer Loop");
  });

  it("renders nothing in a draft conversation", async () => {
    const markup = await render(
      <NavigatorProposalExecution context={context({ threadId: null })} proposal={proposal} />,
    );
    expect(markup).not.toContain("Execute with Peer Loop");
  });

  it("does not offer it while this proposal's own turn is still producing", async () => {
    const markup = await render(
      <NavigatorProposalExecution
        context={context({ unsettledTurnId: PLAN_TURN_ID })}
        proposal={proposal}
      />,
    );
    expect(markup).not.toContain("Execute with Peer Loop");
  });

  it("offers it while a different turn runs, because this plan is final", async () => {
    const markup = await render(
      <NavigatorProposalExecution
        context={context({ unsettledTurnId: TurnId.make("turn-something-else") })}
        proposal={proposal}
      />,
    );
    expect(markup).toContain("Execute with Peer Loop");
  });

  it("does not offer it for a proposal a coding thread already implemented", async () => {
    const markup = await render(
      <NavigatorProposalExecution
        context={context()}
        proposal={{
          id: PLAN_ID,
          implementedAt: "2026-02-01T00:00:00.000Z",
          implementationThreadId: null,
          turnId: PLAN_TURN_ID,
        }}
      />,
    );
    expect(markup).not.toContain("Execute with Peer Loop");
  });

  it("replaces the action with the execution once one exists", async () => {
    const markup = await render(
      <NavigatorProposalExecution
        context={context({
          executionsByProposal: new Map([[PLAN_ID, [link({ runId: "run-77" })]]]),
        })}
        proposal={proposal}
      />,
    );
    // No second run from this surface, and the run that exists is named.
    expect(markup).not.toContain("Execute with Peer Loop");
    expect(markup).toContain("run-77");
    expect(markup).toContain("Open execution details");
  });

  it("shows a child execution only under its own proposal", async () => {
    const markup = await render(
      <NavigatorProposalExecution
        context={context({
          executionsByProposal: new Map([["plan-other", [link({ runId: "run-elsewhere" })]]]),
        })}
        proposal={proposal}
      />,
    );
    expect(markup).not.toContain("run-elsewhere");
    // And this proposal is still executable, because it has no link of its own.
    expect(markup).toContain("Execute with Peer Loop");
  });
});

/* ------------------------------------------------------------ failures */

describe("a failure the owner has to act on", () => {
  const seedFailure = async (error: unknown) => {
    navigatorExecutionStore.reset();
    await navigatorExecutionStore.execute(
      navigatorExecutionKey({
        environmentId: ENVIRONMENT_ID,
        threadId: THREAD_ID,
        proposedPlanId: PLAN_ID,
      }),
      { run: async () => AsyncResult.failure(Cause.fail(error)) },
    );
  };

  it("names the run, warns not to retry, and links straight to the inspector", async () => {
    await seedFailure(
      new PeerLoopExecutionCoordinationError({
        reason: "link-not-confirmed",
        detail: "internal",
        threadId: THREAD_ID,
        proposedPlanId: PLAN_ID,
        runId: "run-77",
        mayHaveStarted: true,
      }),
    );
    const markup = await render(
      <NavigatorProposalExecution context={context()} proposal={proposal} />,
    );
    expect(markup).toContain("The run started, but the link was not recorded");
    expect(markup).toContain("Do not press Execute again");
    // The exact run id, as a link — not a sentence to read an id out of.
    expect(markup).toContain('href="/peer-loop/run-77"');
    expect(markup).toContain(">run-77<");
    // AND THE BUTTON IS GONE. A run may already exist; offering Execute beside
    // that warning would be an invitation to start a second one.
    expect(markup).not.toContain("Execute with Peer Loop");
    navigatorExecutionStore.reset();
  });

  it("points an already-executed proposal at the run it already has", async () => {
    await seedFailure(
      new PeerLoopExecutionCoordinationError({
        reason: "proposal-already-executed",
        detail: "internal",
        threadId: THREAD_ID,
        proposedPlanId: PLAN_ID,
        runId: "run-12",
        mayHaveStarted: false,
      }),
    );
    const markup = await render(
      <NavigatorProposalExecution context={context()} proposal={proposal} />,
    );
    expect(markup).toContain("already been executed");
    expect(markup).toContain('href="/peer-loop/run-12"');
    navigatorExecutionStore.reset();
  });

  it("mounts a CONTROL_UNAVAILABLE refusal with the action still offered", async () => {
    // THE FIRST PAINT AFTER A MOUNT, with the refusal already in the gate.
    // `CONTROL_UNAVAILABLE` is a provable pre-start refusal: another process
    // holds the project, nothing started, and the owner may press again the
    // moment it lets go. Nothing about mounting is allowed to withhold it, and
    // no new turn or refresh happens before this render.
    await seedFailure(
      new PeerLoopCommandRefusedError({
        code: "CONTROL_UNAVAILABLE",
        detail: "another process is driving this project",
        data: null,
      }),
    );
    const markup = await render(
      <NavigatorProposalExecution context={context()} proposal={proposal} />,
    );
    expect(markup).toContain("Execute with Peer Loop");
    // The notice stays beside it: the owner still has to know why the last
    // press did nothing.
    expect(markup).toContain("Another process is driving this project");
    expect(markup).toContain("CONTROL_UNAVAILABLE");
    navigatorExecutionStore.reset();
  });

  it("keeps a Peer Loop refusal code visible", async () => {
    await seedFailure(
      new PeerLoopCommandRefusedError({
        code: "PROJECT_HAS_UNFINISHED_RUN",
        detail: "run-5 is still going",
        data: { runId: "run-5" },
      }),
    );
    const markup = await render(
      <NavigatorProposalExecution context={context()} proposal={proposal} />,
    );
    expect(markup).toContain("PROJECT_HAS_UNFINISHED_RUN");
    expect(markup).toContain('href="/peer-loop/run-5"');
    // Nothing started, so the owner may still decide to press again.
    expect(markup).toContain("Execute with Peer Loop");
    navigatorExecutionStore.reset();
  });
});

/* --------------------------------------------------------- child cards */

describe("a child execution card", () => {
  const card = (input: {
    readonly runs?: ReadonlyArray<PeerLoopRunSummary>;
    readonly unreadable?: ReadonlyArray<string>;
  }) =>
    render(
      <NavigatorExecutionCard
        presentation={describeExecution({
          link: link({ runId: "run-77" }),
          runs: input.runs ?? [],
          unreadable: input.unreadable ?? [],
          nowMs: NOW_MS,
        })}
      />,
    );

  it("reads an active run from the structured summary and links to the inspector", async () => {
    const markup = await card({ runs: [summary()] });
    expect(markup).toContain("Working");
    expect(markup).toContain("Iteration 4");
    expect(markup).toContain('href="/peer-loop/run-77"');
  });

  it("uses the shared attention labels for OWNER_REQUIRED and driverless runs", async () => {
    expect(
      await card({
        runs: [
          summary({
            state: "owner_required",
            haltReason: { kind: "OWNER_REQUIRED", message: "Which database?" },
          }),
        ],
      }),
    ).toContain("The Reviewer needs your decision");
    expect(await card({ runs: [summary({ liveWriter: null })] })).toContain(
      "Interrupted — no Reviewer or Builder running",
    );
  });

  it("reads failed and done from the run state", async () => {
    expect(await card({ runs: [summary({ state: "error" })] })).toContain("Failed");
    expect(await card({ runs: [summary({ state: "done" })] })).toContain("Done");
  });

  it("says the status is unavailable rather than inventing a lifecycle state", async () => {
    const markup = await card({ runs: [summary({ runId: "run-someone-else" })] });
    expect(markup).toContain("Status unavailable");
    expect(markup).toContain("Nothing is assumed about it");
    for (const invented of ["Working", "Done", "Failed", "Paused", "Idle"]) {
      expect(markup).not.toContain(invented);
    }
  });

  it("says so explicitly when Peer Loop cannot read the run", async () => {
    const markup = await card({ unreadable: ["run-77"] });
    expect(markup).toContain("Record unreadable");
    expect(markup).toMatch(/could not read this run.{0,8}s record/u);
  });

  it("carries no lifecycle control of its own", async () => {
    // Pause, resume, recovery, owner approval and owner messages all need the
    // run's live control snapshot. The card links to where they are safe.
    const markup = await card({ runs: [summary({ state: "interrupted" })] });
    for (const control of ["Pause", "Resume", "Recover", "Abandon", "Approve", "Send message"]) {
      expect(markup).not.toContain(control);
    }
    expect(markup).toContain("Open execution details");
  });
});

/* ------------------------------------------------------ the plan card */

describe("the proposal card it hangs off", () => {
  it("is byte-for-byte unchanged for a coding thread", async () => {
    const withoutSlot = await render(
      <ProposedPlanCard
        planMarkdown={PLAN}
        environmentId={ENVIRONMENT_ID}
        cwd={undefined}
        workspaceRoot="/repos/demo"
      />,
    );
    const withNavigatorArea = await render(
      <ProposedPlanCard
        planMarkdown={PLAN}
        environmentId={ENVIRONMENT_ID}
        cwd={undefined}
        workspaceRoot="/repos/demo"
        executionArea={
          <NavigatorProposalExecution
            context={context({ purpose: "coding" })}
            proposal={proposal}
          />
        }
      />,
    );
    // A coding thread's card renders the same markup whether or not the slot
    // is wired: the execution area contributes nothing to it.
    expect(withNavigatorArea).toBe(withoutSlot);
    expect(withoutSlot).toContain("Plan actions");
  });

  it("keeps its own plan actions usable beside an execution", async () => {
    const markup = await render(
      <ProposedPlanCard
        planMarkdown={PLAN}
        environmentId={ENVIRONMENT_ID}
        cwd={undefined}
        workspaceRoot="/repos/demo"
        executionArea={
          <NavigatorProposalExecution
            context={context({
              executionsByProposal: new Map([[PLAN_ID, [link({ runId: "run-77" })]]]),
            })}
            proposal={proposal}
          />
        }
      />,
    );
    // An active child run does not disable the conversation's own affordances.
    // `disabled=""` is the rendered attribute; the word also occurs inside
    // Tailwind class names, which is why the attribute is what is asserted.
    expect(markup).toContain("Plan actions");
    expect(markup).toContain("Open execution details");
    expect(markup).not.toContain('disabled=""');
  });

  it("keeps them usable while structured child context loads and after it settles", async () => {
    // Refining the proposal is the whole point of the conversation, and a
    // child run — loading, working, or waiting on the owner — must not take it
    // away. Nothing about execution reaches the card's own controls.
    for (const detail of [
      { kind: "loading" },
      { kind: "unavailable" },
      {
        kind: "owner-required",
        decision: { question: "q", why: "w", options: ["a"] },
      },
      {
        kind: "completion",
        completion: { summary: "s", finalState: "f" },
        head: "abc123",
        branch: "main",
      },
    ] as ReadonlyArray<NavigatorExecutionDetail>) {
      const markup = await render(
        <ProposedPlanCard
          planMarkdown={PLAN}
          environmentId={ENVIRONMENT_ID}
          cwd={undefined}
          workspaceRoot="/repos/demo"
          executionArea={
            <NavigatorExecutionCard
              presentation={describeExecution({
                link: link({ runId: "run-77" }),
                runs: [summary({ state: "done" })],
                unreadable: [],
                nowMs: NOW_MS,
              })}
              detail={detail}
            />
          }
        />,
      );
      expect(markup, detail.kind).toContain("Plan actions");
      expect(markup, detail.kind).not.toContain('disabled=""');
    }
  });
});

/* ------------------------------------------------- structured detail */

describe("a finished child execution", () => {
  const doneCard = (detail: NavigatorExecutionDetail) =>
    render(
      <NavigatorExecutionCard
        presentation={describeExecution({
          link: link({ runId: "run-77" }),
          runs: [summary({ state: "done" })],
          unreadable: [],
          nowMs: NOW_MS,
        })}
        detail={detail}
      />,
    );

  it("foregrounds the Reviewer's summary, final state and the recorded HEAD", async () => {
    const markup = await doneCard({
      kind: "completion",
      completion: { summary: "Backfill shipped.", finalState: "Green on main." },
      head: "abc123def456",
      branch: "main",
    });
    expect(markup).toContain("Done");
    expect(markup).toContain("Backfill shipped.");
    expect(markup).toContain("Final state: Green on main.");
    // Peer Loop's own HEAD. No commit list, and no git walked from a browser.
    expect(markup).toContain("abc123def456");
    expect(markup).toContain("main");
    // Deeper inspection stays one link away.
    expect(markup).toContain("Open execution details");
  });

  it("keeps the DONE status when there is no structured completion", async () => {
    const markup = await doneCard({ kind: "completion-missing" });
    expect(markup).toContain("Done");
    expect(markup).toContain("recorded no structured completion summary");
  });

  it("renders the finished run's own reading, not the question it was waiting on", async () => {
    // The two readings a DONE card can be holding, rendered. The one taken
    // while the run was still waiting on the owner produces neither a question
    // nor a completion, which is exactly the card an owner was left looking at
    // when the snapshot did not move with the run.
    const detailFrom = (state: PeerLoopRunStateFile) =>
      describeExecutionDetail({
        status: describeExecution({
          link: link({ runId: "run-77" }),
          runs: [summary({ state: "done", updatedAt: "2026-03-01T10:05:00.000Z" })],
          unreadable: [],
          nowMs: NOW_MS,
        }).status,
        snapshot: { status: "ready", state },
      });

    const stale = await doneCard(
      detailFrom(
        runState({
          state: "owner_required",
          updatedAt: "2026-03-01T10:01:00.000Z",
          lastReviewerDecision: {
            decision: "OWNER_REQUIRED",
            summary: "Blocked on a choice.",
            ownerQuestion: "Which database should the backfill target?",
            whyOwnerIsRequired: "Only the owner can settle it.",
            options: ["Primary", "Replica"],
          },
        }),
      ),
    );
    expect(stale).toContain("Done");
    expect(stale).toContain("recorded no structured completion summary");
    expect(stale).not.toContain("Which database should the backfill target?");

    const refreshed = await doneCard(
      detailFrom(
        runState({
          state: "done",
          updatedAt: "2026-03-01T10:05:00.000Z",
          lastReviewerDecision: {
            decision: "DONE",
            summary: "Backfill shipped.",
            finalState: "Green on main.",
          },
          repo: {
            head: "abc123def456",
            branch: "main",
            worktreeDigest: null,
            isGitRepo: true,
            capturedAt: "2026-03-01T10:05:00.000Z",
          },
        }),
      ),
    );
    expect(refreshed).toContain("Done");
    expect(refreshed).toContain("Backfill shipped.");
    expect(refreshed).toContain("Final state: Green on main.");
    expect(refreshed).toContain("abc123def456");
    expect(refreshed).toContain("main");
    // Neither the old question nor the "no completion" sentence survives it.
    expect(refreshed).not.toContain("Which database should the backfill target?");
    expect(refreshed).not.toContain("recorded no structured completion summary");
  });

  it("keeps the DONE status when the snapshot could not be read", async () => {
    // The status came from the run list and is untouched by a failed attach.
    const markup = await doneCard({ kind: "unavailable" });
    expect(markup).toContain("Done");
    expect(markup).toContain("Additional structured details are unavailable");
  });

  it("says the details are loading without changing the status", async () => {
    const markup = await doneCard({ kind: "loading" });
    expect(markup).toContain("Done");
    expect(markup).toContain("Reading the structured details");
  });
});

describe("a child execution waiting on the owner", () => {
  const ownerCard = (detail: NavigatorExecutionDetail) =>
    render(
      <NavigatorExecutionCard
        presentation={describeExecution({
          link: link({ runId: "run-77" }),
          runs: [
            summary({
              state: "owner_required",
              haltReason: { kind: "OWNER_REQUIRED", message: "Which database?" },
            }),
          ],
          unreadable: [],
          nowMs: NOW_MS,
        })}
        detail={detail}
      />,
    );

  const decided: NavigatorExecutionDetail = {
    kind: "owner-required",
    decision: {
      question: "Which database should the backfill target?",
      why: "Both are in use and only you know which is canonical.",
      options: ["Primary", "Replica"],
    },
  };

  it("shows the question, the reason, and the options", async () => {
    const markup = await ownerCard(decided);
    expect(markup).toContain("The Reviewer needs your decision");
    expect(markup).toContain("waiting for your decision");
    expect(markup).toContain("Which database should the backfill target?");
    expect(markup).toContain("only you know which is canonical");
    expect(markup).toContain("Primary");
    expect(markup).toContain("Replica");
  });

  it("offers no way to answer here, and says where to", async () => {
    const markup = await ownerCard(decided);
    // Answering is a live command against Peer Loop's control snapshot. This
    // card cannot know whether Peer Loop would accept one.
    for (const control of [
      "Approve",
      "Resume",
      "Pause",
      "Recover",
      "Abandon",
      "Send message",
      "<button",
      "<textarea",
      "<input",
    ]) {
      expect(markup).not.toContain(control);
    }
    expect(markup).toContain("Review and respond in execution details");
    expect(markup).toContain('href="/peer-loop/run-77"');
  });

  it("does not invent a question when Peer Loop recorded none", async () => {
    const markup = await ownerCard({ kind: "owner-required-missing" });
    expect(markup).toContain("The Reviewer needs your decision");
    expect(markup).toContain("recorded no structured question");
  });
});

/* --------------------------------------------- an unknown outcome */

describe("an Execute whose result is unknown", () => {
  it("says so, withholds the button, and points at the inspector index", async () => {
    navigatorExecutionStore.reset();
    await navigatorExecutionStore.execute(
      navigatorExecutionKey({
        environmentId: ENVIRONMENT_ID,
        threadId: THREAD_ID,
        proposedPlanId: PLAN_ID,
      }),
      {
        run: async () => {
          throw new Error("socket exploded");
        },
      },
    );
    const markup = await render(
      <NavigatorProposalExecution context={context()} proposal={proposal} />,
    );
    expect(markup).toContain("the result is unknown");
    // A run may exist. Pressing again would be how one intent becomes two.
    expect(markup).not.toContain("Execute with Peer Loop");
    // No run id to name, so the owner is sent to the list to look.
    expect(markup).toContain('href="/peer-loop"');
    expect(markup).toContain("Check Peer Loop for a new run");
    expect(markup).not.toContain("socket exploded");
    navigatorExecutionStore.reset();
  });
});
