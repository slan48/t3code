/**
 * The Peer Loop surface, rendered to static markup.
 *
 * No browser: these are server-rendered assertions about what an operator is
 * actually shown — which control is disabled, which halt reads which way, and
 * that replaying a Builder task cannot happen without a second, explicit press.
 */
import type {
  PeerLoopHaltKind,
  PeerLoopListRunsResult,
  PeerLoopRunStateFile,
  PeerLoopRunSummary,
  PeerLoopStatusResult,
} from "@t3tools/contracts";
import {
  PeerLoopCommandRefusedError,
  PeerLoopTimeoutError,
  PeerLoopTransportError,
} from "@t3tools/contracts";
import {
  applyPeerLoopSubscriptionEvent,
  emptyPeerLoopRunView,
  type PeerLoopRunView,
} from "@t3tools/client-runtime/state/peer-loop-reducer";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { describeControls, describeError } from "~/peerLoopPresentation";
import { PeerLoopDetailView, IDLE_COMMAND } from "./PeerLoopDetailView";
import { PeerLoopIndexView } from "./PeerLoopIndexView";
import { PeerLoopErrorNotice } from "./PeerLoopPrimitives";
import { PeerLoopStartRun } from "./PeerLoopStartRun";

const adapters = {
  reviewer: "codex",
  reviewerVersion: null,
  builder: "claude-code",
  builderVersion: null,
} as const;

/**
 * Router-aware rendering, because the list and the start form both link to a
 * run. A memory history keeps this a pure string render with no browser.
 */
async function render(node: React.ReactNode): Promise<string> {
  const rootRoute = createRootRoute({ component: () => node });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/" });
  const runRoute = createRoute({ getParentRoute: () => rootRoute, path: "/peer-loop/$runId" });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, runRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router as never} />);
}

const status = (overrides: Partial<PeerLoopStatusResult> = {}): PeerLoopStatusResult =>
  ({
    configured: true,
    executableSource: "path",
    transport: {
      state: "connected",
      changedAt: "2026-08-09T00:00:00.000Z",
      detail: null,
      protocolVersion: 1,
    },
    health: null,
    ...overrides,
  }) as PeerLoopStatusResult;

const summary = (overrides: Partial<PeerLoopRunSummary> = {}): PeerLoopRunSummary =>
  ({
    runId: "run-1",
    projectPath: "/repos/demo",
    state: "builder_working",
    iteration: 2,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:05:00.000Z",
    haltReason: null,
    inFlight: null,
    queuedOwnerMessages: 0,
    lastSequence: 5,
    awaitingOwnerObjective: false,
    adapters,
    liveWriter: null,
    liveInThisBridge: false,
    ...overrides,
  }) as PeerLoopRunSummary;

const runList = (overrides: Partial<PeerLoopListRunsResult> = {}): PeerLoopListRunsResult => ({
  runs: [],
  unreadable: [],
  ...overrides,
});

const runState = (overrides: Partial<PeerLoopRunStateFile> = {}): PeerLoopRunStateFile =>
  ({
    schemaVersion: 1,
    runId: "run-1",
    projectPath: "/repos/demo",
    state: "builder_working",
    iteration: 3,
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:05:00.000Z",
    ownerPolicyText: "OWNER POLICY",
    builderSessionId: null,
    reviewerThreadId: null,
    repo: null,
    lastBuilderTask: "Write NOTES.md. Then STOP.",
    lastBuilderReport: null,
    lastReviewerDecision: null,
    queuedOwnerMessages: [],
    inFlight: null,
    haltReason: null,
    stopRequested: false,
    adapters,
    safetyLimit: null,
    lastSequence: 5,
    ...overrides,
  }) as PeerLoopRunStateFile;

/**
 * The three control snapshots Peer Loop actually produces.
 *
 * Named rather than assembled from booleans, because `available: false` means
 * two entirely different things depending on the reason and a test that mixed
 * them would be asserting on a state the bridge never sends.
 */
