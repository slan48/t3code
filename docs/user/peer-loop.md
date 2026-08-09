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
- **A Builder turn was cut off partway.** The run is paused, not failed, and the
  repository may already have changed. Resuming runs a Reviewer turn first; the
  interrupted task is never replayed on its own.
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
