import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  NAVIGATOR_APPROVAL_OWNER_UTTERANCE_MAX_CHARS,
  NavigatorApprovalClassificationRpcInput,
  NavigatorApprovalClassificationRpcResult,
  NavigatorApprovalTraits,
} from "./navigatorApprovalClassification.ts";
import { WS_METHODS, WsRpcGroup } from "./rpc.ts";

const VALID_TRAITS = {
  expressesApproval: true,
  addsCondition: false,
  requestsModification: false,
  asksQuestion: false,
  expressesDoubt: false,
  isNegation: false,
  isQuotationOrHypothetical: false,
  referencesSomethingElse: false,
  isBareAffirmation: true,
  confidence: "high",
} as const;

const decode = Schema.decodeUnknownSync(NavigatorApprovalTraits);
const decodeRpcInput = Schema.decodeUnknownSync(NavigatorApprovalClassificationRpcInput);
const decodeRpcResult = Schema.decodeUnknownSync(NavigatorApprovalClassificationRpcResult);

const VALID_RPC_INPUT = {
  threadId: "thread-navigator",
  proposedPlanId: "proposal-1",
  proposalFingerprint: "a".repeat(32),
  ownerUtterance: "Sí, procede con el plan.",
  hasAttachments: false,
} as const;

describe("NavigatorApprovalTraits", () => {
  it("requires every trait field", () => {
    for (const field of Object.keys(VALID_TRAITS)) {
      const input = { ...VALID_TRAITS };
      delete input[field as keyof typeof input];
      expect(() => decode(input)).toThrow();
    }
  });

  it("accepts only high or low confidence", () => {
    expect(decode({ ...VALID_TRAITS, confidence: "high" }).confidence).toBe("high");
    expect(decode({ ...VALID_TRAITS, confidence: "low" }).confidence).toBe("low");
    expect(() => decode({ ...VALID_TRAITS, confidence: "medium" })).toThrow();
  });

  it("rejects invalid trait field types", () => {
    expect(() => decode({ ...VALID_TRAITS, expressesApproval: "yes" })).toThrow();
    expect(() => decode({ ...VALID_TRAITS, isBareAffirmation: 1 })).toThrow();
    expect(() => decode({ ...VALID_TRAITS, confidence: true })).toThrow();
  });

  it("generates a closed JSON object with all fields required", () => {
    const document = Schema.toJsonSchemaDocument(NavigatorApprovalTraits);
    expect(document.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: Object.keys(VALID_TRAITS),
    });
    expect(Object.keys(document.schema.properties ?? {}).toSorted()).toEqual(
      Object.keys(VALID_TRAITS).toSorted(),
    );
  });

  it("defines a bounded RPC input without client authority over execution context", () => {
    expect(decodeRpcInput(VALID_RPC_INPUT)).toEqual(VALID_RPC_INPUT);
    expect(() => decodeRpcInput({ ...VALID_RPC_INPUT, ownerUtterance: "" })).toThrow();
    expect(() => decodeRpcInput({ ...VALID_RPC_INPUT, ownerUtterance: " \t\n" })).toThrow();
    expect(() =>
      decodeRpcInput({
        ...VALID_RPC_INPUT,
        ownerUtterance: "x".repeat(NAVIGATOR_APPROVAL_OWNER_UTTERANCE_MAX_CHARS + 1),
      }),
    ).toThrow();
    expect(() => {
      const { ownerUtterance: _ownerUtterance, ...missing } = VALID_RPC_INPUT;
      decodeRpcInput(missing);
    }).toThrow();
    expect(() =>
      decodeRpcInput({
        ...VALID_RPC_INPUT,
        cwd: "/tmp/project",
        outcome: "EXECUTE",
      }),
    ).toThrow();
  });

  it("keeps the result union closed and fail-closed", () => {
    expect(decodeRpcResult({ outcome: "classified", traits: VALID_TRAITS })).toMatchObject({
      outcome: "classified",
      traits: VALID_TRAITS,
    });
    expect(decodeRpcResult({ outcome: "send-to-provider" })).toEqual({
      outcome: "send-to-provider",
    });
    expect(() =>
      decodeRpcResult({ outcome: "classified", traits: VALID_TRAITS, execute: true }),
    ).toThrow();
    expect(() =>
      decodeRpcResult({ outcome: "send-to-provider", reason: "not-navigator" }),
    ).toThrow();
    expect(
      Schema.toJsonSchemaDocument(NavigatorApprovalClassificationRpcInput).schema,
    ).toMatchObject({
      additionalProperties: false,
    });
    expect(
      Schema.toJsonSchemaDocument(NavigatorApprovalClassificationRpcResult).schema,
    ).toMatchObject({
      anyOf: expect.arrayContaining([expect.objectContaining({ additionalProperties: false })]),
    });
  });

  it("registers the authenticated navigator classification method", () => {
    expect(WS_METHODS.navigatorClassifyProposalApproval).toBe("navigator.classifyProposalApproval");
    expect(WsRpcGroup.requests.has(WS_METHODS.navigatorClassifyProposalApproval)).toBe(true);
  });
});