const LIVE = { available: true, reason: "live_in_this_bridge", resumable: false } as const;
const LIVE_RESUMABLE = {
  available: true,
  reason: "live_in_this_bridge",
  resumable: true,
} as const;
const HELD = { available: false, reason: "held_by_other_process", resumable: false } as const;
const STOPPED = { available: false, reason: "not_attached", resumable: true } as const;
const STOPPED_FINAL = { available: false, reason: "not_attached", resumable: false } as const;

const attachedView = (
  state: PeerLoopRunStateFile,
  control: {
    readonly available: boolean;
    readonly reason: string;
    readonly resumable: boolean;
  } = LIVE,
): PeerLoopRunView =>
  applyPeerLoopSubscriptionEvent(emptyPeerLoopRunView("run-1"), {
    kind: "run-attached",
    runId: "run-1",
    snapshot: {
      runId: "run-1",
      state,
      control: {
        available: control.available,
        reason: control.reason as never,
        liveWriter: null,
        resumable: control.resumable,
      },
      eventHighWaterMark: 5,
      replayFromSeq: 0,
      live: true,
    },
  });

const noop = () => undefined;

const detail = (
  view: PeerLoopRunView,
  overrides: Partial<Parameters<typeof PeerLoopDetailView>[0]> = {},
) =>
  render(
    <PeerLoopDetailView
      view={view}
      ownerMessage={IDLE_COMMAND}
      pauseState={IDLE_COMMAND}
      resumeState={IDLE_COMMAND}
      recoverState={IDLE_COMMAND}
      actions={{
        sendOwnerMessage: noop,
        pause: noop,
        resume: noop,
        recover: noop,
        reattach: noop,
        retryObservation: noop,
      }}
      {...overrides}
    />,
  );

describe("Peer Loop index", () => {
  it("says a machine has no Peer Loop, and how to point at one", async () => {
    const html = await render(
      <PeerLoopIndexView
        status={status({
          configured: false,
          transport: {
            state: "unavailable",
            changedAt: "",
            detail: null,
            protocolVersion: null,
          },
        })}
        runs={runList()}
        startRun={null}
      />,
    );
    expect(html).toContain("not set up");
    expect(html).toContain("T3_PEER_LOOP_EXECUTABLE");
  });

  it("shows every transport state it can be in", async () => {
    for (const state of ["starting", "connected", "interrupted", "stopped"] as const) {
      const html = await render(
        <PeerLoopIndexView
          status={status({
            transport: { state, changedAt: "", detail: null, protocolVersion: 1 },
          })}
          runs={runList()}
          startRun={null}
        />,
      );
      expect(html).toContain(
        {
          starting: "Starting",
          connected: "Connected",
          interrupted: "Connection ended",
          stopped: "Stopped",
        }[state],
      );
    }
  });

  it("groups runs and names the project and recency", async () => {
    const html = await render(
      <PeerLoopIndexView
        status={status()}
        runs={runList({
          runs: [
            summary({ runId: "needs", state: "owner_required" }),
            summary({ runId: "busy", state: "builder_working" }),
            summary({ runId: "over", state: "done" }),
          ],
        })}
        startRun={null}
      />,
    );
    expect(html).toContain("Needs you");
    expect(html).toContain("Active");
    expect(html).toContain("Recent");
    expect(html).toContain("demo");
    expect(html).toContain("iteration 2");
  });

  it("reports runs Peer Loop could not read rather than hiding them", async () => {
    const html = await render(
      <PeerLoopIndexView
        status={status()}
        runs={runList({ unreadable: ["run-broken"] })}
        startRun={null}
      />,
    );
    expect(html).toContain("Unreadable");
    expect(html).toContain("run-broken");
  });
});

