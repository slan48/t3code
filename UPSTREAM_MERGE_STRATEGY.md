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

### 3. Dev-only artifact .gitignore
- **Commit:** `f2647834`
- **Files:** `.gitignore`
- **What:** Ignore local screenshot + MCP snapshot files we generate while
  developing.
- **Pre-merge check:** Usually no conflict. If upstream reorders `.gitignore`,
  just re-add our lines near related patterns.
- **Post-merge test:** `git status` clean after running the app locally.

### 4. Cmd+B `sidebar.toggle` works from any focus + capture-phase handler
- **Commits:** `f3b236d0` (feat — originally bundled `terminal.dock.toggle`
  which was dropped in the v0.0.24 sync), `75c21d31` (gitignore housekeeping)
- **Files:** `packages/shared/src/keybindings.ts` (where `DEFAULT_KEYBINDINGS`
  lives since upstream's #2361),
  `apps/web/src/components/AppSidebarLayout.tsx`,
  `apps/web/src/keybindings.ts`, `apps/web/src/keybindings.test.ts`,
  `.gitignore`
- **What:**
  - Adds the `{ key: "mod+b", command: "sidebar.toggle" }` default in the
    shared keybindings table (upstream ships no default for sidebar toggle).
    No `when` clause, so Cmd+B works whether focus is in the composer,
    terminal, or anywhere else.
  - Registers the global Cmd+B handler in `AppSidebarLayout` on the
    *capture* phase so Lexical (composer) and xterm (terminal) cannot
    swallow the keystroke first.
  - Exports `isSidebarToggleShortcut` from `apps/web/src/keybindings.ts` for
    use by xterm's `attachCustomKeyEventHandler` (so it forwards Cmd+B
    instead of writing `b` to the terminal).
  - Ignores `.claude/launch.json`, `.claude/settings.local.json`, and
    `test-report.md` (transient/per-developer files).
- **Pre-merge check:** If upstream ever adds its own `sidebar.toggle`
  default, prefer ours (no `when` clause). Note: existing users'
  `~/.t3/dev/keybindings.json` (and the `userdata` variant) override
  defaults — `syncDefaultKeybindingsOnStartup` deduplicates by command
  name, so changes to default `when` clauses won't propagate. New users
  pick up the unrestricted `sidebar.toggle` automatically.
- **Post-merge test:**
  1. Cmd+B with terminal focused → sidebar toggles, no `b` written to
     the terminal.
  2. Cmd+B with composer focused → sidebar toggles, no bold formatting
     applied.

### 5. Sidecar Claude sessions isolated from prompt injection
- **Commit:** `60479600`
- **Files:** `apps/server/src/textGeneration/ClaudeTextGeneration.ts`,
  `apps/server/src/textGeneration/ClaudeTextGeneration.test.ts`
- **What:** The title / branch-name / commit-message / pr-content sidecars
  embed user chat content in their prompts, so they are exposed to prompt
  injection. We replace `--dangerously-skip-permissions` with
  `--permission-mode default --allowed-tools StructuredOutput`, restricting
  injected instructions to the one tool `--json-schema` actually needs.
- **Pre-merge check:** If upstream restructures the sidecar invocation,
  re-apply the flag swap. Tests in `ClaudeTextGeneration.test.ts` assert
  `--allowed-tools StructuredOutput` is present and
  `--dangerously-skip-permissions` is not — if upstream breaks those
  assertions, the security fix has been reverted and must be re-applied.
- **Post-merge test:** `bun run test` exercises this. No manual UI step.

### 6. Live token usage + in-flight tool calls in the working row
- **Commit:** `18e2f314`
- **Files:** `apps/web/src/components/chat/MessagesTimeline.logic.ts`,
  `apps/web/src/components/chat/MessagesTimeline.tsx`,
  `apps/web/src/components/ChatView.tsx`,
  `apps/web/src/lib/contextWindow.ts`
- **What:** Derives `activeContextWindow` in `ChatView` from the latest
  thread activities and threads it through `MessagesTimeline` into the
  "working" row. The working row renders `formatWorkingTokens(...)` next to
  the "Working for Xs" timer so the user sees live token usage as the model
  streams.
- **Pre-merge check:** Upstream's `MessagesTimeline` refactor (PRs #2498 /
  #2580 / #2660 split rows into separate row components) makes this an
  every-merge re-integration: ensure (a) `MessagesTimelineProps` still
  declares `activeContextWindow` and the logic still propagates it onto
  `WorkingRow`, (b) `WorkingTimelineRow` still renders
  `formatWorkingTokens(row.contextWindow)`, (c) `ChatView` still imports
  `deriveLatestContextWindowSnapshot` and passes `activeContextWindow={...}`
  to `<MessagesTimeline>`.
- **Post-merge test:** start a thread, send a message that triggers a long
  response, and confirm the "Working for Xs · NNk / NNk tokens" line
  updates live below the composer.

### 7. Clear stuck spinners on subagent progress / `tool.started` rows
- **Commit:** `de6728bb`
- **Files:** `apps/web/src/components/chat/MessagesTimeline.logic.ts`
  (`assistantCopyStreaming` derivation and `activeTurnInProgress` plumbing)
- **What:** When a subagent emits `tool.started` events, the assistant
  message can transition out of `streaming` while the turn is still in
  flight, leaving the copy-button gated incorrectly. We compute
  `assistantCopyStreaming = message.streaming || (activeTurnInProgress &&
  message.turnId === activeTurnId)` so the spinner clears only when the
  turn actually settles.
- **Pre-merge check:** `MessagesTimeline.logic.ts` is touched on every
  upstream refactor — confirm `assistantCopyStreaming` is still derived
  using `activeTurnInProgress` (not just `message.streaming`), and that
  `AssistantCopyButton` (or whatever upstream calls it) reads
  `row.assistantCopyStreaming` rather than the raw `message.streaming`.
- **Post-merge test:** trigger a tool-heavy response (e.g. spawn an Agent
  subagent that runs tools). While the subagent is still working, the copy
  button on the parent assistant message must stay hidden — and reveal
  itself only when the whole turn is settled.

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
   cd apps/web && bun run test
   bun run test                              # root tests (turbo)
   ```
   Note the `bun run test` form — plain `bun test` invokes Bun's own test
   runner instead of vitest and produces spurious failures.
6. **Manual smoke test** — run every post-merge test listed above for items
   that have actual UI/runtime behavior (items 1, 4, 6, 7). Item 5 is
   covered by the automated test suite.
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
