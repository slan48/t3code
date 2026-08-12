/**
 * The wire shape of a publish, and of the refusal it can come back with.
 *
 * Publishing creates a remote repository and pushes to it, so who asked has to
 * survive the round trip: the server resolves the originating conversation in
 * its own read model and refuses a Navigator one. Both halves of that are
 * schema, so both are checked here.
 */
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  SourceControlPublishRepositoryInput,
  SourceControlThreadForbiddenError,
} from "./sourceControl.ts";

const decodePublishInput = Schema.decodeUnknownSync(SourceControlPublishRepositoryInput);
const encodePublishInput = Schema.encodeSync(SourceControlPublishRepositoryInput);
const decodeForbidden = Schema.decodeUnknownSync(SourceControlThreadForbiddenError);

describe("SourceControlPublishRepositoryInput", () => {
  it("carries the originating thread when the caller has one", () => {
    const parsed = decodePublishInput({
      cwd: "/repos/demo",
      provider: "github",
      repository: "acme/demo",
      visibility: "private",
      originThreadId: "thread-1",
    });

    expect(parsed.originThreadId).toBe("thread-1");
    expect(encodePublishInput(parsed)).toMatchObject({ originThreadId: "thread-1" });
  });

  it("stays optional, so genuinely unscoped callers are unchanged", () => {
    const parsed = decodePublishInput({
      cwd: "/repos/demo",
      provider: "github",
      repository: "acme/demo",
      visibility: "private",
    });

    expect(parsed).not.toHaveProperty("originThreadId");
  });
});

describe("SourceControlThreadForbiddenError", () => {
  it("round-trips a refusal naming the conversation and the reason", () => {
    const parsed = decodeForbidden({
      _tag: "SourceControlThreadForbiddenError",
      operation: "sourceControl.publishRepository",
      reason: "navigator_thread",
      threadId: "thread-1",
      detail: "A Navigator conversation plans work; it does not change the repository.",
    });

    expect(parsed.reason).toBe("navigator_thread");
    expect(parsed.threadId).toBe("thread-1");
    // Presentable without a client having to reconstruct a sentence from tags.
    expect(parsed.message).toContain("sourceControl.publishRepository");
    expect(parsed.message).toContain("does not change the repository");
  });

  it("keeps the fail-safe reasons distinct from the policy one", () => {
    // A thread the server cannot resolve, and a read model it cannot reach, are
    // both refusals rather than ways past the rule — and a client can tell all
    // three apart when it explains what happened.
    for (const reason of ["unknown_thread", "thread_lookup_failed"] as const) {
      const parsed = decodeForbidden({
        _tag: "SourceControlThreadForbiddenError",
        operation: "git.runStackedAction",
        reason,
        threadId: null,
        detail: "Nothing was changed.",
      });
      expect(parsed.reason).toBe(reason);
      expect(parsed.threadId).toBe(null);
    }
  });
});
