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

Two things are versions rather than fields and are checked literally: the
envelope `v` on every request, response and notification, and
`RunStateFile.schemaVersion`. `bridge.ready.params.protocolVersion` deliberately
is not — a bridge that still frames v1 envelopes but speaks something newer has
to decode far enough to be classified as _incompatible_ rather than dismissed as
garbage.

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
- Requests are correlated by id, and a response whose `method` does not match
  its request fails the connection closed — correlation is the only thing making
  a result meaningful.
- Each request is bounded end to end. The bound covers the _enqueue_ as well as
  the wait, because stdin is a bounded queue and a bridge that stopped reading
  would otherwise park the offer before any timer started. `run.start` and
  `run.resume` get a much longer bound (minutes) than the rest: before they
  answer, Peer Loop takes a project lease, runs its duplicate-run preflight and
  probes both agent CLIs.
- A timed-out request is abandoned and its pending entry removed — on success,
  refusal, timeout, caller interruption, a failed enqueue and shutdown alike, via
  `ensuring`. A late response then finds nothing to resolve. For a mutation the
  error carries `mayHaveApplied: true`: Peer Loop may have accepted it and
  finished after we stopped waiting, so nothing is ever retried automatically.
- Every pending request fails when the child exits or the protocol is violated.
- **One synchronous ended-state, shared by everything that joins or leaves.**
  Registering a request, adding a subscriber and starting a shutdown all check
  and mutate the same plain variable in a single tick. Reading a `Deferred`
  cannot serve here: a request could observe "open", yield while building its
  own deferred, and land in `pending` after shutdown had already snapshotted and
  cleared it — a caller left waiting out its full bound on a transport that was
  already gone. A request racing a child exit now gets that exit's typed reason
  immediately.
- `bridge.ready` must arrive, announce protocol version 1, _and_ list every
  method and notification this build depends on. Announcing v1 is a claim;
  implementing it is the requirement. Extra capabilities are additive.
- A failure before the handshake keeps its real category: a child that died is a
  transport failure, junk on stdout is a protocol failure, and only a bridge that
  announced something we cannot speak is an incompatibility.

The child's exit status is observed once and shared, because both the reader and
the finalizer want it and awaiting the handle twice is not something to rely on.

## Starting one bridge, once

Nothing spawns until a Peer Loop RPC is used. Of any number of concurrent cold
callers exactly one installs a shared attempt, with a single `Ref.modify`, and
everyone else awaits its result — success or typed failure alike. Two bridges
would be two writers contending for the same project leases, which is the one
outcome Peer Loop's ownership model cannot express.

**The attempt is owned by the service, not by the caller that installed it.** An
RPC fiber dies when its client disconnects, and an attempt running on that fiber
would take the other waiters' answer with it and leave a half-started child that
nothing holds a handle to. So the attempt is forked into the service scope and
every caller, including the one that installed it, is only ever a waiter.
Cancelling a waiter cancels that waiter.

The provisional scope holding the child is closed on every exit that is not an
adoption — typed failure, defect, rejected handshake, interruption, or the layer
going down mid-handshake. `onExit`, not `tapError`: interruption is the path a
`tapError` never runs on, and what it leaks is an orphan `peer-loop` still
holding Peer Loop's leases. If the layer stops while an attempt is in flight, the
waiters are settled with a typed unavailable error rather than parked forever,
and the claim is cleared so nothing joins an attempt that will never finish.
A failure that completed is not retried by anything; a later explicit RPC starts
a fresh attempt.

## Shutdown

Closing the scope closes stdin. That is how Peer Loop is asked to stop: it
finishes any turn in flight and releases its own ownership leases. Only after
waiting, and only against the handle this server spawned, is the child
terminated. Nothing here finds processes by name or path — there is no code that
could.

**The wait is ten minutes, not ten seconds.** Peer Loop's next safe boundary is
the end of the agent turn already running, and its own per-turn timeouts are
optional and off by default, so a Builder turn legitimately runs for many
minutes. A ten-second bound would terminate live turns as a matter of routine —
the exact ambiguous half-applied state this integration exists to avoid. An
operator whose turns run longer can raise it machine-locally with
`peerLoopStopTimeoutSeconds` (or `T3_PEER_LOOP_STOP_TIMEOUT_SECONDS`), bounded to
between one minute and one hour. Tests inject a short bound instead of waiting.

That value is read strictly. Only whole seconds are accepted from either source:
`parseInt` would read `"120junk"` as 120 and `"1e4"` as 1, handing an operator a
shutdown bound they never wrote and saying nothing about it, so a partial parse
is no parse. Precedence follows presence rather than validity, exactly as the
executable does — a set-but-unusable variable falls back to the built-in default
rather than to a `local.json` number the operator is not looking at, and a blank
variable counts as unset.

