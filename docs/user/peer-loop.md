# Peer Loop

Peer Loop is a separate tool that runs a Reviewer and a Builder against one of
your repositories: the Reviewer decides what happens next and checks the work,
the Builder does one bounded task at a time, and Peer Loop carries every message
between them and writes down everything that happened.

T3 Code can drive it. When Peer Loop is installed on the machine running your T3
Code server, you can see its runs, start one, answer it, pause it, and resolve an
interrupted turn — from the desktop app, a browser, or your phone, over the same
connection you already use for everything else.

**Peer Loop is in charge.** It owns the owner policy, the run lifecycle, the
durable history of every run, which process is allowed to drive a project, and
every recovery decision. T3 Code forwards what you ask for and shows you what
Peer Loop reports. It never resumes a run for you, never retries a Builder task
on your behalf, and never decides that something is finished.

## What you need

- Peer Loop installed on the machine running the T3 Code server, with a
  `peer-loop` command available.
- Peer Loop's own requirements: a logged-in Codex CLI and a logged-in Claude Code
  CLI. T3 Code does not authenticate them and cannot fix them for you.

Nothing needs to be configured if `peer-loop` is on the server's `PATH`.

## Pointing T3 Code at a specific Peer Loop

Only the machine running the server can choose which program to run. This is
deliberate: naming a program for a machine to execute is not something a browser
on your phone should be able to do, so there is no setting for it in the app and
no way to change it remotely.

Two places, in this order of precedence:

1. **Environment variables**, for a terminal session:
   - `T3_PEER_LOOP_EXECUTABLE` — a `peer-loop` executable. A bare name is looked
     up on `PATH`; anything with a slash in it must be an absolute path.
   - `T3_PEER_LOOP_NODE_ENTRY` — an absolute path to a Peer Loop JavaScript entry
     file, run with the server's own Node. For a checkout rather than an install:
     `…/peer-loop/dist/cli/main.js`.
2. **`local.json`**, in the server's state directory, for an installed app —
   which never sees your login shell:
   ```json
   {
     "peerLoopExecutable": "/opt/peer-loop/bin/peer-loop",
     "peerLoopNodeEntry": "/Users/you/code/peer-loop/dist/cli/main.js"
   }
   ```
   `peerLoopExecutable` wins over `peerLoopNodeEntry` when both are set.

`local.json` also accepts `peerLoopStopTimeoutSeconds` (or the
`T3_PEER_LOOP_STOP_TIMEOUT_SECONDS` variable), covered under **Shutting down**
below.

If none of these is set, T3 Code runs `peer-loop` from `PATH`.

The first source that is _present_ decides, even if its value turns out to be
unusable — a relative path is reported as a configuration problem rather than
quietly falling through to a different Peer Loop than you asked for. The
configured path is never sent to a client; the app only ever tells you _which
setting_ it came from.

## What T3 Code starts, and when

Nothing runs until you use a Peer Loop feature. The first time you open Peer Loop
in the app, the server starts one `peer-loop bridge --stdio` process and keeps it
for as long as it is useful. An install without Peer Loop pays nothing for it and
starts exactly as it did before.

Everything travels over that one connection, as structured data. T3 Code does not
read Peer Loop's files and does not read its terminal output.

## Opening it

**Peer Loop** is in the sidebar, always — it does not hide itself when Peer Loop
is not installed, because finding out would mean starting the bridge on every
T3 Code launch, on machines that never asked for it. Opening the page is what
asks; if Peer Loop is not there, the page says so and how to point at it.

The index lists the runs on that machine in three groups — what needs you, what
is moving, and what is finished — with the project each belongs to and when it
last moved. Runs Peer Loop could not read are listed too, rather than quietly
left out.

**Start a run** from there. You pick one of the projects this T3 Code already
knows and write the objective; that project's own folder is what Peer Loop is
pointed at, and there is nothing to type a path into. A safety limit is
optional. If the project already has an unfinished run, Peer Loop says so and
the page offers you that run instead of starting a second one.

A run whose record still says the Reviewer or Builder is working, when Peer Loop
reports that nothing is actually driving it, is listed under **what needs you**
rather than as busy — see **A run that stopped part-way** below.

Opening a run leads with what you might have to act on: how it finished if it
did, the question the Reviewer escalated if there is one, what the Builder
reported when a turn failed, and the controls. Everything else — the run state,
iteration, which agents are configured, whether a turn was in flight, the full
current Builder task, the Reviewer's last decision, your queued messages and the
recent activity — is kept in full behind **Execution details**, a section you
open when you want it. Nothing is dropped or shortened by being in there.
Everything on that page is Peer Loop's own record; nothing is worked out locally.

A finished run opens with the Reviewer's own summary and the final state it
recorded. Both come from Peer Loop's structured `DONE`; neither is read out of a
Builder report, a prompt or the activity feed.

