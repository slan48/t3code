---
name: upstream-sync
description: Sync this fork with pingdotgg/t3code upstream by following UPSTREAM_MERGE_STRATEGY.md. Use when the user asks to update the fork, pull upstream, merge upstream, sync with pingdotgg, or run the upstream merge workflow. Handles the per-customization "redundant vs. conflicting vs. still needed" triage and always confirms with the user before dropping a fork-only change.
---

# Upstream sync workflow

This skill executes the fork-maintenance workflow documented in
`UPSTREAM_MERGE_STRATEGY.md` at the repo root. That doc is the source of truth —
read it at the start of every run because the list of fork customizations
changes over time.

## Golden rules

- **Never drop a fork-only change without explicit user confirmation.** If
  upstream appears to supersede one of our items, show the user the upstream
  diff for the relevant files side-by-side with our change and ask
  "superseded / keep / merge manually?" before deleting anything.
- **Never force-push, never pass `--no-verify`, never rewrite published
  history** without the user asking for it.
- **Stop and ask** on any ambiguous conflict. Do not guess resolutions for
  fork-specific code paths.
- The working tree may already have uncommitted fork edits (check
  `git status` first). Don't start a merge on a dirty tree — ask the user to
  commit or stash.

## Steps

### 1. Preflight
- `git status` — must be clean. If not, stop and ask.
- `git branch --show-current` — usually `main`. If not, confirm.
- Read `UPSTREAM_MERGE_STRATEGY.md` end-to-end. The "Fork customizations"
  list drives the triage in step 3.

### 2. Fetch and summarize
- `git fetch upstream`
- `git log --oneline main..upstream/main` — list new upstream commits.
- If nothing new: report "already up to date" and stop.
- Otherwise, give the user a short summary of what's incoming (count +
  themes, not a full list dump).

### 3. Triage each fork customization
For every numbered item in `UPSTREAM_MERGE_STRATEGY.md` → "Fork
customizations", do this **before** running `git merge`:

1. Find upstream changes that touch the same files:
   `git log --oneline main..upstream/main -- <file1> <file2> ...`
2. If upstream touched any of those files, show the user the upstream diff
   for that item (`git diff main..upstream/main -- <files>`) and classify:
   - **redundant** — upstream solved the same problem the same way →
     recommend dropping our change, confirm with the user first.
   - **different-but-equivalent** — upstream solved it differently →
     recommend preferring upstream, confirm with the user, note for the
     post-merge cleanup of the strategy doc.
   - **conflicting** — upstream refactored the area but didn't address
     our concern → keep ours, flag that manual conflict resolution will
     be needed.
   - **untouched** — no upstream activity on these files → keep ours,
     no action needed.
3. Record the decision per item. Present the full triage table to the user
   and wait for go-ahead before merging.

### 4. Merge
- Default to `git merge upstream/main` (preserves a merge commit, matches
  what the strategy doc recommends). Only rebase if the user asks.
- Resolve conflicts guided by the triage from step 3 and the per-item
  "Pre-merge check" notes in the strategy doc.
- For any fork item marked redundant/superseded, take upstream's version
  during conflict resolution (only after the user confirmed in step 3).

### 5. Verify
Run the verification block from the strategy doc:
```bash
bun run lint
cd apps/web && bun run typecheck
cd apps/web && bun test
bun test
```
If any fails, stop and report — do not push.

### 6. Manual smoke tests
List the post-merge test steps from the strategy doc for every item that
still has runtime behavior (today: items 1, 3, 5, 6, 7 — but re-derive
from the doc each run, the list drifts). Ask the user to run them, or
offer to drive them with the browser-tester agent.

### 7. Update the strategy doc
- If a fork item was dropped as redundant, delete its entry from
  `UPSTREAM_MERGE_STRATEGY.md` (the commit stays in git history).
- If new fork-only commits landed since the last sync, the doc should
  already list them; if not, add entries.
- Show the diff and ask the user to confirm before committing the doc
  update.

### 8. Hand off
Do **not** push or run `bun run dist:desktop:dmg` automatically. Report
the merge commit SHA, the verification results, the list of manual
smoke tests still pending, and wait for the user to say "push" before
running `git push origin main`.

## Invocation

The user will typically say things like:
- "sync with upstream"
- "pull upstream into the fork"
- "run the upstream merge workflow"
- "update the fork"

When invoked, state in one sentence what you're about to do, then start at
step 1.