`shutdown` releases subscribers and pending requests _before_ it resolves
`closed`, and runs uninterruptibly. Resolving `closed` wakes the layer above,
which tears this connection's scope down and interrupts the very fiber doing the
releasing — so the announcement has to come last.

On an unexpected exit the service publishes `interrupted` and stops. It does not
reconnect and it does not resume anything: Peer Loop's durable state is untouched
by its bridge dying, and deciding that a run should continue is the owner's call.
A later explicit `peerLoop.status` may start a fresh bridge; resuming a _run_
stays an explicit command.

## Fan-out, replay and sequences

Peer Loop's `seq` is per-run, strictly increasing, and every event is durable
before it is published. It is **not contiguous**: an event can be given a number
and then fail to be recorded, so a skip is ordinary data. Nothing in T3 Code may
infer loss from a gap — doing so would cry wolf on a healthy run and stay silent
on a real drop.

- Each subscriber has its own **bounded** feed and its own cursor, and forwards
  only `seq > cursor`. A second client attaching makes Peer Loop replay for
  _it_; everyone else drops those as duplicates.
- Loss is a fact, never an inference. A bounded queue _refuses_ an offer when it
  is full, and that refusal is recorded on the feed. The subscription then emits
  one `run-resync` carrying the last cursor it can vouch for and ends, so the
  client re-attaches from a known-safe point.
- When Peer Loop emits its own `run.resync`, it is forwarded and the
  subscription stops there at the safe cursor. It never advances past a range
  nobody can account for.
- **Attaches are serialised per run.** Peer Loop keeps one attachment per run, so
  a second `run.attach` mid-replay supersedes the first and leaves that
  subscriber silent. A per-run gate is held for the attach and for the replay it
  starts, released when the stream reaches the `eventHighWaterMark` the attach
  itself reported — authoritative, unlike counting events, which is not possible
  when sequences can skip. The gate is reference-counted and disappears with its
  last user, so arbitrary run ids cannot grow a map.
- **Finding or creating that gate is one synchronous step.** Building the
  semaphore with an effect meant a lookup miss, a yield, and only then the write,
  so two first attachments for the same run could each miss and each build a gate
  of their own — serialising against nothing. The reference is taken
  uninterruptibly and returned against the exact slot it was taken from, so a
  caller cancelled mid-attach can neither leak a reference nor hand back one it
  never held.
- A subscription whose bridge dies ends with `interrupted` (or `stopped` on a
  clean server shutdown), never with the stale `connected` a plain read of the
  transport ref would still be showing. The transport end arrives as an item on
  the feed rather than as a closed queue, because ending a queue does not wake a
  consumer already parked on it.

The server keeps transport state and cursors, and nothing else. There is no event
history here: Peer Loop's log is the durable record, and a client that missed
activity re-attaches from its own `afterSeq`.

## What a client is allowed to read

`PeerLoopTransportStatus.detail` and every typed RPC error carry categories, not
specifics. The cause of a failed spawn names the configured executable path, and
a malformed stdout line can contain anything Peer Loop was carrying — an owner
message, a repository path, a task. Both are exactly what an operator on this
machine needs and exactly what must not reach a phone on the tailnet, so they go
to the bounded local diagnostics tail and the public detail says only what kind
of thing went wrong.

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

`Command.test.ts` is pure: it is entirely about how strictly the machine-local
stop bound is read, including everything that must be refused.

`Service.test.ts` additionally proves the hard parts with deterministic seams
rather than sleeps. A counting spawner holds every cold caller at the spawn, and
also reports when a spawn has been _entered_ and when a child actually _exists_
— which is what lets a test cancel the winning caller at an exact point: before
the spawn is released, after the child is running but before the handshake, and
with the layer going down in between. It counts entered attempts separately from
created children, so an attempt that was quietly abandoned and begun again shows
up. A two-party barrier starts two first attachments for one run with nothing
staggering them. Injected durations keep the stop and replay bounds measurable in
milliseconds, and a bridge-side `beforeRegisterRequest` seam parks a request in
the one window where it could have registered after a shutdown.

The bridge's `pendingRequestCount` and the service's `replaySlotCount` and
`peakConcurrentReplays` are inspection seams for tests only — none is an RPC or
part of the product API.

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
   the diagnostics tail, not a pending request, not the per-run replay gates.
5. **Inferring loss from a sequence skip.** Peer Loop's numbers are monotonic,
   not contiguous.
6. **A remotely settable executable.** The path is machine-local, resolved once
   for the life of the service, and never leaves the server.
