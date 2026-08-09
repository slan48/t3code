# Peer Loop integration

T3 Code drives an external Peer Loop through one local subprocess speaking JSON
lines. This document is the contributor's view: where the boundary is, what the
server owns, and which invariants a change here must not break.

For the shipped behaviour and machine-local configuration, see
[docs/user/peer-loop.md](../user/peer-loop.md).

## The boundary

Peer Loop is the engine. It owns:

- the owner policy and its presence in every agent turn;
- the run state machine and every transition;
- the durable record — `state.json`, `events.jsonl`, the transcript;
- runtime ownership: one live writer per project, enforced with an atomic
  exclusive-create lease under Peer Loop's own home;
- every recovery decision, including whether an interrupted Builder task is
  replayed.

T3 Code is a structured control and observation surface. It communicates with
Peer Loop **only** through `peer-loop bridge --stdio`. It does not read or write
`~/.peer-loop`, does not parse terminal prose, does not import Peer Loop code,
does not reproduce its state machine, does not inspect ownership files, and does
not launch Codex or Claude for this feature.

This is the same discipline as the read-only Agent Runs integration, with one
difference: Agent Runs observes durable files, Peer Loop is _controlled_ through
a protocol. Agent Runs is untouched by any of this and remains read-only.

## Where the code is

| Module                                                 | Responsibility                                                                   |
| ------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `packages/contracts/src/peerLoop.ts`                   | Peer Loop protocol v1 as Effect Schema, plus the T3 RPC surface and typed errors |
| `apps/server/src/localConfig.ts`                       | Machine-local executable settings, read once, never RPC-reachable                |
| `apps/server/src/peerLoop/Command.ts`                  | Which program to run, and the exact argv                                         |
| `apps/server/src/peerLoop/Bridge.ts`                   | The stdio transport for one child: framing, correlation, fan-out                 |
| `apps/server/src/peerLoop/Service.ts`                  | Lazy connection, per-subscriber cursors, the RPC-facing API                      |
| `packages/client-runtime/src/state/peerLoop.ts`        | Atoms over the environment RPC session                                           |
| `packages/client-runtime/src/state/peerLoopReducer.ts` | Pure per-run view: cursor, bounded activity, projections                         |

## Contracts

Two rules pull against each other and both matter.

**Discriminants are strict.** Run states, halt kinds, reviewer decisions, actors
and recovery choices are literal unions. A value this build has never heard of
fails at the boundary rather than rendering as a blank badge or, worse, the
wrong one. `CONTROL_UNAVAILABLE`, `PROJECT_HAS_UNFINISHED_RUN`,
`REVIEWER_THREAD_BUSY`, `INVALID_RUN_STATE`, `CAPACITY_EXHAUSTED`,
`AUTH_REQUIRED`, `TRANSPORT_INTERRUPTED` and `DONE` all stay distinguishable
end to end; none of them is ever flattened into prose or a generic failure.

**Everything else is additive-tolerant.** Structs Peer Loop is expected to grow
use `Schema.StructWithRest`, so unmodeled keys survive verbatim as structured
unknown data and a newer bridge never becomes undecodable. `PeerLoopEvent.type`
and `payload.kind` are open strings for the same reason: a new event type must
not take the activity feed down.

Everything off the subprocess is decoded before anything reads it. There is no
`any` and no unchecked cast on that path.

## Executable resolution

`T3_PEER_LOOP_EXECUTABLE` → `T3_PEER_LOOP_NODE_ENTRY` → `peerLoopExecutable` →
`peerLoopNodeEntry` → `peer-loop` on `PATH`. The first source _present_ decides
even if it is invalid, because falling through from a bad value would run a
different Peer Loop than the operator asked for and say nothing.

The command and its arguments are separate values all the way to the spawner.
Nothing parses a shell string, no shell is used, and every resolution ends in
`bridge --stdio`. The resolved path is never sent to a client — `peerLoop.status`
reports only which _source_ it came from — and no RPC can set it.

## The transport

One child, owned by a `Scope`.

- stdout is protocol only. Every line is decoded with the contracts schema; a
  line that is not protocol ends the connection rather than being skipped,
  because a bridge writing prose on stdout is one whose responses cannot be
  trusted either.
- stderr is kept as a bounded, truncated tail for diagnostics. It is never
  streamed to a client and never grows.
