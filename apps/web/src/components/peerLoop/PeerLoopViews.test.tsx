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
import { PeerLoopCommandRefusedError, PeerLoopTimeoutError } from "@t3tools/contracts";
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

import { describeError } from "~/peerLoopPresentation";
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

const attachedView = (
  state: PeerLoopRunStateFile,
  control: { available?: boolean; resumable?: boolean } = {},
): PeerLoopRunView =>
  applyPeerLoopSubscriptionEvent(emptyPeerLoopRunView("run-1"), {
    kind: "run-attached",
    runId: "run-1",
    snapshot: {
      runId: "run-1",
      state,
      control: {
        available: control.available ?? true,
        reason: ((control.available ?? true)
          ? "live_in_this_bridge"
          : "held_by_other_process") as never,
        liveWriter: null,
        resumable: control.resumable ?? false,
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
    const html = await detail(attachedView(runState(), { available: false }));
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

  it("offers recovery only for an interrupted run, with no default and a confirmation", async () => {
    const quiet = await detail(attachedView(runState({ state: "paused" })));
    expect(quiet).not.toContain("Choose how to continue");

    const html = await detail(attachedView(runState({ state: "interrupted" })));
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