describe("Peer Loop start form", () => {
  it("offers nothing to press when Peer Loop is unavailable, and says why", async () => {
    const html = await render(
      <PeerLoopStartRun
        projects={[{ id: "p1", title: "demo", workspaceRoot: "/repos/demo" }]}
        pending={false}
        error={null}
        disabled
        disabledReason="Peer Loop is not available on this machine."
        onSubmit={noop}
      />,
    );
    expect(html).toContain("disabled");
    expect(html).toContain("Peer Loop is not available on this machine.");
  });

  it("asks for a project before there is one to choose", async () => {
    const html = await render(
      <PeerLoopStartRun
        projects={[]}
        pending={false}
        error={null}
        disabled={false}
        disabledReason={null}
        onSubmit={noop}
      />,
    );
    expect(html).toContain("Add a project to this environment first");
  });

  it("never offers an executable, a permission mode or a newRun override", async () => {
    const html = await render(
      <PeerLoopStartRun
        projects={[{ id: "p1", title: "demo", workspaceRoot: "/repos/demo" }]}
        pending={false}
        error={null}
        disabled={false}
        disabledReason={null}
        onSubmit={noop}
      />,
    );
    expect(html.toLowerCase()).not.toContain("executable");
    expect(html.toLowerCase()).not.toContain("permission mode");
    expect(html.toLowerCase()).not.toContain("newrun");
  });
});