- Requests are correlated by id, so out-of-order responses are fine. Each has a
  bounded timeout; a timed-out request is abandoned rather than left to resolve
  a caller that has already been told.
- Every pending request fails when the child exits or the protocol is violated.
- `bridge.ready` must arrive, and must announce protocol version 1, before any
  command is accepted. Anything else fails closed.

The child's exit status is observed once and shared, because both the reader and
the finalizer want it and awaiting the handle twice is not something to rely on.

## Shutdown

Closing the scope closes stdin. That is how Peer Loop is asked to stop: it
finishes any turn in flight and releases its own ownership leases. Only after
waiting, and only against the handle this server spawned, is the child
terminated. Nothing here finds processes by name or path — there is no code that
could.

On an unexpected exit the service publishes `interrupted` and stops. It does not
reconnect and it does not resume anything: Peer Loop's durable state is untouched
by its bridge dying, and deciding that a run should continue is the owner's call.
A later explicit `peerLoop.status` may start a fresh bridge; resuming a _run_
stays an explicit command.

## Fan-out and sequences

Peer Loop's `seq` is per-run, strictly increasing and contiguous, and every event
is durable before it is published. That is what makes multi-client safe:

- each subscriber has its own bounded feed and its own cursor;
- a subscriber only forwards `seq > cursor`, so when a second client attaches and
  Peer Loop replays the backlog for _it_, existing subscribers see duplicates and
  drop them;
- a `seq` that skips means this server's feed slid, and that is reported as
  `run-resync` — never papered over.

The server keeps transport state and cursors, and nothing else. There is no event
history here: Peer Loop's log is the durable record, and a client that missed
activity re-attaches from its own `afterSeq`.

## RPC surface and authorization

Nine methods, each with its own input and result — there is deliberately no
generic "send this bridge method", which would make the wire a pass-through for
whatever a client invented.

| Method                                                                                                             | Scope                   |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| `peerLoop.status`, `peerLoop.listRuns`, `peerLoop.attachRun`, `peerLoop.subscribeEvents`                           | `orchestration:read`    |
| `peerLoop.startRun`, `peerLoop.resumeRun`, `peerLoop.sendOwnerMessage`, `peerLoop.pauseRun`, `peerLoop.recoverRun` | `orchestration:operate` |

`RpcAuthorization` is exhaustive against `WsRpcGroup`, so adding a method without
choosing a scope is a type error.

The Builder permission mode is deliberately **not** exposed. It decides what an
agent may do on this machine, and widening it is not something a remotely
authorized client should be able to do; Peer Loop's own default applies.

## Testing

`apps/server/test/fixtures/peer-loop-fake-bridge.mjs` speaks the real wire
protocol and runs no agent. It is plain JavaScript because the Node-entry
override only accepts `.js`/`.mjs`/`.cjs`, so the tests exercise the real
resolution rather than a relaxed variant of it. Scenarios are selected with
`T3_PEER_LOOP_FAKE_SCENARIO`.

`Bridge.test.ts` covers framing, argv, correlation with out-of-order responses,
version and protocol rejection, stderr bounding, child exit with pending
requests, per-subscriber fan-out, and stdin-close shutdown. `Service.test.ts`
covers laziness, single-flight connection, refusal pass-through, deduplication
against a concurrent attach, explicit pause/resume/recover forwarding, and the
absence of any automatic recovery.

These tests need real timers — they wait on an actual subprocess — so they run
under `it.layer(..., { excludeTestServices: true })`. The default `it.effect`
clock is simulated and would never let a timeout or a read fire.

`Smoke.test.ts` runs against a real Peer Loop build when
`T3_PEER_LOOP_SMOKE_ENTRY` points at its `dist/cli/main.js`, and is limited to
`health` and `runs.list`: read-only, no agent, no credentials.

## What must not happen

1. **A T3 Code decision.** Forward intent, render facts. The Reviewer decides and
   Peer Loop enforces.
2. **A second path to Peer Loop.** No file reads, no terminal parsing, no
   importing its internals. If T3 Code needs a fact, it belongs in the protocol.
3. **Automatic recovery.** No reconnect that resumes a run, no replay of an
   interrupted Builder task, no default recovery choice.
4. **Unbounded anything.** Not the event history, not a subscriber's queue, not
   the stderr tail, not a pending request.
5. **A remotely settable executable.** The path is machine-local, read once, and
   never leaves the server.
