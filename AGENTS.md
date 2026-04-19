# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) and other coding agents when working with code in this repository. `CLAUDE.md` is a symlink to this file — edit this file to update both.

## Project Snapshot

T3 Code is a minimal web GUI for coding agents (Codex, Claude, Cursor via ACP, opencode). The repo is a **very early WIP** — proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience. Long-term maintainability is a core priority — if you add functionality, first check for shared logic that can be extracted. Duplicated logic across multiple files is a code smell. Don't be afraid to change existing code; don't take shortcuts by adding local logic to solve a shared problem.

## Task Completion Requirements

- `bun fmt`, `bun lint`, and `bun typecheck` must all pass before a task is considered complete.
- **NEVER run `bun test`** (that invokes Bun's built-in test runner). Always use `bun run test`, which routes through Turbo to Vitest.

## Common Commands

Package manager is **bun 1.3.11** (Node 24.13.1). `.mise.toml` pins versions if you use mise.

Top-level (all routed through Turbo unless noted):

- `bun run dev` — contracts + server + web in watch mode with a TUI.
- `bun run dev:server` / `bun run dev:web` / `bun run dev:desktop` — individual stacks.
- `bun run build` — full workspace build.
- `bun run typecheck` — `tsc --noEmit` across all packages.
- `bun run lint` — `oxlint --report-unused-disable-directives` at the repo root.
- `bun run fmt` / `bun run fmt:check` — `oxfmt` formatter.
- `bun run test` — Vitest across all workspaces.
- `bun run start` — production server (serves the built web app as static files).
- `bun run build:contracts` — rebuild only `@t3tools/contracts` (needed before server/web typecheck after contract changes).
- `bun run clean` — nukes `node_modules`, all `dist`, `dist-electron`, and `.turbo` caches.

Running a single test file / name filter (run inside the owning package):

```bash
cd apps/server && bun x vitest run src/orchestration/decider.ts
cd apps/server && bun x vitest run -t "turn start"
```

Web browser tests use Playwright and a separate config:

```bash
cd apps/web && bun run test:browser:install   # one-time
cd apps/web && bun run test:browser
```

Server-only focused suites:

- `cd apps/server && bun run test:process-reaper` — targeted process-lifecycle suite used when touching provider adapters / session reapers.

Desktop packaging:

- `bun run dist:desktop:dmg` (arm64 default), `:dmg:x64`, `:linux`, `:win`, `:win:arm64`, `:win:x64`.
- `bun run test:desktop-smoke` for the packaged smoke test.

Multiple dev instances on the same machine: set `T3CODE_DEV_INSTANCE=<name>` (hashes to a port offset) or `T3CODE_PORT_OFFSET=<n>` (explicit). Defaults: server `3773`, web `5733`. Dev commands default `T3CODE_STATE_DIR` to `~/.t3/dev` to keep dev state isolated.

Pass flags through to the server from the root dev command with `--`, e.g. `bun run dev -- --base-dir ~/.t3-2`.

## Package Roles

- `apps/server` (`t3` on npm) — Node WebSocket server. Spawns provider runtimes (Codex `app-server` via JSON-RPC over stdio, Claude, Cursor via ACP, opencode), serves the React web app, owns orchestration state, persistence (sqlite), git, terminals, and auth/pairing.
- `apps/web` (`@t3tools/web`) — React 19 + Vite 8 UI. Tanstack Router, Tailwind 4, Effect `@effect/atom-react` + Zustand for state, Lexical editor, xterm.js terminal. React Compiler is enabled.
- `apps/desktop` (`@t3tools/desktop`) — Electron shell that spawns a desktop-scoped `t3` backend on loopback (auth-token protected) and loads the bundled UI from `t3://app/index.html`.
- `apps/marketing` — Separate site build; not part of the main dev loop.
- `packages/contracts` (`@t3tools/contracts`) — Effect `Schema` schemas + TypeScript contracts for provider events, the WebSocket protocol, orchestration domain, and settings. **Schema only — no runtime logic.**
- `packages/shared` (`@t3tools/shared`) — Shared runtime utilities consumed by both server and web. **Explicit subpath exports only** (e.g. `@t3tools/shared/git`, `@t3tools/shared/DrainableWorker`) — no barrel index.
- `packages/client-runtime` — Small runtime bits shared with the client.
- `packages/effect-acp` — Effect-flavored Agent Client Protocol (ACP) client/agent/schema. Generated from upstream schema via `bun run generate`.

## Architecture At A Glance

```
Browser (React)  ──ws://host:3773──►  apps/server  ──JSON-RPC stdio──►  codex app-server / other providers
  wsTransport                          WS + HTTP static                   (provider runtime processes)
  typed push decode                    ServerPushBus (ordered pushes)
  atom/zustand state                   OrchestrationEngine (CQRS-ish)
                                       ProviderService
                                       CheckpointReactor
                                       RuntimeReceiptBus (sqlite persistence)
```

### The push/request protocol

- Simple JSON-RPC-style over WebSocket: `{ id, method, params }` → `{ id, result | error }` for calls; typed envelopes `{ channel, sequence, data }` for server-initiated pushes. Channels include `server.welcome`, `server.configUpdated`, `terminal.event`, `orchestration.domainEvent`.
- Payloads are schema-validated at the transport boundary in `apps/web/src/rpc/wsTransport.ts`. Decode failures produce structured `WsDecodeDiagnostic` — don't bypass validation, fix the schema.
- Method names mirror the `NativeApi` interface in `@t3tools/contracts` (e.g. `providers.startSession`, `providers.sendTurn`, `providers.respondToRequest`, `shell.openInEditor`, `server.getConfig`).
- Client transport state machine: `connecting → open → reconnecting → closed → disposed`. Outbound requests queue while disconnected and flush on reconnect. Push channels cache last value; subscribers can opt into `replayLatest`.

### Server-side orchestration (the load-bearing part)

Orchestration is an event-sourced domain layer that turns runtime activity into stable app state. Source of truth lives in three files:

- `apps/server/src/orchestration/decider.ts` — pure `(command, state) → events` with preconditions in `commandInvariants.ts`.
- `apps/server/src/orchestration/projector.ts` — pure `(event, state) → state'` projection; also used by `Layers/ProjectionPipeline.ts` to build persisted read model rows.
- `apps/server/src/orchestration/Layers/OrchestrationEngine.ts` — glues decider + projector + persistence; exposes command dispatch and domain-event stream.

Follow-up async work runs as queue-backed reactors using `DrainableWorker` (`@t3tools/shared/DrainableWorker`), which exposes `drain()` for deterministic test synchronization. The three main reactors:

1. **ProviderRuntimeIngestion** — consumes provider runtime streams and emits orchestration commands/events.
2. **ProviderCommandReactor** — reacts to orchestration intent events by dispatching provider calls.
3. **CheckpointReactor** — captures git checkpoints on turn start/complete and publishes runtime receipts.

`RuntimeReceiptBus` emits lightweight typed signals when async milestones finish (e.g. `checkpoint.baseline.captured`, `checkpoint.diff.finalized`, `turn.processing.quiesced`). **Tests and orchestration code should wait on these receipts — not poll git state, projections, or sleep timers.**

Aggregates are `project` or `thread`. Commands are typed (`thread.create`, `thread.turn.start`, `thread.checkpoint.revert`, …). Events are the persisted source of truth (`thread.created`, `thread.message-sent`, `thread.turn-diff-completed`, …). See `packages/contracts/src/orchestration.ts`.

### Provider adapters

- Provider contracts: `apps/server/src/provider/Services/ProviderAdapter.ts`.
- Adapters live under `apps/server/src/provider/Layers/` — `CodexAdapter.ts`, `ClaudeAdapter.ts`, `OpencodeAdapter.ts`, plus ACP-based flows under `apps/server/src/provider/acp/`.
- Codex is the historical first-class provider. The server wraps `codex app-server` (JSON-RPC over stdio) per session — session startup/resume and turn lifecycle live in `apps/server/src/codexAppServerManager.ts`. Docs: https://developers.openai.com/codex/sdk/#app-server.

### Runtime modes

Global toggle in the chat toolbar:

- **Full access** (default): `approvalPolicy: never`, `sandboxMode: danger-full-access`.
- **Supervised**: `approvalPolicy: on-request`, `sandboxMode: workspace-write`; in-app approvals for commands/files.

## Code Conventions Worth Knowing

- **Effect everywhere.** The server, contracts, shared, and much of the web are built on Effect 4 (beta, pinned via the workspace catalog — never bump Effect-family versions in one package alone).
- **`Effect.fn("name")(function* () { ... })`** is the preferred boundary for tracing and metrics — prefer it over bare `Effect.gen`. See `docs/effect-fn-checklist.md` for the progressive refactor list. New code should follow the pattern.
- **Spans are load-bearing for debugging.** The server writes completed spans to `~/.t3/userdata/logs/server.trace.ndjson` (configurable) and optionally OTLP-exports to Grafana LGTM. Use `Effect.annotateCurrentSpan({...})` for high-cardinality context (ids, paths). Keep metric labels low-cardinality. Full guide in `docs/observability.md`.
- **Contracts are schema-only.** Runtime logic in `@t3tools/contracts` is disallowed. Keep it to `effect/Schema` definitions and types.
- **`@t3tools/shared` has no barrel.** Import from the subpath: `import { gitRunCommand } from "@t3tools/shared/git"`. Don't add an `index.ts`.
- **Contracts imports resolve to source in tests.** `vitest.config.ts` aliases `@t3tools/contracts` to `packages/contracts/src/index.ts`, so you don't need to rebuild contracts to run tests.
- **`bun run dev` depends on a contracts build.** Turbo wires `dev → @t3tools/contracts#build`. If web/server typecheck fails with missing exports after you change contracts, run `bun run build:contracts`.
- **Lint config** (`.oxlintrc.json`): `correctness`, `suspicious`, and `perf` categories are warnings. `no-shadow` and `no-await-in-loop` are disabled intentionally.
- **No Node-test / no `bun test`.** Vitest only. Tests co-located with source (`*.test.ts`).

## Reference Repos

- Codex (OSS): https://github.com/openai/codex
- CodexMonitor (Tauri, feature-complete reference for protocol + UX flows): https://github.com/Dimillian/CodexMonitor

## Further Reading (in-repo)

- `.docs/architecture.md` — startup, turn, and async completion sequence diagrams.
- `.docs/provider-architecture.md` — push channels and transport state machine.
- `.docs/encyclopedia.md` — glossary for project/thread/turn/aggregate/reactor/receipt vocabulary.
- `.docs/workspace-layout.md`, `.docs/scripts.md`, `.docs/quick-start.md`, `.docs/runtime-modes.md`.
- `docs/observability.md` — traces, metrics, OTLP/LGTM setup, jq recipes.
- `docs/release.md` — release + signing checklist.
- `REMOTE.md` — pairing + `t3 serve` headless flow.
