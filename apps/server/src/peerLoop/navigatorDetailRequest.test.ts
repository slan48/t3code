/**
 * When Navigator opens a run's replay, and — much more often — when it does not.
 *
 * The rejections carry the weight. A false positive costs a bridge subscription
 * and puts somebody else's Builder prose in front of a model on a turn where
 * the Owner only asked whether the run had finished, so every ordinary question
 * anybody would plausibly type is listed below as a "no".
 */
import type {
  OrchestrationPeerLoopExecution,
  OrchestrationProposedPlanId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  normalizeDetailRequestText,
  requestsDetailedActivity,
  selectDetailTarget,
} from "./navigatorDetailRequest.ts";

const link = (input: {
  readonly runId: string;
  readonly createdAt: string;
}): OrchestrationPeerLoopExecution => ({
  runId: input.runId,
  proposedPlanId: "plan-1" as OrchestrationProposedPlanId,
  createdAt: input.createdAt,
});

const LINKS = [
  link({ runId: "run-old", createdAt: "2026-03-01T10:00:00.000Z" }),
  link({ runId: "run-new", createdAt: "2026-03-05T10:00:00.000Z" }),
];

/* -------------------------------------------------------- recognition */

describe("asking for detail", () => {
  it("recognizes the English forms an Owner actually types", () => {
    for (const text of [
      "show me the execution activity",
      "Show the run transcript.",
      "what happened step by step?",
      "walk me through what happened",
      "give me the full activity log",
      "can you explain the run history?",
      "show me the detailed breakdown",
      "tell me what happened, blow by blow",
      "explain the events in detail",
    ]) {
      expect(requestsDetailedActivity(text), JSON.stringify(text)).toBe(true);
    }
  });

  it("recognizes the Spanish forms", () => {
    for (const text of [
      "muéstrame la actividad de la ejecución",
      "muéstrame la transcripción",
      "¿qué pasó paso a paso?",
      "dame el historial completo",
      "explícame los eventos en detalle",
      "muestra el registro de la ejecución",
    ]) {
      expect(requestsDetailedActivity(text), JSON.stringify(text)).toBe(true);
    }
  });

  it("recognizes an explicit demand for the exact cause of a failure", () => {
    for (const text of [
      "why exactly did the run fail?",
      "what exactly went wrong?",
      "tell me exactly why it stopped",
      "¿por qué exactamente falló?",
      "explícame exactamente qué salió mal",
    ]) {
      expect(requestsDetailedActivity(text), JSON.stringify(text)).toBe(true);
    }
  });

  it("folds accents, case, hyphens and typographic apostrophes", () => {
    expect(requestsDetailedActivity("STEP-BY-STEP, please")).toBe(true);
    expect(requestsDetailedActivity("¿Qué pasó PASO A PASO?")).toBe(true);
    expect(normalizeDetailRequestText("¿Qué pasó Paso-A-Paso?")).toBe("¿que paso paso a paso?");
  });
});

describe("what stays a structured-context turn", () => {
  const ordinary = [
    // Status questions. These are what the compact facts already answer.
    "how is it going?",
    "what changed?",
    "is it done?",
    "did it finish?",
    "any news on that run?",
    "what's the status?",
    "¿cómo va?",
    "¿ya terminó?",
    "¿qué cambió?",
    // A bare why. The structured halt reason answers this one.
    "why did it fail?",
    "why did it stop?",
    "¿por qué falló?",
    // Ordinary planning conversation.
    "what should we plan next?",
    "let's compare the two approaches",
    "can you refine step 3 of the proposal?",
    "I think the migration should be split",
    "does the plan cover the rollback?",
    "",
    "   ",
  ];

  it("recognizes none of it", () => {
    for (const text of ordinary) {
      expect(requestsDetailedActivity(text), JSON.stringify(text)).toBe(false);
    }
  });

  it("does not fire on the word 'why' alone, however it is dressed", () => {
    // The gate is `exactly`, not `why`. Without it this is a question the
    // structured context already answers, and opening a replay for it would
    // make every failed run cost a subscription.
    expect(requestsDetailedActivity("why? the run failed")).toBe(false);
    expect(requestsDetailedActivity("do you know why the builder errored")).toBe(false);
  });
});

/* ------------------------------------------------------------- target */

describe("choosing which run to read", () => {
  it("reads nothing at all when the message is not a request", () => {
    expect(selectDetailTarget({ text: "how is it going?", links: LINKS })).toEqual({
      kind: "none",
    });
  });

  it("reads nothing when the conversation has no links", () => {
    expect(selectDetailTarget({ text: "show me the activity", links: [] })).toEqual({
      kind: "none",
    });
  });

  it("reads the newest link when no run is named", () => {
    expect(selectDetailTarget({ text: "show me the run transcript", links: LINKS })).toEqual({
      kind: "run",
      runId: "run-new",
    });
  });

  it("reads the named link when the Owner names one", () => {
    expect(selectDetailTarget({ text: "show me the activity for run-old", links: LINKS })).toEqual({
      kind: "run",
      runId: "run-old",
    });
  });

  it("never reads a run this conversation did not launch", () => {
    /*
     * THE ONE THAT MATTERS. A run id the Owner names but never executed from
     * here is not in `links`, so it cannot be selected — the request falls back
     * to this conversation's own newest run rather than reading a stranger's.
     */
    const target = selectDetailTarget({
      text: "show me the activity for run-somebody-elses",
      links: LINKS,
    });
    expect(target).toEqual({ kind: "run", runId: "run-new" });
  });

  it("does not match a run id inside a longer one", () => {
    const prefixed = [
      link({ runId: "run-1", createdAt: "2026-03-01T10:00:00.000Z" }),
      link({ runId: "run-12", createdAt: "2026-03-02T10:00:00.000Z" }),
    ];
    // Naming `run-12` must not select `run-1` just because it is a prefix.
    expect(selectDetailTarget({ text: "show the activity for run-12", links: prefixed })).toEqual({
      kind: "run",
      runId: "run-12",
    });
    expect(selectDetailTarget({ text: "show the activity for run-1", links: prefixed })).toEqual({
      kind: "run",
      runId: "run-1",
    });
  });

  it("returns one run, never several", () => {
    const target = selectDetailTarget({
      text: "show me the activity for run-old and run-new",
      links: LINKS,
    });
    // Newest of the named ones. One replay per turn, always.
    expect(target).toEqual({ kind: "run", runId: "run-new" });
  });
});
