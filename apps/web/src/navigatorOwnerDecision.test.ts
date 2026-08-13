/**
 * What an owner may answer on a linked child execution, and with what.
 *
 * The failure this file exists to prevent is a click answering a question the
 * run is no longer asking, or answering it with a different option than the one
 * pressed. So the assertions are about two things: which readings produce an
 * action at all, and whether an option's number survives everything
 * presentation does to its text.
 */
import type { PeerLoopRunStateFile, ThreadId as ThreadIdType } from "@t3tools/contracts";
import { PeerLoopCommandRefusedError, ThreadId } from "@t3tools/contracts";
import {
  peerLoopDecisionFingerprint,
  peerLoopOwnerDecisionFingerprint,
} from "@t3tools/shared/peerLoopDecisionFingerprint";
import { describe, expect, it } from "vite-plus/test";

import {
  describeOwnerDecisionAction,
  describeOwnerDecisionAnswerFailure,
  NAVIGATOR_OPTION_DISPLAY_CHARS,
  NO_EXECUTION_SNAPSHOT,
  presentOwnerDecisionOptions,
  type NavigatorExecutionSnapshot,
} from "./navigatorExecution";

const THREAD_ID = ThreadId.make("thread-navigator-1");
const RUN_ID = "20260812T062443Z-4eb56b42";

const adapters = {
  reviewer: "codex",
  reviewerVersion: null,
  builder: "claude-code",
  builderVersion: null,
} as const;

/** Iteration 2 of the real run this feature was built from. */
const DECISION = {
  decision: "OWNER_REQUIRED" as const,
  summary: "The local commit is verified.",
  ownerQuestion: "What should happen next with the verified local commit?",
  whyOwnerIsRequired: "Publishing is reserved for the owner.",
  options: [
    "Option A — Publish/push it yourself.",
    "Option B — Authorize the assistant in a future instruction.",
    "Option C — Do not publish; keep the commit local only.",
  ],
};

const ready = (overrides: Partial<PeerLoopRunStateFile> = {}): NavigatorExecutionSnapshot => ({
  status: "ready",
  state: {
    schemaVersion: 1,
    runId: RUN_ID,
    projectPath: "/repos/demo",
    state: "owner_required",
    iteration: 2,
    createdAt: "2026-08-12T06:24:43.000Z",
    updatedAt: "2026-08-12T06:40:00.000Z",
    ownerPolicyText: "",
    builderSessionId: null,
    reviewerThreadId: null,
    repo: null,
    lastBuilderTask: null,
    lastBuilderReport: null,
    lastReviewerDecision: DECISION,
    queuedOwnerMessages: [],
    inFlight: null,
    haltReason: null,
    stopRequested: false,
    adapters,
    safetyLimit: null,
    lastSequence: 85,
    ...overrides,
  } as PeerLoopRunStateFile,
});

const describeAction = (
  input: {
    readonly snapshot?: NavigatorExecutionSnapshot;
    readonly threadId?: ThreadIdType | null;
    readonly linkedToThread?: boolean;
    readonly capable?: boolean;
  } = {},
) =>
  describeOwnerDecisionAction({
    snapshot: input.snapshot ?? ready(),
    threadId: input.threadId === undefined ? THREAD_ID : input.threadId,
    runId: RUN_ID,
    linkedToThread: input.linkedToThread ?? true,
    capable: input.capable ?? true,
    fingerprintOf: peerLoopOwnerDecisionFingerprint,
  });

describe("the answerable decision a card holds", () => {
  it("names the decision and every option, with Peer Loop's own indices", () => {
    expect(describeAction()).toEqual({
      runId: RUN_ID,
      threadId: THREAD_ID,
      fingerprint: peerLoopDecisionFingerprint({
        ownerQuestion: DECISION.ownerQuestion,
        whyOwnerIsRequired: DECISION.whyOwnerIsRequired,
        options: DECISION.options,
        iteration: 2,
      }),
      options: [
        { index: 0, label: DECISION.options[0] },
        { index: 1, label: DECISION.options[1] },
        { index: 2, label: DECISION.options[2] },
      ],
    });
  });

  it("fingerprints the full untruncated reading, not what a card shows", () => {
    // A card bounds what it draws. The fingerprint has to name what Peer Loop
    // wrote, character for character, or the server rightly refuses it.
    const long = "q".repeat(4000);
    const action = describeAction({
      snapshot: ready({
        lastReviewerDecision: { ...DECISION, ownerQuestion: long },
      } as Partial<PeerLoopRunStateFile>),
    });
    expect(action?.fingerprint).toBe(
      peerLoopDecisionFingerprint({
        ownerQuestion: long,
        whyOwnerIsRequired: DECISION.whyOwnerIsRequired,
        options: DECISION.options,
        iteration: 2,
      }),
    );
  });

  it("moves with the iteration, so a second question is a second decision", () => {
    const later = describeAction({ snapshot: ready({ iteration: 3 }) });
    expect(later?.fingerprint).not.toBe(describeAction()?.fingerprint);
  });

  it("offers nothing when there is no fresh structured question", () => {
    const cases: ReadonlyArray<readonly [string, NavigatorExecutionSnapshot]> = [
      ["loading", { status: "loading", state: null }],
      ["failed", { status: "failed", state: null }],
      ["absent", NO_EXECUTION_SNAPSHOT],
      ["working", ready({ state: "builder_working" })],
      ["done", ready({ state: "done" })],
      ["no recorded decision", ready({ lastReviewerDecision: null })],
      [
        "a CONTINUE decision",
        ready({
          lastReviewerDecision: { decision: "CONTINUE", summary: "s", builderTask: "t" },
        } as Partial<PeerLoopRunStateFile>),
      ],
    ];
    for (const [label, snapshot] of cases) {
      expect(describeAction({ snapshot }), label).toBeNull();
    }
  });

  it("offers nothing while an owner response is already queued", () => {
    // One answer at a time. The server refuses a second, and the control does
    // not invite one.
    expect(
      describeAction({
        snapshot: ready({
          queuedOwnerMessages: [
            { id: "q1", text: "Option C", queuedAt: "2026-08-12T06:41:00.000Z" },
          ],
        } as Partial<PeerLoopRunStateFile>),
      }),
    ).toBeNull();
  });

  it("offers nothing without the capability, a durable thread, or a link", () => {
    // The capability is UI hygiene; the thread and the link are what make this
    // conversation entitled to answer at all. The server proves the link again.
    expect(describeAction({ capable: false })).toBeNull();
    expect(describeAction({ threadId: null })).toBeNull();
    expect(describeAction({ linkedToThread: false })).toBeNull();
  });
});