describe("Peer Loop detail", () => {
  it("shows the snapshot Peer Loop sent", async () => {
    const html = await detail(
      attachedView(
        runState({
          iteration: 4,
          inFlight: {
            actor: "builder",
            startedAt: "2026-08-09T00:04:00.000Z",
            iteration: 4,
            taskDigest: null,
            pid: null,
          },
          queuedOwnerMessages: [
            { id: "m1", text: "keep it local", queuedAt: "2026-08-09T00:03:00.000Z" },
          ],
          lastReviewerDecision: {
            decision: "CONTINUE",
            summary: "Baseline established.",
            builderTask: "Write NOTES.md.",
          },
        } as Partial<PeerLoopRunStateFile>),
      ),
    );
    expect(html).toContain("builder_working");
    expect(html).toContain("codex");
    expect(html).toContain("claude-code");
    expect(html).toContain("Current Builder task");
    expect(html).toContain("Write NOTES.md. Then STOP.");
    expect(html).toContain("Last Reviewer decision");
    expect(html).toContain("CONTINUE");
    expect(html).toContain("Queued messages");
  });

  it("distinguishes every halt Peer Loop can report", async () => {
    const expected: Readonly<Record<PeerLoopHaltKind, string>> = {
      OWNER_REQUIRED: "needs your decision",
      OWNER_OBJECTIVE_REQUIRED: "Needs an objective",
      CAPACITY_EXHAUSTED: "capacity exhausted",
      AUTH_REQUIRED: "needs signing in",
      TRANSPORT_INTERRUPTED: "cut off",
      AMBIGUOUS_INTERRUPTED_TURN: "choose how to continue",
      OWNER_PAUSED: "Paused",
      SAFETY_LIMIT: "safety limit",
      SYSTEM_BLOCKED: "Blocked",
      CAPABILITY_MISMATCH: "Failed",
      PROTOCOL_ERROR: "Failed",
      PROCESS_ERROR: "Failed",
    };

    for (const [kind, fragment] of Object.entries(expected)) {
      const html = await detail(
        attachedView(
          runState({
            state: "paused",
            haltReason: { kind: kind as PeerLoopHaltKind, message: `halted: ${kind}` },
          }),
        ),
      );
      expect(html).toContain(fragment);
      // Peer Loop's own words, never a paraphrase.
      expect(html).toContain(`halted: ${kind}`);
    }
  });

  it("shows DONE from Peer Loop's outcome", async () => {
    const view = applyPeerLoopSubscriptionEvent(attachedView(runState({ state: "done" })), {
      kind: "run-finished",
      runId: "run-1",
      outcome: { kind: "done", finalState: "clean", summary: "Everything landed." },
      state: null,
      reason: "terminal",
    });
    const html = await detail(view);
    expect(html).toContain("Done");
    expect(html).toContain("Everything landed.");
  });

  it("surfaces a transport interruption without pretending the run changed", async () => {
    const view = applyPeerLoopSubscriptionEvent(attachedView(runState()), {
      kind: "transport",
      transport: {
        state: "interrupted",
        changedAt: "2026-08-09T00:06:00.000Z",
        detail: "the Peer Loop bridge exited with code 9",
        protocolVersion: null,
      },
    });
    expect(await detail(view)).toContain("Connection: interrupted");
  });

  it("offers to catch up after a resync, and does not do it by itself", async () => {
    const view = applyPeerLoopSubscriptionEvent(attachedView(runState()), {
      kind: "run-resync",
      runId: "run-1",
      afterSeq: 2,
      reason: "this server could not retain the event stream for this client",
    });
    const html = await detail(view);
    expect(html).toContain("missing part of the run");
    expect(html).toContain("Catch up from where it left off");
  });

  it("disables every control when another process holds the project", async () => {
    const html = await detail(attachedView(runState(), HELD));
    expect(html).toContain("Another Peer Loop process");
    // Pause, Resume and Send are all rendered disabled.
    expect(html.match(/disabled=""/gu)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("disables a control that is already in flight", async () => {
    const html = await detail(attachedView(runState()), {
      pauseState: { pending: true, error: null, success: null },
    });
    expect(html).toContain("Pausing…");
  });

  it("offers recovery only for a live interrupted run, with no default and a confirmation", async () => {
    const quiet = await detail(attachedView(runState({ state: "paused" })));
    expect(quiet).not.toContain("Choose how to continue");

    const html = await detail(attachedView(runState({ state: "interrupted" }), LIVE));
    expect(html).toContain("Choose how to continue");
    expect(html).toContain("Hand it back to the Reviewer");
    expect(html).toContain("Run the interrupted task again");
    expect(html).toContain("Abandon the run");
    expect(html).toContain("Nothing happens until you pick one");
    // The dangerous one is behind a second press: the confirmation text is not
    // in the initial render.
    expect(html).not.toContain("Yes, run the task again");
  });

  it("says an owner message is queued for the next Reviewer turn", async () => {
    const html = await detail(attachedView(runState()), {
      ownerMessage: {
        pending: false,
        error: null,
        success: "Queued for the next Reviewer turn (1 waiting).",
      },
    });
    expect(html).toContain("Queued for the next Reviewer turn (1 waiting).");
  });

  it("shows a structured refusal with its code intact", async () => {
    const html = await detail(attachedView(runState()), {
      pauseState: {
        pending: false,
        error: describeError(
          new PeerLoopCommandRefusedError({
            code: "CONTROL_UNAVAILABLE",
            detail: "Another Peer Loop process is already driving this project.",
            data: null,
          }),
        ),
        success: null,
      },
    });
    expect(html).toContain("CONTROL_UNAVAILABLE");
    expect(html).toContain("Another process is driving this project");
  });
});

describe("Peer Loop error notice", () => {
  it("says a timed-out mutation may already have applied and was not retried", async () => {
    const html = renderToStaticMarkup(
      <PeerLoopErrorNotice
        error={describeError(
          new PeerLoopTimeoutError({
            method: "run.recover",
            timeoutMs: 30_000,
            mayHaveApplied: true,
          }),
        )}
      />,
    );
    expect(html).toContain("Nothing was retried for you");
    expect(html).toContain("may still have accepted");
  });

  it("shows an unfamiliar refusal code rather than a shrug", async () => {
    const html = renderToStaticMarkup(
      <PeerLoopErrorNotice
        error={describeError(
          new PeerLoopCommandRefusedError({
            code: "SOMETHING_NEWER",
            detail: "a future build refused this",
            data: null,
          }),
        )}
      />,
    );
    expect(html).toContain("SOMETHING_NEWER");
    expect(html).toContain("a future build refused this");
  });
});

describe("Peer Loop controls against real snapshots", () => {
  it("offers Resume on a stopped run even though control is unavailable", async () => {
    const html = await detail(attachedView(runState({ state: "paused" }), STOPPED));
    expect(html).toContain("Peer Loop is not driving this run right now");
    expect(html).toContain("Resume");
    // Everything that needs a live controller is off.
    expect(html).toContain("Send message");
    expect(html).toContain("disabled");
  });

  it("tells an interrupted stopped run to resume first, and offers no recovery yet", async () => {
    const html = await detail(attachedView(runState({ state: "interrupted" }), STOPPED));
    expect(html).toContain("A turn was in flight when this run stopped");
    // Resuming reconnects and confirms the interruption; it runs no turn.
    expect(html).toContain("runs no Reviewer or Builder turn on its own");
    expect(html).toContain("stays interrupted until you choose");
    expect(html).not.toContain("Choose how to continue");
    expect(html).not.toContain("Run the interrupted task again");
  });

  it("exposes all three recovery choices once the run is interrupted and live", async () => {
    const html = await detail(attachedView(runState({ state: "interrupted" }), LIVE));
    expect(html).toContain("Hand it back to the Reviewer");
    expect(html).toContain("Run the interrupted task again");
    expect(html).toContain("Abandon the run");
    expect(html).not.toContain("Resume first to take control");
  });

  it("keeps a run held by another process entirely read-only", async () => {
    const html = await detail(attachedView(runState({ state: "paused" }), HELD));
    expect(html).toContain("Another Peer Loop process");
    expect(html).not.toContain("Peer Loop is not driving this run right now");
  });

  it("says a live pause lands at the next boundary while an agent is working", async () => {
    expect(await detail(attachedView(runState({ state: "builder_working" }), LIVE))).toContain(
      "Pause at the next boundary",
    );
    expect(await detail(attachedView(runState({ state: "idle" }), LIVE))).toContain(">Pause<");
  });

  it("offers Resume on a live paused run only when Peer Loop says it is resumable", async () => {
    const resumable = await detail(attachedView(runState({ state: "paused" }), LIVE_RESUMABLE));
    expect(resumable).toContain("Resume");
    const notResumable = await detail(attachedView(runState({ state: "paused" }), LIVE));
    expect(notResumable).toContain("Resume");
    // Rendered either way; what changes is whether it can be pressed.
    expect(notResumable.match(/disabled=""/gu)?.length ?? 0).toBeGreaterThan(
      resumable.match(/disabled=""/gu)?.length ?? 0,
    );
  });

  it("offers nothing that changes a finished run", async () => {
    for (const control of [LIVE, STOPPED_FINAL]) {
      const html = await detail(attachedView(runState({ state: "done" }), control));
      expect(html).not.toContain("Choose how to continue");
      expect(html).not.toContain("Resume first to take control");
      // Send, Pause and Resume all rendered disabled.
      expect(html.match(/disabled=""/gu)?.length ?? 0).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("Peer Loop owner-facing structure", () => {
  const ownerRequiredState = runState({
    state: "owner_required",
    lastReviewerDecision: {
      decision: "OWNER_REQUIRED",
      summary: "Needs a product call.",
      ownerQuestion: "Should the export include archived threads?",
      whyOwnerIsRequired: "It changes what leaves the machine and I cannot decide that.",
      options: ["Include them", "Exclude them", "Ask me per thread"],
    },
  } as Partial<PeerLoopRunStateFile>);

  it("shows the question, why it needs you, and every option", async () => {
    const html = await detail(attachedView(ownerRequiredState, LIVE));
    expect(html).toContain("Should the export include archived threads?");
    expect(html).toContain("Why it needs you");
    expect(html).toContain("It changes what leaves the machine");
    expect(html).toContain("Include them");
    expect(html).toContain("Exclude them");
    expect(html).toContain("Ask me per thread");
  });

  it("prefers the outcome Peer Loop reported over the durable decision", async () => {
    const view = applyPeerLoopSubscriptionEvent(attachedView(ownerRequiredState, LIVE), {
      kind: "run-outcome",
      runId: "run-1",
      outcome: {
        kind: "owner_required",
        question: "Ship it behind a flag?",
        why: "The rollout is not mine to choose.",
        options: ["Yes, flagged", "No, wait"],
      },
      state: null,
    });
    const html = await detail(view);
    expect(html).toContain("Ship it behind a flag?");
    expect(html).toContain("Yes, flagged");
    expect(html).not.toContain("Should the export include archived threads?");
  });

  it("offers each option as something to send, and does not send it by rendering", async () => {
    let sent: string | null = null;
    const html = await detail(attachedView(ownerRequiredState, LIVE), {
      actions: {
        sendOwnerMessage: (text: string) => {
          sent = text;
        },
        pause: noop,
        resume: noop,
        recover: noop,
        reattach: noop,
        retryObservation: noop,
      },
    });
    expect(html).toContain("Send");
    expect(sent).toBe(null);
  });

  it("disables the option buttons while an owner message is in flight", async () => {
    const html = await detail(attachedView(ownerRequiredState, LIVE), {
      ownerMessage: { pending: true, error: null, success: null },
    });
    expect(html).toContain("Sending…");
    expect(html.match(/disabled=""/gu)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it("shows capacity evidence with its reset time when the CLI gave one", async () => {
    const html = await detail(
      attachedView(
        runState({
          state: "paused",
          haltReason: { kind: "CAPACITY_EXHAUSTED", message: "Out of capacity." },
          lastBuilderFailure: {
            kind: "CAPACITY_EXHAUSTED",
            source: "result",
            evidence: "usage limit reached",
            resetAt: "2026-08-09T04:00:00.000Z",
          },
        } as Partial<PeerLoopRunStateFile>),
        LIVE,
      ),
    );
    expect(html).toContain("capacity ran out");
    expect(html).toContain("usage limit reached");
    expect(html).toContain("from result");
    expect(html).toContain("Resets at 2026-08-09T04:00:00.000Z");
  });

  it("says no reset time was given rather than inventing one", async () => {
    const html = await detail(
      attachedView(
        runState({
          state: "paused",
          lastBuilderFailure: {
            kind: "CAPACITY_EXHAUSTED",
            source: "stderr",
            evidence: "quota",
            resetAt: null,
          },
        } as Partial<PeerLoopRunStateFile>),
        LIVE,
      ),
    );
    expect(html).toContain("No reset time was given.");
    expect(html).not.toContain("Resets at");
  });

  it("shows auth and transport evidence in their own words", async () => {
    const auth = await detail(
      attachedView(
        runState({
          lastBuilderFailure: {
            kind: "AUTH_REQUIRED",
            source: "stderr",
            evidence: "run `claude login`",
            resetAt: null,
          },
        } as Partial<PeerLoopRunStateFile>),
        LIVE,
      ),
    );
    expect(auth).toContain("needs signing in");
    expect(auth).toContain("run `claude login`");

    const transport = await detail(
      attachedView(
        runState({
          lastBuilderFailure: {
            kind: "TRANSPORT_INTERRUPTED",
            source: "transport",
            evidence: "stream ended",
            resetAt: null,
          },
        } as Partial<PeerLoopRunStateFile>),
        LIVE,
      ),
    );
    expect(transport).toContain("was cut off");
    expect(transport).toContain("stream ended");
  });

  it("shows the final state of a finished run", async () => {
    const fromOutcome = applyPeerLoopSubscriptionEvent(
      attachedView(runState({ state: "done" }), LIVE),
      {
        kind: "run-finished",
        runId: "run-1",
        outcome: { kind: "done", finalState: "clean worktree, all tests green", summary: "Done." },
        state: null,
        reason: "terminal",
      },
    );
    expect(await detail(fromOutcome)).toContain("clean worktree, all tests green");

    const fromDecision = await detail(
      attachedView(
        runState({
          state: "done",
          lastReviewerDecision: {
            decision: "DONE",
            summary: "Objective met.",
            finalState: "documented and merged",
          },
        } as Partial<PeerLoopRunStateFile>),
        STOPPED_FINAL,
      ),
    );
    expect(fromDecision).toContain("documented and merged");
  });
});

describe("Peer Loop observation failures", () => {
  it("says a run could not be observed instead of rendering an empty run", async () => {
    const html = await detail(emptyPeerLoopRunView("run-1"), {
      observation: {
        waiting: false,
        empty: true,
        error: describeError(
          new PeerLoopCommandRefusedError({
            code: "RUN_NOT_FOUND",
            detail: "Peer Loop has no run with that id.",
            data: null,
          }),
        ),
      },
    });
    expect(html).toContain("RUN_NOT_FOUND");
    expect(html).toContain("Try to observe this run again");
    expect(html).toContain("only reads");
    // Nothing that could change the run is on the page.
    expect(html).not.toContain("Send message");
    expect(html).not.toContain("Choose how to continue");
  });

  it("keeps a run readable when observation fails after it had already loaded", async () => {
    const html = await detail(attachedView(runState(), LIVE), {
      observation: {
        waiting: false,
        empty: false,
        error: describeError(
          new PeerLoopTransportError({ detail: "the Peer Loop bridge stopped", exitCode: null }),
        ),
      },
    });
    expect(html).toContain("connection to Peer Loop ended");
    expect(html).toContain("Try to observe this run again");
    // The snapshot it already had is still shown.
    expect(html).toContain("builder_working");
  });

  it("says it is still reading before anything has arrived", async () => {
    const html = await detail(emptyPeerLoopRunView("run-1"), {
      observation: { waiting: true, empty: true, error: null },
    });
    expect(html).toContain("Reading this run from Peer Loop…");
  });
});

describe("Peer Loop interrupted run, end to end", () => {
  it("goes stopped-resumable → resume → live, and only then offers the choices", async () => {
    // 1. The snapshot of a run you come back to: nobody is driving it, and Peer
    //    Loop says it can be resumed.
    const stopped = attachedView(runState({ state: "interrupted" }), STOPPED);
    const stoppedControls = describeControls(stopped);
    expect(stoppedControls.canResume).toBe(true);
    expect(stoppedControls.canRecover).toBe(false);
    expect(stoppedControls.resumeBeforeRecover).toBe(true);

    const before = await detail(stopped);
    expect(before).toContain("Resume");
    expect(before).toContain("runs no Reviewer or Builder turn on its own");
    expect(before).not.toContain("Hand it back to the Reviewer");
    expect(before).not.toContain("Abandon the run");

    // 2. `run.resume` establishes ownership and reports the interruption. The
    //    run is still interrupted; observation is restarted and the live
    //    snapshot is what comes back.
    const live = attachedView(runState({ state: "interrupted" }), LIVE);
    const liveControls = describeControls(live);
    expect(liveControls.canResume).toBe(false);
    expect(liveControls.canRecover).toBe(true);
    expect(liveControls.resumeBeforeRecover).toBe(false);

    // 3. All three choices, none selected, none invoked by rendering.
    let recovered: string | null = null;
    const after = await detail(live, {
      actions: {
        sendOwnerMessage: noop,
        pause: noop,
        resume: noop,
        recover: (choice: string) => {
          recovered = choice;
        },
        reattach: noop,
        retryObservation: noop,
      },
    });
    expect(after).toContain("Hand it back to the Reviewer");
    expect(after).toContain("Run the interrupted task again");
    expect(after).toContain("Abandon the run");
    expect(after).toContain("Nothing happens until you pick one");
    expect(after).not.toContain("runs no Reviewer or Builder turn on its own");
    // The dangerous choice still needs a second, explicit press.
    expect(after).not.toContain("Yes, run the task again");
    expect(recovered).toBe(null);
  });
});