Web, the desktop app and a browser on your phone all use exactly this surface.

## Planning with Navigator

**Navigator** is the other half of this, and it is a conversation rather than a
console. It is where you think out loud about a piece of work — compare
approaches, argue with yourself, change your mind — with an agent that plans and
never builds. **Peer Loop**, the page described above, is the advanced execution
inspector: it is where runs are actually driven and where every decision that
changes something lives.

Open **Navigator** from the sidebar and start a conversation in one of your
projects. A project can have several going at once; they are ordinary durable
conversations that survive restarts, and they do not appear in your coding
thread lists.

### Execution Proposals

As you talk, Navigator keeps one **Execution Proposal** up to date — the plan as
it currently stands. It is a plan, not a commitment. Navigator does not edit
files, run commands, or start anything, and **discussing an approach is never
authorization to execute it.** You can say "let's do it after we swap the
database first" and nothing happens; that is a sentence about the future, and it
is treated as one.

### Handing a proposal to Peer Loop

Two ways, and they are the same action:

- press **Execute with Peer Loop** on the proposal, in the conversation or in
  the plan sidebar; or
- say one of a short, fixed list of standalone confirmations — `let's do it` or
  `hagamos eso`, and a couple of equally unambiguous alternatives like
  `execute the proposal`.

The phrase has to be the whole message, with nothing attached to it. Case,
spacing, a typographic apostrophe and a trailing full stop are all fine.
Anything longer, a question, a negation, a quote or a phrase with a condition
bolted on goes to Navigator as ordinary conversation. The list is deliberately
short: the difference between a sentence and an authorization is a Reviewer and
a Builder working in your repository.

Either way, the objective Peer Loop receives is **the proposal you were looking
at**, not the words you typed. A proposal that has already been executed, or
that a coding thread already implemented, does not offer the action again.

### Watching it from the conversation

Once a run exists, it appears as a **child execution card** under the proposal
it came from: the run, what Peer Loop says it is doing, and a link into the
execution details.

The conversation keeps working the whole time. You can ask what is happening,
plan the next piece, or refine a different proposal while a run is going; asking
about a run never touches it.

- When the run **finishes**, ask what changed and Navigator answers from Peer
  Loop's own record: the Reviewer's summary, the final state, and the commit the
  repository was left on.
- When the Reviewer needs **you**, Navigator can tell you the exact question, why
  it cannot decide, and the options it offered — and then point you at the
  execution details.

### Asking for the detail

Ordinary questions are answered from Peer Loop's structured results — the run's
state, the Reviewer's summary, the question it escalated. That is the default,
and it is enough most of the time.

If you want more, ask for it plainly: **"what happened step by step?"**, "show
me the execution activity", "show the run transcript", "why exactly did it
fail?", "muéstrame la actividad de la ejecución". Navigator then reads a bounded
slice of that run's recorded history — the most recent stretch of it — and
explains it. It reads one run per question: the one you name, or the most recent
one from this conversation.

This is still only reading. It never runs, resumes or changes anything, and if
the history cannot be read it says so and leaves the status it already had. For
the complete activity feed, the full Builder task, and every control, open the
execution details.

Navigator reads. It never approves, resumes, recovers, pauses or sends an owner
message, and it will tell you that rather than claim it did. **Approving,
answering, pausing, resuming and resolving an interrupted turn all happen in the
execution details**, using the controls described earlier on this page.

### When an Execute does not come back

If a run started but T3 Code could not confirm the link, or the request timed out
or the connection dropped mid-flight, the conversation says the outcome is
unknown and **takes the Execute action away**. Nothing is retried for you: a
second Execute would start a second run rather than repeat the first. Open Peer
Loop and see what is actually there before deciding.

## What you can do

- **See runs** for a project: state, iteration, when they last moved, and whether
  something else is currently driving them.
- **Start a run**, with the objective that is delivered word for word to the first
  Reviewer turn.
- **Watch activity** as it happens. Close the laptop, come back an hour later, and
  the app asks Peer Loop for exactly what it missed — nothing twice, and nothing
  quietly skipped. Catching up starts the moment Peer Loop answers, so an hour of
  history arrives as it is read rather than all at once at the end, and the app
  tells you when you are actually up to date instead of leaving you to guess. If
  the connection ever cannot keep the feed complete, you are told and the view
  picks up again from the last point it can vouch for rather than pretending it
  saw everything. A busy run in another window never costs this one its place.
- **Send an owner message.** If an agent is mid-turn it is queued and delivered at
  the next Reviewer turn, exactly as it would be if you had typed it into Peer
  Loop's own console. A running tool is never interrupted because you typed
  something.
