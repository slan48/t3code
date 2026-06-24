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

> **Item 1 (silent recovery from expired Claude sessions) was removed** in the
> v0.0.26 sync (original commit `9ea1254f`, PR #1). When a resumed Claude
> session expired server-side, the adapter silently wiped the cursor and started
> a fresh session — which re-ingested the *entire* transcript with a cold prompt
> cache, producing a large token spike every time a big conversation was resumed
> after idle (e.g. 0% → 42% context on the first message of the day). We reverted
> `apps/server/src/provider/Layers/ClaudeAdapter.{ts,test.ts}` and the
> `SessionExitedPayload.resumeCursor` field in
> `packages/contracts/src/providerRuntime.ts` back to upstream, restoring the
> default behavior (an expired session surfaces as a failed turn instead of
> silently re-ingesting). The commit remains in git history for reference.
> `ProviderCommandReactor.ts` / `ProviderService.ts` had already converged to
> upstream in earlier syncs, so they needed no revert.

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

> **Item 4 (Cmd+B `sidebar.toggle` capture-phase handler) was superseded
> upstream** in the v0.0.27 / v0.0.28-nightly sync (merge `927abf17`).
> Upstream's #3497 ("Add main sidebar toggle") now ships the byte-for-byte
> identical default binding `{ key: "mod+b", command: "sidebar.toggle" }`
> (no `when` clause) in `packages/shared/src/keybindings.ts`, plus a new
> `SidebarControl` component in `apps/web/src/components/AppSidebarLayout.tsx`
> with a global `window` keydown handler, a trigger button, tooltip, and
> macOS titlebar insets. We adopted upstream's implementation wholesale and
> dropped our fork-only `SidebarShortcutHandler` (capture-phase) and the
> orphaned `isSidebarToggleShortcut` helper in `apps/web/src/keybindings.ts`.
> The original commits (`f3b236d0`, `75c21d31`) remain in git history.
>
> **Caveat — verify on every UI smoke test:** upstream's handler runs on the
> *bubble* phase with an `if (event.defaultPrevented) return;` guard, whereas
> our fork used the *capture* phase specifically so Lexical (composer) and
> xterm (terminal) could not swallow Cmd+B first. If a future sync shows Cmd+B
> failing to toggle when the composer or terminal is focused, the bubble-phase
> guard is the cause — re-introduce a capture-phase handler then. The
> `.gitignore` dev-artifact lines from `75c21d31` (`.claude/launch.json`,
> `.claude/settings.local.json`, `test-report.md`) are unrelated and stay
> (see item 3).

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

### 6. Live token usage in the working row
- **Commit:** `18e2f314` (in-flight tool-call rows half dropped in the
  v0.0.27 / v0.0.28-nightly sync, merge `927abf17`)
- **Files:** `apps/web/src/components/chat/MessagesTimeline.logic.ts`,
  `apps/web/src/components/chat/MessagesTimeline.tsx`,
  `apps/web/src/components/ChatView.tsx`,
  `apps/web/src/lib/contextWindow.ts`
- **What:** Derives `activeContextWindow` in `ChatView` from the latest
  thread activities via `deriveLatestContextWindowSnapshot` and threads it
  through `MessagesTimeline` into the "working" row. `WorkingTimelineRow`
  renders `formatWorkingTokens(row.contextWindow)` next to the "Working for
  Xs" timer so the user sees live token usage as the model streams.
- **Pre-merge check:** Upstream keeps reworking `MessagesTimeline` (rows split
  into separate components; #3022 reworked the work log), making this an
  every-merge re-integration. Ensure: (a) the `deriveMessagesTimelineRows`
  props still declare `activeContextWindow` — keep it **optional**
  (`activeContextWindow?: ... | null`) so upstream's prop-less test fixtures
  and any non-web caller still typecheck, and default it to `null` at the
  working-row push site; (b) `WorkingTimelineRow` still renders
  `formatWorkingTokens(row.contextWindow)`; (c) `ChatView` still imports
  `deriveLatestContextWindowSnapshot` and passes `activeContextWindow={...}`
  to `<MessagesTimeline>`.
- **Post-merge test:** start a thread, send a message that triggers a long
  response, and confirm the "Working for Xs · NNk / NNk tokens" line updates
  live below the composer.

> **Item 6's "in-flight tool calls" half was superseded upstream** in the
> v0.0.27 / v0.0.28-nightly sync (merge `927abf17`). It surfaced `tool.started`
> entries with a `status: "running"` field and a `Loader2Icon` spinner row.
> Upstream #3022 ("Rework message metadata, timestamps, and tool work log
> rows") deliberately skips `tool.started`, tracks tool state via its own
> `toolLifecycleStatus` field, and rewrote row rendering onto a name-based
> `WorkEntryIconSvg` system — shipping a test that asserts `tool.started` is
> omitted. We dropped our `status` field, `deriveWorkLogStatus`, the
> `isRunning`/`Loader2Icon` row code, and our contradicting test by taking
> upstream's `session-logic.{ts,test.ts}` wholesale. Only the live-token half
> (above) remains. The original commit stays in git history.

> **Item 7 (clear stuck spinners) was superseded upstream** in the
> v0.0.24 / Effect-beta.73 sync (merge `bb9264d2`). Upstream now derives
> `assistantCopyStreaming = message.streaming || assistantTurnStillInProgress`
> with an `assistantTurnStillInProgress` guard byte-for-byte identical to our
> fork fix (`de6728bb`), so the entry was removed. The commit remains in git
> history for reference.

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
5. **Verify:** (tooling migrated bun/turbo → pnpm + `vp`/vite-plus in v0.0.26,
   PR #2899 — `turbo.json`/`vitest.config.ts` are gone, replaced by
   `vite.config.ts`; test imports moved `vitest` → `vite-plus/test`)
   ```bash
   corepack pnpm@10.24.0 install --frozen-lockfile   # rebuild node_modules under pnpm
   pnpm run lint                              # vp lint (oxlint), whole workspace
   pnpm run typecheck                         # vp run -r typecheck — all packages incl. apps/server
   pnpm run test                              # vp run -r test — whole workspace
   ```
   `pnpm` isn't installed globally on the dev box — invoke it through
   `corepack pnpm@10.24.0 ...` (the repo pins `packageManager: pnpm@10.24.0`).
   The first `pnpm install` after the migration replaces the bun-managed
   `node_modules` wholesale. `pnpm run typecheck` already covers `apps/server`,
   so fork-only server code (item 5) is checked — an Effect API bump
   upstream may still break it. The web `MessagesTimeline.test.tsx` render test
   ("renders collapse controls for long user messages") flaky-timeouts under
   `vp`'s concurrent load (15s) — re-run it in isolation with
   `cd apps/web && corepack pnpm@10.24.0 exec vp test run src/components/chat/MessagesTimeline.test.tsx`
   to confirm it's green before treating it as a failure.
6. **Manual smoke test** — run the post-merge tests for items with actual
   UI/runtime behavior: item 6 (live token line updates while working) and
   the item-4 caveat (Cmd+B toggles the sidebar with the composer focused —
   no bold formatting — and with the terminal focused — no `b` written).
   Item 5 is covered by the automated test suite.
7. **Push + rebuild DMG:**
   ```bash
   git push origin main                      # add --force-with-lease if rebased
   pnpm run dist:desktop:dmg
   ```

## Updating this doc

When you land a new fork-only change, add an entry here with the commit SHA,
files touched, what it does, and a post-merge test plan. When a merge
supersedes one of our customizations, delete its entry (keep the commit in
history for reference).
