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
> a fresh session — which re-ingested the _entire_ transcript with a cold prompt
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

> **Item 4 (Cmd+B `sidebar.toggle` on the capture phase) was superseded
> upstream** in the v0.0.29-nightly sync (original commits `f3b236d0`,
> `75c21d31`). Upstream #3921 ("fix(web): handle sidebar shortcut before
> editors") moved `SidebarControl`'s keydown handler to the **capture** phase —
> `window.addEventListener("keydown", onKeyDown, true)` — which is exactly the
> fix our fork carried. Their version is strictly better than ours: it _keeps_
> the `if (event.defaultPrevented) return;` guard (harmless on capture, since
> nothing downstream has run yet) and adds a `[data-keybinding-capture]` escape
> hatch so the Settings keybinding recorder can still record Cmd+B — our
> guard-less variant silently broke that recorder. We took upstream's
> `AppSidebarLayout.tsx` wholesale. The commits remain in git history for
> reference. The `.gitignore` dev-artifact lines from `75c21d31` are unrelated
> and stay (item 3).

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
- **Post-merge test:** `pnpm run test` exercises this (focused:
  `cd apps/server && corepack pnpm@11.10.0 exec vp test run src/textGeneration/ClaudeTextGeneration.test.ts`).
  No manual UI step.

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
  to `<MessagesTimeline>`. The recurring conflict site is the **import block**
  at the top of `MessagesTimeline.tsx`, not the row code: our
  `lib/contextWindow` import sits adjacent to imports upstream keeps deleting
  (v0.0.29-nightly.899 removed `summarizeTurnDiffStats` there when it rewrote
  `AssistantChangedFilesSection`). Keep ours, drop whatever upstream dropped,
  and confirm with `grep` that the removed symbol really has no remaining
  callers before deleting its import.
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

> **Item 4's leftover `sidebar.toggle` keybinding registration was removed** in
> the v0.0.29-nightly.871 sync. When item 4 was declared superseded, only
> `AppSidebarLayout.tsx` was reverted to upstream — the fork's _registration_ of
> the command survived as a **duplicate** of upstream's own entry in three
> places: a second `{ key: "mod+b", command: "sidebar.toggle" }` in
> `packages/shared/src/keybindings.ts`, a second `"sidebar.toggle"` in
> `STATIC_KEYBINDING_COMMANDS` in `packages/contracts/src/keybindings.ts`, and a
> matching duplicate in the `DEFAULT_BINDINGS` fixture in
> `apps/web/src/keybindings.test.ts`. Upstream has carried both the command and
> the `mod+b` default since before that sync, so all three fork copies were
> deleted. **Lesson:** when an item is marked superseded, grep for _every_ file
> it touched, not just the one named in the entry.

> **Item 7 (clear stuck spinners) was superseded upstream** in the
> v0.0.24 / Effect-beta.73 sync (merge `bb9264d2`). Upstream now derives
> `assistantCopyStreaming = message.streaming || assistantTurnStillInProgress`
> with an `assistantTurnStillInProgress` guard byte-for-byte identical to our
> fork fix (`de6728bb`), so the entry was removed. The commit remains in git
> history for reference.

### 8. Fork-only skills live under `.agents/skills/`

- **Files:** `.agents/skills/upstream-sync/SKILL.md`, `.claude/skills` (symlink)
- **What:** Upstream #4162 ("Make test-t3-app skill discoverable by Claude
  Code") replaced the `.claude/skills` _directory_ with a **symlink** to
  `../.agents/skills`. Our fork-only `upstream-sync` skill used to live at
  `.claude/skills/upstream-sync/SKILL.md`, which collided with that symlink
  (git reports `CONFLICT (file/directory): directory in the way of
.claude/skills`). We moved the skill to `.agents/skills/upstream-sync/SKILL.md`
  and adopted upstream's symlink, so Claude Code discovers our skill _and_
  upstream's four (`test-t3-app`, `test-t3-mobile`, `ios-debugger-agent`,
  `ios-simulator-browser`).
- **Pre-merge check:** Keep new fork-only skills in `.agents/skills/`, never in
  `.claude/skills/` — the latter is a symlink and a real directory there will
  re-trigger the file/directory conflict on every sync.
- **Post-merge test:** `ls .claude/skills/` lists `upstream-sync` alongside the
  upstream skills; `git ls-files -s .claude/skills` reports mode `120000`.

### 9. Tool `itemId` propagated onto tool activities