- **Pause**, which takes effect at the next safe boundary and never mid-turn.
- **Resume** a paused run.
- **Resolve an interrupted turn**, by choosing one of Peer Loop's three options.
  Nothing is pre-selected and nothing happens until you pick one. Running the
  interrupted task again asks a second time first, because that task may already
  have changed the repository.

  If nothing is currently driving the run — the usual state of a run you come
  back to — the page asks you to **Resume first**. Resolving an interrupted turn
  is a live command, so Peer Loop has to be driving the run before it can accept
  one. Resuming reconnects and confirms the interrupted turn; it runs **no**
  Reviewer or Builder turn by itself, and the run stays interrupted until you
  choose. The three choices appear afterwards, once Peer Loop is in control.

- **Answer the Reviewer.** When it escalates a decision, the page shows the exact
  question, why it cannot decide, and each option it offered. Sending an option
  is one press and it goes as an ordinary owner message — nothing is sent because
  the page rendered it.

## Shutting down

Stopping the T3 Code server asks Peer Loop to stop too, and Peer Loop's next safe
moment is the end of the agent turn it is running. That can be several minutes,
so the server waits up to ten before it insists — because cutting a Builder off
mid-task is exactly the situation that leaves you unsure what reached the
repository.

If your turns legitimately run longer, raise it on this machine with
`peerLoopStopTimeoutSeconds` in `local.json` (or
`T3_PEER_LOOP_STOP_TIMEOUT_SECONDS`), anywhere from one minute to one hour, in
whole seconds.

Anything else is ignored and the ten minutes above applies: a value outside that
range, a fraction, or something that is not a number. `120s` and `two minutes`
are not read as 120 — a setting that half-worked would be worse than one that
did not, because you would never find out. As with the executable, the variable
decides once it is set: if you set it to something unusable, T3 Code falls back
to the default rather than to whatever `local.json` says, so the answer is never
a number you are not looking at. Leaving the variable empty is the same as not
setting it.

## Things T3 Code will tell you instead of hiding

- **Another process is driving this project.** Peer Loop allows one live writer per
  repository. If a terminal — or another T3 Code — holds it, you can still read the
  run here, and every control is refused with that reason. T3 Code will not signal,
  take over, or shut down the other session.
- **This project already has an unfinished run.** Starting a second one would fork
  the Reviewer's conversation, which cannot be recreated. You are shown the run
  and asked to continue it, or to say explicitly that this is different work.
- **The Reviewer thread is busy.** Peer Loop found the conversation intact but held
  by another writer. Nothing changed; close the other session and try again.
- **Capacity is exhausted, or a CLI needs signing in.** Both are fixed outside T3
  Code, on the machine running the agents. Peer Loop says which, and says whether
  the CLI reported a reset time — if it did not, T3 Code will not invent one.
- **A run that stopped part-way.** A run's record says the Reviewer or the
  Builder is working, and Peer Loop reports that no Reviewer or Builder is
  actually running it — the machine slept, the process was killed, the terminal
  was closed. It is shown as interrupted and listed under what needs you, rather
  than as a run that has been "Working" for eleven hours. This is Peer Loop's own
  answer about which process holds the run, not a guess from how long it has been
  quiet, and a run another Peer Loop process is driving is still running: you can
  read it here and it is not called interrupted. Nothing is resumed or recovered
  for you — **Resume** is there when Peer Loop says the run can be resumed, and
  pressing it stays your decision.
- **A Builder turn was cut off partway.** The run is paused, not failed, and the
  repository may already have changed. Resuming reconnects and confirms the
  interruption without running anything; the interrupted task is never replayed
  unless you explicitly choose that.
- **This run could not be read.** A run that no longer exists, a connection that
  dropped, a session that is no longer authorized — you are told which, and
  offered a button that looks again. Looking again only reads: nothing about the
  run is started, resumed or resolved by it.
- **The bridge stopped.** Your runs are unaffected — Peer Loop's record of them is
  on disk and nothing about them changed. T3 Code says the connection ended and
  waits for you; it does not restart a run to tidy the screen up.
- **A command timed out.** No answer arrived in time, which is not the same as
  nothing happening: Peer Loop may have accepted a start, a message or a recovery
  and finished after T3 Code stopped waiting. So nothing is retried for you.
  Re-read the run and decide — repeating a start that actually worked would fork
  the session, and repeating a recovery would replay a Builder task.
- **Something went wrong with the connection.** You are told which kind of thing —
  the program could not be started, it sent something unreadable, it stopped —
  without the filesystem paths or raw output behind it. Those stay on the server,
  where the person who can act on them already is.

## What T3 Code will not do

- Decide anything about the work. The Reviewer decides.
- Replay an interrupted Builder task, or pick a recovery for you.
- Weaken or reword the owner policy. What you see is Peer Loop's text.
- Take a project away from another Peer Loop process.
- Let a remote client change which program is run on this machine.