describe("drawing options without renumbering them", () => {
  const option = (index: number, label: string) => ({ index, label });

  it("keeps each option's own index when one is not drawn", () => {
    // AN EMPTY OPTION IS NOT DRAWN AND THE REST KEEP THEIR NUMBERS. Shifting
    // them would send the owner's click to a different sentence.
    expect(
      presentOwnerDecisionOptions([
        option(0, "Publish it"),
        option(1, "   "),
        option(2, "Keep it local"),
      ]),
    ).toEqual([
      { index: 0, label: "Publish it" },
      { index: 2, label: "Keep it local" },
    ]);
  });

  it("bounds a long label without touching the index", () => {
    const long = "a".repeat(400);
    const shown = presentOwnerDecisionOptions([option(0, "short"), option(1, long)]);
    expect(shown[1]?.index).toBe(1);
    expect(shown[1]?.label.length).toBeLessThanOrEqual(NAVIGATOR_OPTION_DISPLAY_CHARS);
    expect(shown[1]?.label).not.toBe(long);
  });

  it("treats separator-like content as text, not as more options", () => {
    const shown = presentOwnerDecisionOptions([
      option(0, "first\nsecond|third:fourth"),
      option(1, "next"),
    ]);
    expect(shown).toHaveLength(2);
    expect(shown[0]?.index).toBe(0);
    expect(shown[1]).toEqual({ index: 1, label: "next" });
  });

  it("never changes what the fingerprint was computed from", () => {
    // Presentation is downstream of the fingerprint: the action carries the raw
    // options, and drawing them cannot alter the value already computed.
    const action = describeAction({
      snapshot: ready({
        lastReviewerDecision: {
          ...DECISION,
          options: ["", "b".repeat(500), "c"],
        },
      } as Partial<PeerLoopRunStateFile>),
    });
    expect(action?.fingerprint).toBe(
      peerLoopDecisionFingerprint({
        ownerQuestion: DECISION.ownerQuestion,
        whyOwnerIsRequired: DECISION.whyOwnerIsRequired,
        options: ["", "b".repeat(500), "c"],
        iteration: 2,
      }),
    );
    // The empty option is dropped from the buttons; the survivors keep 1 and 2.
    expect(presentOwnerDecisionOptions(action?.options ?? []).map((o) => o.index)).toEqual([1, 2]);
  });
});

describe("when answering fails", () => {
  it("keeps a Peer Loop refusal code and its own wording", () => {
    const failure = describeOwnerDecisionAnswerFailure(
      new PeerLoopCommandRefusedError({
        code: "INVALID_RUN_STATE",
        detail: "the run stopped accepting owner messages",
        data: null,
      }),
    );
    expect(failure.code).toBe("INVALID_RUN_STATE");
  });

  it("gives a coordination refusal one fixed sentence and no server text", () => {
    const failure = describeOwnerDecisionAnswerFailure({
      _tag: "PeerLoopOwnerDecisionCoordinationError",
      reason: "run-not-linked-to-thread",
      detail: "SQL: SELECT * FROM projection_thread_peer_loop_executions",
      threadId: THREAD_ID,
      runId: RUN_ID,
    });
    expect(failure.detail).not.toContain("SELECT");
    expect(failure.detail).toContain("does not have a record of that run");
    expect(failure.code).toBeNull();
  });

  it("says nothing it cannot stand behind for an unclassified failure", () => {
    const failure = describeOwnerDecisionAnswerFailure(new Error("socket exploded"));
    expect(failure.title).toBe("The answer was not delivered");
    expect(failure.detail).not.toContain("socket exploded");
    expect(failure.code).toBeNull();
  });
});