- **Commit:** `260b44e6` ("fix: propagate tool itemId so parallel tool calls
  collapse reliably")
- **Files:** `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`
- **What:** In `runtimeEventToActivities`, threads `event.itemId` through as
  `toolCallId` on the `tool.*` activity payloads so parallel tool calls collapse
  onto the right row instead of merging. Also gives `tool.started` a real
  `title` (and `data`) instead of the `"<title> started"` summary string.
- **Pre-merge check:** Upstream edits this file often, but in the
  `make`/lifecycle half (~line 1300+), not in `runtimeEventToActivities`
  (~line 620–690). Verify our three `toolCallId` spreads and the `tool.started`
  `summary`/`title` lines survive. If upstream introduces its own tool-call
  correlation id, prefer theirs and drop this entry.
- **Post-merge test:** covered indirectly by `apps/server` tests; visually,
  trigger two parallel tool calls in one turn and confirm they render as two
  distinct rows.

### 10. Claude Opus 4.8 provider test

- **Commit:** `b9796fa6` ("feat(provider): add Claude Opus 4.8 model")
- **Files:** `apps/server/src/provider/Layers/ProviderRegistry.test.ts`
- **What:** The production half of this commit (`ClaudeProvider.ts`,
  `packages/contracts/src/model.ts`) has since **converged with upstream** —
  only the fork's regression test remains, asserting that Opus 4.8 is offered on
  Claude Code v2.1.154 with `high` as the default effort.
- **Pre-merge check:** Upstream keeps tuning Claude model defaults (#4240
  made `1m` the default _contextWindow_ for Opus; #4472 added Claude Opus 5,
  minimum CLI v2.1.219, and re-ordered the version-upgrade message chain
  ahead of the Opus 4.8 branch). If upstream changes the default _effort_,
  or makes v2.1.153 report a message other than the Opus 4.8 upgrade string,
  this test fails and should be updated to match upstream rather than
  reverted. Both assertions still held as of
  v0.0.29-nightly.20260725.899 — the 2.1.153 branch still falls through to
  `formatClaudeOpus48UpgradeMessage`. Our two tests are inserted into a file
  upstream rewrites heavily (+424 lines that sync), so expect to re-place
  them by hand.
- **Post-merge test:** covered by the `apps/server` suite.

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
   CI=true corepack pnpm@11.10.0 install --frozen-lockfile   # rebuild node_modules under pnpm
   pnpm run lint                              # vp lint (oxlint), whole workspace
   pnpm run typecheck                         # vp run -r typecheck — all packages incl. apps/server
   pnpm run test                              # vp run -r test — whole workspace
   ```

   `pnpm` isn't installed globally on the dev box — invoke it through
   `corepack pnpm@11.10.0 ...` (the repo pins `packageManager: pnpm@11.10.0` as
   of the v0.0.29-nightly sync; it was `pnpm@10.24.0` through v0.0.28). When the
   pin bumps a major, the first install must purge the previous major's
   `node_modules`, which pnpm refuses to do without a TTY — prefix the install
   with `CI=true` (or set `confirmModulesPurge=false`) to auto-confirm the purge,
   otherwise it aborts with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`.
   `pnpm run typecheck` already covers `apps/server`,
   so fork-only server code (item 5) is checked — an Effect API bump
   upstream may still break it.

   **`pnpm run test` does NOT run the `apps/server` suite.** Confirmed in the
   v0.0.29-nightly.871 sync: `vp run -r test` scheduled only 13 tasks and
   `@t3tools/server#test` was not among them, even though `apps/server` has a
   `"test": "vp test run"` script and pnpm reports 16 workspace projects. The
   server suite is where items 5, 9, and 10 are actually verified, so it must be
   run explicitly:

   ```bash
   cd apps/server && corepack pnpm@11.10.0 exec vp test run   # ~1560 tests
   ```

   **Exit code 137 is an OOM kill, not a test failure.** In the same sync,
   `@t3tools/web#test` and `t3code-relay#test` were both SIGKILLed under
   whole-workspace concurrency; both pass cleanly when run per-package. Check
   `vp run --last-details` for exit codes before believing a red run — 137 means
   re-run that package alone:

   ```bash
   cd apps/web && corepack pnpm@11.10.0 exec vp test run --passWithNoTests --project unit
   cd infra/relay && corepack pnpm@11.10.0 exec vp test run
   ```

   **Known load-flaky suites — re-run in isolation before treating as a
   failure.** Both are pure-upstream files with no fork commits; they only fail
   under `vp`'s concurrent whole-workspace load:

   ```bash
   # web: collapse-control / attachment-anchor render tests. Flaked again in the
   # v0.0.29-nightly.899 sync — this time as `Hook timed out in 30000ms` in the
   # `beforeAll` at MessagesTimeline.test.tsx:135, not a slow assertion. Alone:
   # 14/14 pass in 1.8s. Treat any failure in this file's setup hook as load, and
   # re-run before investigating.
   cd apps/web && corepack pnpm@11.10.0 exec vp test run src/components/chat/MessagesTimeline.test.tsx
   # mobile: "keeps grammar state across inline comment rows" (observed 4.4s under load, 0.4s alone)
   cd apps/mobile && corepack pnpm@11.10.0 exec vp test run src/features/diffs/nativeReviewDiffHighlighter.test.ts
   ```

6. **Manual smoke test** — run the post-merge tests for items with actual
   UI/runtime behavior: item 6 (live token line updates while working) and
   item 8 (`ls .claude/skills/` lists `upstream-sync`). Item 5 is covered by
   the automated test suite. Cmd+B is now upstream's behavior (item 4 was
   superseded), but it's still worth a regression check after any sync that
   touches `AppSidebarLayout.tsx`: Cmd+B with the composer focused should
   toggle the sidebar without applying bold, and with the terminal focused
   without writing `b`.
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
