# Upstream Merge Strategy

This fork (`slan48/t3code`) tracks `pingdotgg/t3code`. This doc lists every
customization we carry on top of upstream and the checklist for pulling in a
new upstream release without losing (or duplicating) our changes.

## Remotes

```
origin    git@github.com:slan48/t3code.git         (our fork)
upstream  https://github.com/pingdotgg/t3code.git  (source project, main-only fetch)
```

The `upstream` fetch refspec is restricted to `main` to avoid pulling hundreds
of `codething/*` agent branches:
```bash
git config remote.upstream.fetch +refs/heads/main:refs/remotes/upstream/main
```

## Fork customizations

List is ordered oldest → newest. Before each merge, re-check upstream to see
whether any item has been addressed upstream (rendering our change redundant
or in conflict). If upstream solved it differently, prefer their version and
drop ours.

### 1. Silent recovery from expired Claude sessions
- **Commit:** `9ea1254f` (PR #1, merge `27fa0b9c`)
- **Files:** `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`,
  `apps/server/src/provider/Layers/ClaudeAdapter.{ts,test.ts}`,
  `apps/server/src/provider/Layers/ProviderService.ts`,
  `packages/contracts/src/providerRuntime.ts`
- **What:** When the Claude SDK raises a session-expired error, the adapter
  recovers silently (retries with a fresh session) instead of surfacing the
  error to the user.
- **Pre-merge check:** Look for upstream changes in `ClaudeAdapter`,
  `ProviderCommandReactor`, or `ProviderService`. If upstream added its own
  retry/recovery logic for expired sessions, drop our version.
- **Post-merge test:** trigger an expired session (leave the app idle long
  enough, or manually invalidate). Sending a message should succeed without a
  visible error toast.

### 2. AGENTS.md expansion
- **Commit:** `03be0dfd`
- **Files:** `AGENTS.md`
- **What:** Expanded architecture notes, commands, and conventions doc for
  agent-driven edits.
- **Pre-merge check:** Upstream may refresh AGENTS.md with new guidance.
  Merge theirs, then re-apply our additions that aren't already covered.
- **Post-merge test:** read-through only; no runtime impact.

### 3. Composer cross-provider model leak fix
- **Commit:** `36467784` (PR #2, merge `b8342cfb`)
- **Files:** `apps/web/src/modelSelection.ts` (and related composer logic)
- **What:** Prevents the composer from deriving a "base model" that belongs
  to a different provider than the one currently selected.
- **Pre-merge check:** Look at `modelSelection.ts` /
  `ProviderModelPicker*.tsx` in upstream diff. Upstream has been heavily
  refactoring the model picker; they may have rewritten this path entirely.
  If so, verify the bug (switch providers in the composer and confirm the
  previous provider's model isn't sticky) on upstream's version before
  re-applying.
- **Post-merge test:** open composer, pick a Claude model, switch provider
  dropdown to Codex/OpenCode, confirm the selected model resets to a model
  from the new provider.

### 4. Dev-only artifact .gitignore
- **Commit:** `f2647834`
- **Files:** `.gitignore`
- **What:** Ignore local screenshot + MCP snapshot files we generate while
  developing.
- **Pre-merge check:** Usually no conflict. If upstream reorders `.gitignore`,
  just re-add our lines near related patterns.
- **Post-merge test:** `git status` clean after running the app locally.

### 5. Terminal dock position toggle + desktop sidebar trigger
- **Commit:** `1219dc23` (PR #3, squashed)
- **Files:** `apps/web/src/terminalStateStore.ts`,
  `apps/web/src/terminalStateStore.test.ts`,
  `apps/web/src/components/ThreadTerminalDrawer.tsx`,
  `apps/web/src/components/ChatView.tsx`,
  `apps/web/src/components/NoActiveThreadState.tsx`,
  `apps/web/src/components/chat/ChatHeader.tsx`,
  `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`
- **What:**
  - Adds `terminalDockPosition` ("bottom" | "right") to the persisted terminal
    store with a v1→v2 migration.
  - Lets the user toggle the terminal between bottom-dock and right-dock;
    right-dock uses a React portal into `RIGHT_DOCK_TERMINAL_SLOT_ID` inside
    the inline diff sidebar (diff and terminal stack when both open).
  - Shows the left-sidebar `SidebarTrigger` on desktop (previously `md:hidden`
    in the chat header and empty-state header).
- **Pre-merge check:**
  - Upstream's `DiffPanel`/right-sidebar changes (e.g. #2224 "right panel
    sheet to be below title bar") will almost certainly conflict with the
    inline sidebar + terminal slot. Re-integrate our slot structure after
    merging upstream's refactor.
  - Check if upstream has added a terminal dock toggle — unlikely but
    possible. If so, use theirs.
  - The store migration version: if upstream bumps the persisted-store
    version first, ours needs to chain properly (their v2 → our v3, etc.).
- **Post-merge test:**
  1. Open terminal → drag-dock to right → confirm it renders in the right
     sidebar.
  2. Open diff while terminal is right-docked → confirm they stack (diff on
     top, terminal below).
  3. Reload the app → dock position survives.
  4. Left-sidebar trigger visible on desktop.

### 6. Xterm refit on width changes in right-dock
- **Commit:** `8924ced5`
- **Files:** `apps/web/src/components/ThreadTerminalDrawer.tsx`
- **What:** Attaches a `ResizeObserver` to the terminal container so
  `FitAddon.fit()` runs whenever the container's width (not just drawer
  height) changes. Without this, dragging the right sidebar rail wider leaves
  xterm wrapping at the old narrow column count.
- **Pre-merge check:** If upstream added any ResizeObserver in the same
  component or changed the FitAddon wiring, our observer may become
  redundant. Remove if so.
- **Post-merge test:** dock terminal to right, run a command with long
  output, drag the sidebar rail wider → text should reflow to use the new
  width.

### 7. Right-docked terminal visible on draft threads
- **Commit:** `56a00f18`
- **Files:** `apps/web/src/routes/_chat.draft.$draftId.tsx`,
  `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`,
  `apps/web/src/components/chat/DiffPanelInlineSidebar.tsx` (new)
- **What:** The draft (new-thread) route didn't render
  `DiffPanelInlineSidebar`, so `RIGHT_DOCK_TERMINAL_SLOT_ID` didn't exist and
  the portalled terminal was invisible. Extract the sidebar into a shared
  component and render it on both routes (with diff disabled on the draft
  route).
- **Pre-merge check:** If upstream restructures the draft route or the diff
  panel, re-apply the "draft route also renders the inline sidebar" logic
  after merging.
- **Post-merge test:** open a brand-new chat (draft) with dock=right → toggle
  terminal → it should appear immediately (no need to send a message first).

## Merge workflow

1. **Fetch upstream:**
   ```bash
   git fetch upstream
   git log --oneline main..upstream/main     # review what's new
   ```
2. **Review this doc** — for each customization above, open the upstream diff
   for the files listed and decide: redundant, conflicting, or still needed.
3. **Merge (preferred) or rebase:**
   ```bash
   git checkout main
   git merge upstream/main                   # creates a merge commit
   # OR
   git rebase upstream/main                  # requires --force-with-lease push
   ```
4. **Resolve conflicts** using the per-item guidance above. When a
   customization is already handled upstream, take upstream's version and
   remove the note from this doc (the git history still has the old commit).
5. **Verify:**
   ```bash
   bun run lint
   cd apps/web && bun run typecheck
   cd apps/web && bun test
   bun test                                  # root tests
   ```
6. **Manual smoke test** — run every post-merge test listed above for items
   that have actual UI/runtime behavior (items 1, 3, 5, 6, 7).
7. **Push + rebuild DMG:**
   ```bash
   git push origin main                      # add --force-with-lease if rebased
   bun run dist:desktop:dmg
   ```

## Updating this doc

When you land a new fork-only change, add an entry here with the commit SHA,
files touched, what it does, and a post-merge test plan. When a merge
supersedes one of our customizations, delete its entry (keep the commit in
history for reference).
