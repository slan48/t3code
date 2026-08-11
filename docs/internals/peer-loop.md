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
Cancelling a waiter cancels that waiter. Installing the claim and forking the
runner are one uninterruptible handoff — a cancellation landing between them
would leave a deferred in the ref with nobody to complete it, and every later
caller would park on it. Only the wait afterwards is interruptible, which is
exactly the part a disconnecting client should be able to abandon.

**The connection, its handshake and "this service has stopped" are one value
under one mutex.** Adoption writes state and publishes a transport status, and
those have to look like one event to everybody else: with three separate refs,
shutdown landing between them would release what it found and then let the
attempt publish a `connected` status and a health snapshot describing a child
that had already been killed. Adoption refuses outright once the layer has
stopped, and the caller closes the provisional scope instead — so whichever of
the two runs second sees the other's work, and every interleaving ends with no
live entry, no health, a stopped transport and a dead child.

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

- Each subscriber has its own **bounded, run-filtered** feed and its own cursor,
  and forwards only `seq > cursor`. A second client attaching makes Peer Loop
  replay for _it_; everyone else drops those as duplicates.
- **The run filter is upstream of the bound.** A feed that accepted every run
  and filtered on the way out would let one busy run fill a quiet run's thousand
  slots and then tell that client to re-attach over activity it was never
  watching. Only the four run notifications carrying the subscribed `runId` are
  retained; transport termination still arrives.
- Loss is a fact, never an inference. A bounded queue _refuses_ an offer when it
  is full, and that refusal is recorded on the feed. The subscription then emits
  one `run-resync` carrying the last cursor it can vouch for and ends, so the
  client re-attaches from a known-safe point.
- When Peer Loop emits its own `run.resync`, it is forwarded and the
  subscription stops there at the safe cursor. It never advances past a range
  nobody can account for.
- **Attaches are serialised per run.** Peer Loop keeps one attachment per run, so
  a second `run.attach` mid-replay supersedes the first and leaves that
  subscriber silent. A per-run gate is taken before the attach and held until the
  replay reaches the `eventHighWaterMark` the attach itself reported —
  authoritative, unlike counting events, which is not possible when sequences can
  skip. The gate is reference-counted and disappears with its last user, so
  arbitrary run ids cannot grow a map.
- **Finding or creating that gate is one synchronous step.** Building the
  semaphore with an effect meant a lookup miss, a yield, and only then the write,
  so two first attachments for the same run could each miss and each build a gate
  of their own — serialising against nothing. The reference is taken
  uninterruptibly and returned against the exact slot it was taken from, so a
  caller cancelled mid-attach can neither leak a reference nor hand back one it
  never held.
- A subscription whose bridge dies **after** it reached its boundary ends with
  `interrupted` (or `stopped` on a clean server shutdown), never with the stale
  `connected` a plain read of the transport ref would still be showing. One that
  dies before its boundary ends with a resync instead: nothing was completed,
  and saying only "the connection went away" would leave the client believing it
  had the whole story. The transport end arrives as an item on the feed rather
  than as a closed queue, because ending a queue does not wake a consumer
  already parked on it.

The server keeps transport state and cursors, and nothing else. There is no event
history here: Peer Loop's log is the durable record, and a client that missed
activity re-attaches from its own `afterSeq`.

### Delivery starts when Peer Loop answers, not when the replay ends

The order inside one attach is the design, and it used to be wrong in a way that
made large backlogs undeliverable:

1. take a reference to the run's gate and then its single permit;
2. **only then** create the boundary watcher and the client's feed. Creating
   them earlier makes a subscriber queued behind another attach bank the
   _previous_ subscriber's replay and spend its whole bound on events it will
   drop as duplicates;
3. send `run.attach`, validate the answer;
4. **return.** The stream is available before a single backlog notification has
   been read. The old ordering awaited the whole replay first, so any backlog
   larger than one feed's bound overflowed unread — the client could not consume
   until the thing filling its queue had finished;
5. the permit stays with a bounded, service-owned guard fiber until the replay
   reaches its boundary. The guard has its own run-filtered feed and drains as
   fast as the bridge writes, so holding a run's attachment never depends on how
   fast a phone is reading.

