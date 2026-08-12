/**
 * What a mutating source-control action sends, and when it refuses to send.
 *
 * Two facts, and they are the same gate: the request has to name the
 * conversation it came from, and a conversation that may not mutate has to be
 * stopped here rather than at the server. HIDING THE CONTROL IS NOT THE SECOND
 * ONE — a publish dialog left open across a thread change, a toast retry, or a
 * callback captured before the capability flipped all still hold a live
 * reference to this dispatch path.
 */
import { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { threadCapabilities } from "~/navigatorCapabilities";
import { sourceControlMutationGate, type SourceControlActionScope } from "./sourceControlActions";

const ENVIRONMENT_ID = "environment-local" as never;
const THREAD_ID = ThreadId.make("thread-1");

const scopeFor = (purpose: "navigator" | "coding"): SourceControlActionScope => ({
  environmentId: ENVIRONMENT_ID,
  cwd: "/repos/demo",
  mutation: {
    threadId: THREAD_ID,
    // Read from the capability record rather than written by hand: the point is
    // that this dispatch path and the header answer the same question.
    allowed: threadCapabilities(purpose).canUseSourceControlActions,
  },
});

const refusal = (gate: ReturnType<typeof sourceControlMutationGate>) => {
  if (gate.kind !== "refused") throw new Error("expected a refusal");
  return Option.getOrThrow(Cause.findErrorOption(gate.result.cause));
};

describe("the source control mutation gate", () => {
  it("carries the active thread on both mutation paths", () => {
    const coding = scopeFor("coding");
    // The two RPCs B4 names. Both spread this exact origin into their payload,
    // so the server can resolve the conversation instead of guessing from cwd.
    for (const operation of ["git.runStackedAction", "sourceControl.publishRepository"]) {
      const gate = sourceControlMutationGate(coding, operation);
      expect(gate.kind).toBe("allowed");
      expect(gate.kind === "allowed" ? gate.origin : null).toEqual({ originThreadId: THREAD_ID });
    }
  });

  it("refuses a planning conversation before anything is sent", () => {
    for (const operation of ["git.runStackedAction", "sourceControl.publishRepository"]) {
      const gate = sourceControlMutationGate(scopeFor("navigator"), operation);
      if (gate.kind !== "refused") throw new Error("expected a refusal");

      // Typed and presentable, and the same error the server would return —
      // the surface showing it does not have to know which side refused.
      const error = refusal(gate);
      expect(error._tag).toBe("SourceControlThreadForbiddenError");
      expect(error).toMatchObject({
        operation,
        reason: "navigator_thread",
        threadId: THREAD_ID,
      });
      expect(AsyncResult.isFailure(gate.result)).toBe(true);
    }
  });

  it("still refuses a stale dispatch once the capability has flipped", () => {
    // The dialog was opened while this was allowed; the scope it captured is
    // rebuilt from current capabilities, and the pending call dies here.
    const stale: SourceControlActionScope = {
      ...scopeFor("coding"),
      mutation: { threadId: THREAD_ID, allowed: false },
    };
    expect(sourceControlMutationGate(stale, "sourceControl.publishRepository").kind).toBe(
      "refused",
    );
  });

  it("leaves a caller with no conversation exactly as it was", () => {
    // Project-level and non-chat entry points genuinely have no originating
    // thread. They send no origin and are not refused — the server treats them
    // as unscoped, which is what they have always been.
    const unscoped: SourceControlActionScope = {
      environmentId: ENVIRONMENT_ID,
      cwd: "/repos/demo",
    };
    const gate = sourceControlMutationGate(unscoped, "git.runStackedAction");
    expect(gate.kind).toBe("allowed");
    expect(gate.kind === "allowed" ? gate.origin : null).toEqual({});
  });

  it("sends no origin for a draft, which has no durable thread yet", () => {
    const draft: SourceControlActionScope = {
      environmentId: ENVIRONMENT_ID,
      cwd: "/repos/demo",
      mutation: { threadId: null, allowed: true },
    };
    const gate = sourceControlMutationGate(draft, "git.runStackedAction");
    expect(gate.kind).toBe("allowed");
    // Not the draft's local id: the server would refuse an id it cannot
    // resolve, which would break an ordinary coding draft.
    expect(gate.kind === "allowed" ? gate.origin : null).toEqual({});
  });
});
