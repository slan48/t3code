/**
 * Navigator drafts: what they are pinned to, and why they cannot collide with
 * the coding draft for the same project.
 *
 * Two independent claims are under test here.
 *
 * The first is compatibility: `purpose` did not exist when today's drafts were
 * persisted, and every one of them is a coding draft. A rehydrate that produced
 * anything else would silently reclassify real work.
 *
 * The second is separation. The store keeps at most one draft per logical
 * project in `logicalProjectDraftThreadKeyByLogicalProjectKey`, and writing a
 * second one there evicts the first. Navigator drafts are deliberately never
 * written into that map, so the two kinds cannot evict, resurrect or navigate
 * to one another — and these tests fail if that ever stops being true.
 */
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  hydrateDraftThreadForTests,
  PersistedComposerDraftStoreStateForTests,
  useComposerDraftStore,
  type DraftId,
} from "./composerDraftStore";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");
const PROJECT_REF = scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID);
const LOGICAL_PROJECT_KEY = "logical:project-1";

const CODING_DRAFT = "draft-coding" as DraftId;
const NAVIGATOR_DRAFT = "draft-navigator" as DraftId;

function reset() {
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
}

beforeEach(reset);

describe("persisted drafts written before Navigator existed", () => {
  it("rehydrates as coding", () => {
    // Byte-for-byte the shape the store persisted yesterday: no `purpose` key
    // anywhere in it.
    const legacy = {
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {
        [CODING_DRAFT]: {
          threadId: ThreadId.make("thread-1"),
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: LOGICAL_PROJECT_KEY,
          createdAt: "2026-01-01T00:00:00.000Z",
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "main",
          worktreePath: null,
          envMode: "local",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {
        [LOGICAL_PROJECT_KEY]: CODING_DRAFT,
      },
    };

    const decoded = Schema.decodeUnknownSync(PersistedComposerDraftStoreStateForTests)(legacy);
    expect(decoded.draftThreadsByThreadKey[CODING_DRAFT]?.purpose).toBe("coding");
    // And nothing else about it moved.
    expect(decoded.draftThreadsByThreadKey[CODING_DRAFT]?.runtimeMode).toBe("full-access");
    expect(decoded.draftThreadsByThreadKey[CODING_DRAFT]?.branch).toBe("main");
  });

  it("keeps an explicit navigator purpose when one was written", () => {
    const decoded = Schema.decodeUnknownSync(PersistedComposerDraftStoreStateForTests)({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {
        [NAVIGATOR_DRAFT]: {
          threadId: ThreadId.make("thread-2"),
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          logicalProjectKey: LOGICAL_PROJECT_KEY,
          createdAt: "2026-01-01T00:00:00.000Z",
          purpose: "navigator",
          runtimeMode: "approval-required",
          interactionMode: "plan",
          branch: null,
          worktreePath: null,
          envMode: "local",
        },
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    });
    expect(decoded.draftThreadsByThreadKey[NAVIGATOR_DRAFT]?.purpose).toBe("navigator");
  });
});

describe("navigator draft creation", () => {
  it("pins the planning-only shape and inherits no coding context", () => {
    // Every option here is the coding shape a carried composer would supply.
    // None of them may reach a Navigator draft: the server refuses a navigator
    // thread in any other combination, so honouring them would only fail later.
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId(LOGICAL_PROJECT_KEY, PROJECT_REF, NAVIGATOR_DRAFT, {
        threadId: ThreadId.make("thread-navigator"),
        purpose: "navigator",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature/x",
        worktreePath: "/repos/demo-wt",
        envMode: "worktree",
        startFromOrigin: true,
      });

    const draft = useComposerDraftStore.getState().getDraftSession(NAVIGATOR_DRAFT);
    expect(draft).not.toBeNull();
    expect(draft?.purpose).toBe("navigator");
    expect(draft?.runtimeMode).toBe("approval-required");
    expect(draft?.interactionMode).toBe("plan");
    expect(draft?.branch).toBe(null);
    expect(draft?.worktreePath).toBe(null);
    expect(draft?.envMode).toBe("local");
    expect(draft?.startFromOrigin).toBe(false);
  });

  it("cannot be moved off that shape by a later context edit", () => {
    const store = useComposerDraftStore.getState();
    store.setLogicalProjectDraftThreadId(LOGICAL_PROJECT_KEY, PROJECT_REF, NAVIGATOR_DRAFT, {
      threadId: ThreadId.make("thread-navigator"),
      purpose: "navigator",
    });
    store.setDraftThreadContext(NAVIGATOR_DRAFT, {
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/x",
      worktreePath: "/repos/demo-wt",
      envMode: "worktree",
      startFromOrigin: true,
    });

    const draft = useComposerDraftStore.getState().getDraftSession(NAVIGATOR_DRAFT);
    expect(draft?.runtimeMode).toBe("approval-required");
    expect(draft?.interactionMode).toBe("plan");
    expect(draft?.branch).toBe(null);
    expect(draft?.worktreePath).toBe(null);
  });

  it("keeps the purpose immutable once the draft exists", () => {
    const store = useComposerDraftStore.getState();
    store.setLogicalProjectDraftThreadId(LOGICAL_PROJECT_KEY, PROJECT_REF, CODING_DRAFT, {
      threadId: ThreadId.make("thread-coding"),
    });
    // A later call claiming a different purpose is ignored: the draft already
    // decided, and the thread it will create is already implied.
    store.setLogicalProjectDraftThreadId(LOGICAL_PROJECT_KEY, PROJECT_REF, CODING_DRAFT, {
      threadId: ThreadId.make("thread-coding"),
      purpose: "navigator",
    });
    expect(useComposerDraftStore.getState().getDraftSession(CODING_DRAFT)?.purpose).toBe("coding");
  });
});

describe("coding and navigator drafts for one project", () => {
  const seedBoth = () => {
    const store = useComposerDraftStore.getState();
    store.setLogicalProjectDraftThreadId(LOGICAL_PROJECT_KEY, PROJECT_REF, CODING_DRAFT, {
      threadId: ThreadId.make("thread-coding"),
      branch: "main",
    });
    store.setLogicalProjectDraftThreadId(LOGICAL_PROJECT_KEY, PROJECT_REF, NAVIGATOR_DRAFT, {
      threadId: ThreadId.make("thread-navigator"),
      purpose: "navigator",
    });
  };

  it("coexist, and neither evicts the other", () => {
    seedBoth();
    const state = useComposerDraftStore.getState();
    expect(state.getDraftSession(CODING_DRAFT)?.purpose).toBe("coding");
    expect(state.getDraftSession(NAVIGATOR_DRAFT)?.purpose).toBe("navigator");
    // The coding draft kept its own context through the Navigator write.
    expect(state.getDraftSession(CODING_DRAFT)?.branch).toBe("main");
  });

  it("resolve independently by purpose", () => {
    seedBoth();
    const state = useComposerDraftStore.getState();
    expect(state.getDraftSessionByLogicalProjectKey(LOGICAL_PROJECT_KEY)?.draftId).toBe(
      CODING_DRAFT,
    );
    expect(state.getNavigatorDraftSessionByLogicalProjectKey(LOGICAL_PROJECT_KEY)?.draftId).toBe(
      NAVIGATOR_DRAFT,
    );
  });

  it("keeps the Navigator draft out of the single-slot coding map", () => {
    // This is the mechanism, asserted directly: the map that evicts is the one
    // the Navigator draft is never written into.
    seedBoth();
    const slots = useComposerDraftStore.getState().logicalProjectDraftThreadKeyByLogicalProjectKey;
    expect(Object.values(slots)).toEqual([CODING_DRAFT]);
  });

  it("never hands a Navigator draft to a coding lookup", () => {
    // Navigator only. The coding lookups must both come back empty rather than
    // reaching for the one draft that happens to exist.
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId(LOGICAL_PROJECT_KEY, PROJECT_REF, NAVIGATOR_DRAFT, {
        threadId: ThreadId.make("thread-navigator"),
        purpose: "navigator",
      });
    const state = useComposerDraftStore.getState();
    expect(state.getDraftSessionByLogicalProjectKey(LOGICAL_PROJECT_KEY)).toBe(null);
    expect(state.getDraftSessionByProjectRef(PROJECT_REF)).toBe(null);
  });

  it("leaves ordinary coding draft reuse alone", () => {
    const store = useComposerDraftStore.getState();
    store.setLogicalProjectDraftThreadId(LOGICAL_PROJECT_KEY, PROJECT_REF, CODING_DRAFT, {
      threadId: ThreadId.make("thread-coding"),
    });
    store.setLogicalProjectDraftThreadId(LOGICAL_PROJECT_KEY, PROJECT_REF, NAVIGATOR_DRAFT, {
      threadId: ThreadId.make("thread-navigator"),
      purpose: "navigator",
    });
    // A second coding draft for the same project still replaces the first, as
    // it always has. Navigator changed nothing about that.
    const secondCoding = "draft-coding-2" as DraftId;
    store.setLogicalProjectDraftThreadId(LOGICAL_PROJECT_KEY, PROJECT_REF, secondCoding, {
      threadId: ThreadId.make("thread-coding-2"),
    });
    const state = useComposerDraftStore.getState();
    expect(state.getDraftSessionByLogicalProjectKey(LOGICAL_PROJECT_KEY)?.draftId).toBe(
      secondCoding,
    );
    expect(state.getDraftSession(CODING_DRAFT)).toBe(null);
    // And the Navigator draft survived the eviction entirely.
    expect(state.getDraftSession(NAVIGATOR_DRAFT)?.purpose).toBe("navigator");
  });
});

describe("cleanup cannot remove the wrong purpose sibling", () => {
  /*
   * Insertion order is the whole point of these two. The project-wide cleanup
   * used to take the first draft it found for the project, so which one it
   * deleted depended on which was inserted first — a coding cleanup could take
   * the Navigator conversation with it, silently and only sometimes. Both
   * orders are asserted so the bug cannot come back in one of them.
   */
  const seed = (first: "coding" | "navigator") => {
    const store = useComposerDraftStore.getState();
    const writeCoding = () =>
      store.setLogicalProjectDraftThreadId(LOGICAL_PROJECT_KEY, PROJECT_REF, CODING_DRAFT, {
        threadId: ThreadId.make("thread-coding"),
      });
    const writeNavigator = () =>
      store.setLogicalProjectDraftThreadId(LOGICAL_PROJECT_KEY, PROJECT_REF, NAVIGATOR_DRAFT, {
        threadId: ThreadId.make("thread-navigator"),
        purpose: "navigator",
      });
    if (first === "coding") {
      writeCoding();
      writeNavigator();
    } else {
      writeNavigator();
      writeCoding();
    }
  };

  for (const first of ["coding", "navigator"] as const) {
    it(`clears only the coding draft with ${first} inserted first`, () => {
      seed(first);
      useComposerDraftStore.getState().clearProjectDraftThreadId(PROJECT_REF);
      const state = useComposerDraftStore.getState();
      expect(state.getDraftSession(CODING_DRAFT)).toBe(null);
      expect(state.getDraftSession(NAVIGATOR_DRAFT)?.purpose).toBe("navigator");
    });

    it(`clears only the Navigator draft with ${first} inserted first`, () => {
      seed(first);
      useComposerDraftStore.getState().clearNavigatorProjectDraftThreadId(PROJECT_REF);
      const state = useComposerDraftStore.getState();
      expect(state.getDraftSession(NAVIGATOR_DRAFT)).toBe(null);
      expect(state.getDraftSession(CODING_DRAFT)?.purpose).toBe("coding");
    });

    it(`clears only the named draft with ${first} inserted first`, () => {
      seed(first);
      useComposerDraftStore.getState().clearDraftThread(NAVIGATOR_DRAFT);
      const state = useComposerDraftStore.getState();
      expect(state.getDraftSession(NAVIGATOR_DRAFT)).toBe(null);
      expect(state.getDraftSession(CODING_DRAFT)?.purpose).toBe("coding");
    });

    it(`finalizes only the promoted draft with ${first} inserted first`, () => {
      seed(first);
      const store = useComposerDraftStore.getState();
      store.markDraftThreadPromoting(CODING_DRAFT);
      store.finalizePromotedDraftThread(CODING_DRAFT);
      const state = useComposerDraftStore.getState();
      expect(state.getDraftSession(CODING_DRAFT)).toBe(null);
      // The sibling was not promoting, and must be untouched by the sweep.
      expect(state.getDraftSession(NAVIGATOR_DRAFT)?.purpose).toBe("navigator");
    });
  }
});

describe("rehydrating a persisted Navigator draft", () => {
  it("clamps stale mode fields that disagree with the purpose", () => {
    // A store written by an older build, or edited by hand: navigator purpose
    // with a full-access, worktree-bearing body. The purpose is the authority.
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
    const hydrated = hydrateDraftThreadForTests({
      threadId: ThreadId.make("thread-navigator"),
      environmentId: ENVIRONMENT_ID,
      projectId: PROJECT_ID,
      logicalProjectKey: LOGICAL_PROJECT_KEY,
      createdAt: "2026-01-01T00:00:00.000Z",
      purpose: "navigator",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/x",
      worktreePath: "/repos/demo-wt",
      envMode: "worktree",
      startFromOrigin: true,
    });

    expect(hydrated.purpose).toBe("navigator");
    expect(hydrated.runtimeMode).toBe("approval-required");
    expect(hydrated.interactionMode).toBe("plan");
    expect(hydrated.branch).toBe(null);
    expect(hydrated.worktreePath).toBe(null);
    expect(hydrated.envMode).toBe("local");
    expect(hydrated.startFromOrigin).toBe(false);
  });

  it("leaves a coding draft's stored context exactly as written", () => {
    const hydrated = hydrateDraftThreadForTests({
      threadId: ThreadId.make("thread-coding"),
      environmentId: ENVIRONMENT_ID,
      projectId: PROJECT_ID,
      logicalProjectKey: LOGICAL_PROJECT_KEY,
      createdAt: "2026-01-01T00:00:00.000Z",
      purpose: "coding",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/x",
      worktreePath: "/repos/demo-wt",
      envMode: "worktree",
      startFromOrigin: true,
    });

    expect(hydrated.runtimeMode).toBe("full-access");
    expect(hydrated.branch).toBe("feature/x");
    expect(hydrated.worktreePath).toBe("/repos/demo-wt");
    expect(hydrated.envMode).toBe("worktree");
    expect(hydrated.startFromOrigin).toBe(true);
  });
});