`peerLoop.attachRun` uses the same path with no client feed: it returns its
validated snapshot at once, and its guard still holds the permit so the next
attach cannot supersede a replay that is still running. It has no subscription
to tell, so its boundary outcome goes to a bounded local record rather than
being dropped.

### Every boundary outcome is acted on

Success is only two things: the attach reported a boundary the client is already
past, or an event for that run arrived with a sequence at or beyond it. Never a
count — sequences skip, so the length of a replay is not knowable in advance.

Everything else is a distinct failure and is kept apart, because they call for
different words and collapsing them would make "we stopped waiting" and "Peer
Loop said its own stream had a hole" the same sentence: `peer-resync`,
`boundary-overflow` (the guard's feed), `transport-ended`, `timeout` and
`cancelled`. On any of them the permit is released and each affected
subscription ends with exactly **one** `run-resync`, at a cursor it has actually
delivered. Nothing follows it. The timeout is a recovery threshold, not a way to
let the next attach in quietly.

### `run-attached`

The subscription's own `run.attach` answer, forwarded verbatim as the first
thing after the opening transport fact and before any backlog. It exists so a UI
does not have to issue a _second_ `run.attach` purely to learn a run's state and
whether it may be controlled — that attach would trigger a duplicate replay and
serialise behind the one already running, for data this server was already
holding. It is a transport convenience, not a new fact: state, control
availability and the boundary come straight from Peer Loop.

The client reducer takes state, control and the boundary from it and touches
nothing else. It does not move the cursor — an attach says what the run looks
like, not what this client has been shown — does not clear `needsResync`, and
does not discard retained activity.

### `run-synced`

A T3 transport fact, not a Peer Loop one — it says nothing about the run. It
exists because "the backlog is behind you" is otherwise unknowable to a client:
sequences skip, so a client cannot compute it, and the first replayed event
certainly does not prove it. Without it a `needsResync` set by a resync could
never be cleared, and a reattachment that legitimately had nothing to replay
would look permanently incomplete.

Emitted at most once per subscription, only after that subscriber has delivered
through its own attach's `eventHighWaterMark`, or immediately when its opening
cursor was already past it. Never after a resync, an overflow, a timeout or a
transport interruption. The client reducer treats it as an acknowledgement: it
clears `needsResync` and does not touch the cursor, and it ignores a fact
claiming a cursor the client never reached or a boundary it has not got to.

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

The bridge's `pendingRequestCount` and the service's `replaySlotCount`,
`peakSameRunReplays` and `recentBoundaryOutcomes` are inspection seams for tests
only — none is an RPC or part of the product API. `peakSameRunReplays` counts
inside **one run's** gate: a global count would read 2 for two different runs
replaying at once, which is correct behaviour, and would therefore say nothing
about the invariant that matters.

Two service seams, `beforeForkAttempt` and `beforeAdoptConnection`, park an
attempt in the two windows where a cancellation or a shutdown would otherwise be
a matter of scheduler luck.

These tests need real timers — they wait on an actual subprocess — so they run
under `it.layer(..., { excludeTestServices: true })`. The default `it.effect`
clock is simulated and would never let a timeout or a read fire.

`Smoke.test.ts` runs against a real Peer Loop build when
`T3_PEER_LOOP_SMOKE_ENTRY` points at its `dist/cli/main.js`, and is limited to
`health` and `runs.list`: read-only, no agent, no credentials.

## The web and desktop surface

`/peer-loop` and `/peer-loop/$runId`, authenticated, mobile-first, and
deliberately not merged with Agent Runs — that observes durable files T3 Code
wrote, this drives a separate tool over a protocol, and one list would suggest
they are the same kind of thing.

| Module                                   | Responsibility                                       |
| ---------------------------------------- | ---------------------------------------------------- |
| `apps/web/src/state/peerLoop.ts`         | Atoms over the primary environment; the per-run fold |
| `apps/web/src/state/peerLoopCommands.ts` | One hook per owner control, with typed refusals kept |
| `apps/web/src/peerLoopPresentation.ts`   | Every word the surface renders, as pure functions    |
| `apps/web/src/components/peerLoop/`      | Prop-driven views, server-renderable in tests        |

Five rules the UI is built on:

- **The sidebar entry is static.** It must not read the status atom, because the
  first Peer Loop RPC is what spawns the bridge — an always-mounted component
  reading it would start `peer-loop` on every T3 Code launch, on machines that
  have never used the feature. Agent Runs can hide itself; reading a directory
  costs nothing. This cannot.
- **One subscription per run.** The detail page consumes `run-attached` and the
  activity from the same stream and never issues its own attach.
- **Nothing is automatic.** Reattaching after a resync restores observation and
  only that. No run is started, resumed, recovered or re-messaged because a view
  came back, and no failed command is retried — a timeout says the command may
  already have applied and stops there.
- **Peer Loop decides.** Every label comes from its structured state, outcome,
  halt reason or control availability. Nothing is derived from prose, and a
  control Peer Loop said was unavailable is never enabled.
- **`available: false` means two different things.** `held_by_other_process` is
  read-only — someone else holds the project lease and T3 Code neither signals
  nor takes over. `not_attached` is the ordinary snapshot of a run nobody is
  driving, and `resumable` there says `run.resume` may take control. Reading the
  flag alone would leave every stopped run permanently unstartable.

**Resume before Recover.** Recovery is a live command, so an interrupted run in
the `not_attached` state shows Resume and an explanation rather than a Recover
button Peer Loop would refuse. `run.resume` on a run with recorded in-flight
work establishes ownership, detects the ambiguity and returns `interrupted:
true` — it runs no Reviewer or Builder turn, and the run stays `interrupted`
until `run.recover`. Observation is restarted afterwards, and the three choices
appear from the live snapshot that comes back.

**Restarting is one operation, not two.** The route reads the _current_ cursor
from the registry at action time, never from a render closure. If the safe
target moved, setting the cursor is the whole restart — mounting the new key
opens the replacement and unmounting the old one disposes it, and the key just
left is never refreshed. If the target is unchanged, refreshing that exact atom
is the restart. Doing both, as the first version did, issued a second attach at
the cursor it had already abandoned.

**A subscription is a resource, not a cache.** An open `peerLoop.subscribeEvents`
is a live `run.attach` on the machine running Peer Loop: it holds that run's
single attachment and occupies its replay coordination. So the events family is
created with `idleTtlMs: 0` and the web observation atom that reads it is
disposed the moment nothing renders it — the shared five-minute default is right
for a poll whose answer is worth keeping and wrong for this. It would also hand
a returning visitor the last event of a stream they had already left, which is
not what a fresh visit means. Only the two per-pair _scalars_, the cursor and
the generation, keep a bounded idle TTL, and `disposePeerLoopRun` resets them
explicitly anyway, so the TTL is a backstop rather than the mechanism.

**Leaving a pair disposes both halves of it.** The retained view and the cursor
are one thing: forgetting the view while leaving the cursor at 100 makes the
next visit open at 100 against a view that no longer holds 1–100, omitting them
for ever. `disposePeerLoopRun` resets the cursor through the registry, bumps a
generation so a still-cached observation cannot serve the view it just dropped,
and forgets the view last — because either write can make a mounted observation
recompute, and a recompute holding the subscription's last event would retain
the pair again on the way out. It refreshes nothing: leaving is when the stream
stops, not when it restarts. The route runs it from an effect keyed by the
actual `(environmentId, runId)` pair, so switching primary environment disposes
the pair that stopped being observed rather than whichever one is current.

**Observation state is keyed by `(environmentId, runId)`.** Run ids are Peer
Loop's and two machines can hold the same one; keyed by run alone, a change of
primary environment would attach the second machine's run from the first
machine's cursor and render the first machine's state, activity and control
availability — with mutation controls derived from the wrong machine. Route
teardown forgets the exact pair it mounted, and with no primary environment
nothing is subscribed and the retry is disabled rather than built from an
invented id.

**Restarting observation is a refresh, not a cursor write.** The subscription
atom is keyed by `(environment, run, afterSeq)`, so setting the cursor to the
value it already holds re-subscribes to nothing — which is exactly the case a
resync produces, since the safe cursor is usually where the view already is.
`useAtomRefresh` on that atom tears the completed stream down and opens one
replacement. The reducer view survives it: a restart at the cursor the view was
already trimmed to keeps `needsResync`, the snapshot and the activity at or
below that cursor, because that is what the client can still vouch for.

Every successful mutation restarts observation and refreshes the run list —
observation only. Nothing is replayed, and a timed-out mutation is never retried
whatever the owner does next.

**A failed subscription is visible.** A missing run, a dropped transport or an
unauthorized session renders as itself with a retry that only reads, not as a
run with nothing in it.

**The command gate is a closure flag, not React state.** A flag set inside a
`setState` updater is not a gate: two presses in the same tick both read
`pending: false` before either render lands, and for `run.ownerMessage` that
queues the same message twice. `createPeerLoopCommandGate` is plain, testable
and released on success, refusal, defect and teardown.

Start Run offers only projects this environment already knows and sends that
project's own `workspaceRoot`. No executable path, no permission mode, no
recovery default and no `newRun`: forcing past a duplicate-run refusal would
fork the Reviewer's conversation, so the refusal points at the existing run
instead.

Web, desktop-wrapped web and a remote browser are all covered by this one
surface. The shared client-runtime foundation stays available for a native
mobile screen later; there is none in this increment.

## Navigator threads

Navigator is a planning conversation and it is **not** a Peer Loop concept. It
reuses the ordinary durable T3 Code primitives — a project, a thread, its
messages and its proposed plans — with one immutable piece of metadata on the
thread: `purpose`, either `coding` or `navigator`. There is no Navigator table,
no second message store, no second plan store and no second orchestration
engine. A Navigator thread is a thread.

`purpose` is `coding` everywhere it is absent. Commands, `thread.created`
payloads, thread snapshots and the `projection_threads` row all decode it with a
default, and migration 036 adds the column with `NOT NULL DEFAULT 'coding'`, so
every thread and every orchestration event written before this existed keeps
working with no rewrite of the event log.

What the server enforces, in `commandInvariants.ts` rather than in a UI default,
so a client that sends the command anyway is refused with a typed
`OrchestrationCommandInvariantError`:

- a `navigator` thread may only be **created** with `runtimeMode:
"approval-required"` (T3 Code's existing read-only sandbox mapping),
  `interactionMode: "plan"`, no branch and no worktree;
- it may not later be moved off either mode — setting the value it already has
  stays valid, because an idempotent set protects nothing by failing;
- it may not be given a branch or a worktree afterwards either;
- `accept` and `acceptForSession` approval responses are refused, because an
  accepted approval is the one answer that lets a read-only thread act.
  `decline` and `cancel` stay allowed so a pending request can be cleared;
- checkpoint revert is refused: it rewinds a coding thread's worktree, and a
  Navigator thread has none.

`coding` threads are untouched by all of it.

### Executions as children of a Navigator conversation

A Navigator Execution Proposal can be run as a Peer Loop run. When it is, T3
Code records exactly one thing: an **immutable association** — Navigator thread
id, proposed plan id, Peer Loop run id, and the time the link was made. It lives
on the thread read model as `peerLoopExecutions` and in its own projection
table, `projection_thread_peer_loop_executions` (migration 037; `run_id`
primary key, unique on `(thread_id, proposed_plan_id)`).

That association is the whole of it. There is **no** run state, outcome, halt
reason, summary, iteration, activity, live writer or control anywhere in T3
Code's persistence, and there must never be. Peer Loop owns every one of those
and answers for them live over the protocol described above; a copy here would
be a second answer to the same question, wrong the moment the run moved. What
the link buys is the ability to show a run as a child of the conversation it
came from, and to still find it a week later — the durable half of a
relationship whose mutable half is read live.

The rules, enforced in the decider because the link is immutable and there is no
command that edits or removes one: the thread must be a `navigator` thread, the
proposal must exist on that thread, a proposal links to at most one run, and a
run id links at most once across the whole read model. The linking command is
internal — not part of `ClientOrchestrationCommand` — because only the
server-side coordination service that actually started a run knows a run id
worth recording.

`implementedAt` / `implementationThreadId` on a proposed plan are a different
fact ("a coding thread picked this plan up") and are left alone. Deleting a
projected thread drops its association rows so the read model keeps no orphans;
it does not delete a Peer Loop run or anything Peer Loop wrote.

### Executing a proposal: `peerLoop.executeProposal`

The server operation behind the future Execute action.
`PeerLoopExecutionCoordinator` (`apps/server/src/peerLoop/ExecutionCoordinator.ts`)
is coordination between two things that already exist — the orchestration engine
and the Peer Loop bridge — and owns no lifecycle of its own.

The sequence, in order, and each step matters:

1. **Validate against the projection.** The thread is active and its purpose is
   `navigator`; the proposal exists on _that_ thread; it has no
   `peerLoopExecutions` link already; it is not already implemented the ordinary
   way (`implementedAt` / `implementationThreadId`); the project is active and
   supplies the canonical `workspaceRoot`. Every refusal happens here, before
   Peer Loop is touched, so a rejected Execute leaves nothing behind.
2. **One `PeerLoopService.startRun` call.** The input is built server-side:
   `projectPath` is the project's own workspace root, `objective` is the
   proposal's `planMarkdown` verbatim, the optional safety limit is forwarded,
   and `newRun` is never set. A client sends only a thread id, a proposal id and
   that limit — it cannot name a directory, substitute an objective, waive Peer
   Loop's duplicate-run preflight, or supply a run id.
3. **Record the immutable link**, by dispatching the internal
   `thread.peer-loop-execution.link` command with the run id Peer Loop returned
   and a server-generated command id and timestamp.

#### At-most-once, and what it actually rests on

Attempts are serialized per `(threadId, proposedPlanId)`, and validation is
re-read **inside** that critical section. Two simultaneous Execute presses on
one proposal therefore produce one run: the second finds the link the first
recorded and is refused as already executed. The gate is per proposal rather
than global so two different proposals do not queue behind each other's bridge
spawn; its map is reference-counted so it stays bounded; and its key is
length-prefixed rather than separator-joined, because any separator is a byte
that could appear inside an id and the resulting collision would be silent.

**Serialization only works because dispatch is transactional with its
projection.** `OrchestrationEngine.processEnvelope` appends the event, calls
`projectionPipeline.projectEvent` — which runs every SQL projector — and writes
the accepted receipt inside **one** `sql.withTransaction`. `dispatch` resolves
only after that transaction has returned. So the SQL projection is _not_
eventually consistent with respect to a dispatch the caller awaited: by the time
the first request's link dispatch answers, `ProjectionSnapshotQuery` already
contains the link, and the next request through the gate sees it.

That is why validation and the post-dispatch confirmation both read
`ProjectionSnapshotQuery`, and why the coordinator has exactly **one**
validation source. There is no separate committed-state lookup and no second
opinion to keep in step; the projection is the authoritative read here.

(The engine's in-memory command read model is computed inside that same
transaction and assigned after it returns, still before `dispatch` resolves. It
backs the decider and `latestSequence`; the execution coordinator does not read
it.)

`getThreadDetailById` and `getProjectShellById` return only active rows —
`deleted_at IS NULL` — so deleted threads and projects are filtered by the
query, as they always were.

**Partial failure is explicit.** Peer Loop's own errors travel back untouched —
a `PROJECT_HAS_UNFINISHED_RUN` refusal keeps its code, a timeout keeps
`mayHaveApplied` — and a timed-out start is never retried, because Peer Loop may
already have started the run and a second start would fork a session. If the
link dispatch fails, the thread is re-read once from the projection — which is
written in the same transaction as the event, so it is the honest place to ask:
if that exact proposal/run pair is there the operation succeeded, and otherwise the caller gets a
typed `PeerLoopExecutionCoordinationError` with `reason: "link-not-confirmed"`,
the structured `runId`, and `mayHaveStarted: true` — so recovery is a deliberate
act on a run the owner can open, not a guess. Nothing auto-resumes, nothing
starts a second run, and nothing touches Peer Loop's recovery state. Every
pre-start reason carries `mayHaveStarted: false` and says plainly that no run
was started. Details come from a fixed sentence per reason plus the ids the
caller supplied: no SQL, no stack, no path beyond the project the authorized
client already sees, no provider output.

The method is scoped `AuthOrchestrationOperateScope`, like `startRun` it calls
underneath — it makes agents act and spends subscription capacity. Peer Loop
observation methods stay read-scoped and the existing explicit controls are
unchanged.

There is **no UI** for this yet, and no natural-language confirmation: the
operation is invoked explicitly and nothing infers agreement from prose.

### The Navigator conversation surface

`/navigator` is where an owner talks to Navigator. A Navigator conversation is
an ordinary durable orchestration thread with `purpose: "navigator"` — the same
messages, the same proposed plans, the same synchronization. There is no second
conversation store, message table, plan store or lifecycle.

**Opening or using this surface calls no Peer Loop RPC.** The route and its
sidebar entry are built only from orchestration project and thread shells, and
neither module imports a Peer Loop atom or command, so mounting them cannot
spawn the bridge. `/peer-loop` remains the advanced execution inspector,
unchanged.

**Purpose-aware drafts.** The existing composer draft gained an immutable
`purpose`, defaulted on decode so every draft persisted before Navigator
existed rehydrates as the coding draft it is. `useNewThreadHandler` takes a
`purpose` option that defaults to `coding`, so every existing caller behaves
exactly as before. A Navigator draft is pinned at creation to
`approval-required`, `plan`, `branch: null` and `worktreePath: null`, inherits
none of the coding composer's runtime/interaction/checkout state, and cannot be
moved off that shape by a later context edit.

**Two slots per project, and how they stay apart.**
`logicalProjectDraftThreadKeyByLogicalProjectKey` holds at most one draft per
logical project and evicts whatever it replaces. Navigator drafts are never
written into it — they are found by scanning `draftThreadsByThreadKey` instead —
so a project's Navigator draft and its coding draft cannot occupy the same slot,
evict each other, or be resurrected in place of one another. The persisted map
therefore keeps exactly the shape and meaning it had before Navigator existed.

**Promotion** goes through the existing bootstrap create-thread path: the first
send carries the draft's `purpose` (and, for Navigator, the pinned modes and
null checkout) into the ordinary `thread.create`. There is no Navigator-specific
create RPC, and coding promotion is unchanged.

**Coding lists exclude Navigator threads.** `useCodingThreadShells` filters them
out of the sidebar, command palette and the fallback that decides which thread
to open — landing in a planning-only conversation because it was the newest
thread would be an accident. Nothing is archived, retitled or transformed; the
threads stay synchronized and reachable from `/navigator` and their own chat
URL.

**Planning lockdown in the chat surface.** `apps/web/src/navigatorCapabilities.ts`
derives one capability record from the thread's purpose — runtime mode,
interaction mode, checkout, plan implementation, terminals, project scripts,
checkpoint revert, repository-mutating actions, approval accept — rather than
scattering `purpose === "navigator"` comparisons through the components.
`ChatView` derives it once and **passes it down**: `ChatHeader` (project
scripts, and the conversation identity badge), `MessagesTimeline` and
`ProposedPlanCard` (proposal wording and the workspace write), `PlanSidebar`
(the same wording and the same write), `PanelLayoutControls` (no terminal
toggle at all — a disabled one still advertises the feature), and the whole
`ChatComposer` tree through a single required `capabilities` prop.
`ChatComposer` forwards the individual answers to the leaves:
`ComposerPrimaryActions` (refine instead of implement),
`ComposerPendingApprovalActions` at both of its render sites (no accept;
decline and cancel kept) and `ComposerFooterModeControls` /
`CompactComposerControlsMenu` (no permission-mode selector, no plan/build
toggle). Children consume the record rather than re-deriving purpose, so a new
control cannot quietly skip the question.

**The leaf props are required, deliberately.** `canImplementPlan` and
`canAcceptApprovals` used to default to `true`, which is exactly how the live
composer kept offering implementation and approval after the capability record
existed: the record was correct and nothing read it. Removing the defaults
turned every unwired render site into a compile error.

**Retained UI state is filtered, not just un-advertised.** Terminal drawer state
and right panel surfaces are stored per thread and survive a reload, so
`terminalDrawerVisible`, `visibleRightPanelSurfaces` and `rightPanelVisible`
answer the capability against the stored value: a terminal drawer or panel tab
written before this rule existed does not come back. Teardown still reads the
unfiltered list, because a hidden terminal is still a running shell. The
branch/environment strip under the composer (`BranchToolbar`, its environment
picker and the pull-request checkout) is not rendered, and the
"Branch changed / Restore branch" banner is not derived at all — restoring runs
a real `git checkout` in the owner's working tree. The per-message revert
affordance is removed by deriving no checkpoint turn counts.

The callbacks read it again as an early guard, because hiding a button does not
unbind a keyboard shortcut, a slash command, or a stale reference in a component
that has not re-rendered: `onRespondToApproval` (which inspects the _decision_ —
`accept` and `acceptForSession` are blocked, `decline` and `cancel` are not),
`onImplementPlanInNewThread`, `runProjectScript`, `setTerminalOpen`,
`toggleTerminalVisibility`, `splitTerminal`, `splitPanelTerminal`,
`addTerminalSurface` and `createNewTerminal` (both reachable straight from the
terminal keybindings, where refusing to open the drawer would not have stopped
a shell from starting), `onRevertToTurnCount`, `handleRuntimeModeChange` and
`handleInteractionModeChange` (which is also the standalone slash-command path,
so `/default` is inert rather than refused). Declining and
cancelling a pending approval stay available: the server explicitly permits
clearing a request, and blocking it would strand a conversation with an
unanswerable question. Reading, navigating, conversing, refining the proposal
and copying stay available too — none of it mutates.

One guard is worth naming. `persistThreadSettingsForNextTurn` reconciles the
thread with the composer before every send, and on a Navigator thread its
branch reconciliation would fire on any turn whose local checkout differs from
the thread's `null` branch — dispatching a `thread.meta.update` the server
refuses, on every message the owner types. It returns early for Navigator
threads instead.

The same module supplies the proposal wording and the conversation identity, so
the timeline card and the Plan sidebar agree: a Navigator plan is an **Execution
Proposal**, and a coding thread's plan keeps the `Plan` / `Proposed plan`
wording it has always had. The identity is a badge rather than a title
convention, because the generated title stops saying "Navigator" the moment the
model names the conversation after its subject.

**The provider role frame.** `apps/server/src/orchestration/navigatorProviderFrame.ts`
holds one bounded, constant preamble. `ProviderCommandReactor` wraps it around
the owner's message at the shared turn-start boundary, so Codex, Claude, Cursor,
Grok and OpenCode all receive the same Navigator role without a single adapter
knowing Navigator exists. It says what Navigator is for — discussing approaches,
asking clarifying questions, maintaining one Execution Proposal through the
provider's own plan mechanism — and what it does not do: implement, edit files,
run implementation commands, claim work happened, act as Reviewer, or approve
Peer Loop owner decisions. It also says plainly that discussing an approach is
not authorization to execute it.

Two things about that frame. **The persisted message is the owner's text,
unchanged** — stored, replayed, shown in the timeline, and used for title
generation exactly as typed; only the provider-visible string for that turn is
wrapped. Persisting the wrapper would put words in the owner's mouth in their
own transcript. And **the frame is not the enforcement.** A model can be asked
not to edit files; it cannot be prevented by a sentence. The real boundary is
the one described above: a navigator thread is pinned to `approval-required`
and `plan`, owns no worktree, and the orchestration invariants refuse every
command that would change that. The frame shapes behaviour so the conversation
is useful; the server is what makes it safe.

**Still forthcoming, and deliberately not present yet:** the Execute action and
natural-language confirmation, child execution cards, structured run-result
context and the DONE return flow, the `OWNER_REQUIRED` explanation UI, and the
mobile Navigator UI.

Nothing else launches a run. The conversation surface described above is
planning-only: it has no Execute action, and the link and its history are
described above.

**This metadata duplicates nothing about Peer Loop.** It carries no run
lifecycle, no owner policy, no halt reason, no recovery decision and no live
writer. Peer Loop owns every one of those for its own runs, over its own
protocol, and a thread's purpose says nothing about them. Linking a Navigator
conversation to a Peer Loop run is later work and is not modelled here.

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
