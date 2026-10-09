import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import { CodexSettings, type NavigatorApprovalTraits } from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
import { navigatorApprovalClassifierPreset } from "./TextGenerationPresets.ts";

/**
 * This suite is opt-in because it invokes the user's subscription-backed Codex
 * CLI and is intentionally non-blocking for CI and the default test scripts.
 */
const corpusEnabled = process.env.T3_NAVIGATOR_APPROVAL_CORPUS === "1";

const CorpusLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-navigator-approval-corpus-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const CURRENT_PROPOSAL = [
  "# Current Navigator proposal",
  "",
  "Update the repository according to the displayed execution plan.",
].join("\n");

const EXECUTION_DISQUALIFIERS: ReadonlyArray<Exclude<keyof NavigatorApprovalTraits, "confidence">> =
  [
    "addsCondition",
    "requestsModification",
    "asksQuestion",
    "expressesDoubt",
    "isNegation",
    "isQuotationOrHypothetical",
    "referencesSomethingElse",
  ];

const corpusCases: ReadonlyArray<{
  readonly label: string;
  readonly utterance: string;
  readonly expected: "positive" | "negative";
  readonly expectedTraits?: ReadonlyArray<Exclude<keyof NavigatorApprovalTraits, "confidence">>;
}> = [
  {
    label: "positive-1",
    utterance: "Perfecto, me parece bien. Puedes empezar.",
    expected: "positive",
  },
  {
    label: "positive-2",
    utterance: "Listo, aprobado. Dale.",
    expected: "positive",
  },
  {
    label: "positive-3",
    utterance: "Sí, procede con el plan.",
    expected: "positive",
  },
  {
    label: "positive-4",
    utterance: "Me convence, adelante con esto.",
    expected: "positive",
  },
  {
    label: "positive-5",
    utterance: "Todo bien, puedes ejecutarlo.",
    expected: "positive",
  },
  {
    label: "negative-condition-or-modification",
    utterance: "me parece bien pero primero cambia el orden",
    expected: "negative",
    expectedTraits: ["addsCondition", "requestsModification"],
  },
  {
    label: "negative-question",
    utterance: "¿procedo entonces?",
    expected: "negative",
    expectedTraits: ["asksQuestion"],
  },
  {
    label: "negative-modification",
    utterance: "casi, cámbiame el paso 2",
    expected: "negative",
    expectedTraits: ["requestsModification"],
  },
  {
    label: "negative-negation",
    utterance: "no, todavía no",
    expected: "negative",
    expectedTraits: ["isNegation"],
  },
  {
    label: "negative-quotation",
    utterance: "él dijo «adelante con esto»",
    expected: "negative",
    expectedTraits: ["isQuotationOrHypothetical"],
  },
  {
    label: "negative-other-object",
    utterance: "apruébame el otro plan",
    expected: "negative",
    expectedTraits: ["referencesSomethingElse"],
  },
];

function isCleanDirectApproval(traits: NavigatorApprovalTraits): boolean {
  return (
    traits.expressesApproval &&
    traits.confidence === "high" &&
    EXECUTION_DISQUALIFIERS.every((trait) => !traits[trait])
  );
}

function formatCorpusReport(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

it.layer(CorpusLayer)("Navigator approval classifier live corpus", (it) => {
  it.effect.skipIf(!corpusEnabled)("classifies the fixed corpus", () =>
    Effect.gen(function* () {
      const config = yield* Schema.decodeEffect(CodexSettings)({});
      const textGeneration = yield* makeCodexTextGeneration(config);
      const reports: Array<Record<string, unknown>> = [];
      const failures: Array<string> = [];

      for (const testCase of corpusCases) {
        const result = yield* textGeneration
          .classifyNavigatorApproval({
            cwd: process.cwd(),
            ownerUtterance: testCase.utterance,
            planMarkdown: CURRENT_PROPOSAL,
            modelSelection: navigatorApprovalClassifierPreset.modelSelection,
          })
          .pipe(Effect.result);

        if (Result.isFailure(result)) {
          const failure = {
            label: testCase.label,
            utterance: testCase.utterance,
            error: String(result.failure),
          };
          reports.push(failure);
          failures.push(`${testCase.label}: classifier failed`);
          continue;
        }

        const traits = result.success;
        const cleanApproval = isCleanDirectApproval(traits);
        const expectedTraitSatisfied =
          testCase.expectedTraits === undefined ||
          testCase.expectedTraits.some((trait) => traits[trait]);
        const passed =
          (testCase.expected === "positive" ? cleanApproval : !cleanApproval) &&
          expectedTraitSatisfied;
        reports.push({
          label: testCase.label,
          utterance: testCase.utterance,
          traits,
          cleanApproval,
          expectedTraits: testCase.expectedTraits ?? [],
          expected: testCase.expected,
          passed,
        });
        if (!passed) {
          failures.push(`${testCase.label}: semantic expectation missed`);
        }
      }

      yield* Effect.logInfo(
        `[navigator-approval-corpus]\n${formatCorpusReport({
          preset: navigatorApprovalClassifierPreset.modelSelection,
          cases: reports,
        })}`,
      );
      expect(failures).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
