/**
 * The lifetimes of the Peer Loop atoms, on the real factory.
 *
 * A subscription here is an open `run.attach` on the machine running Peer Loop
 * — it holds that run's single attachment and occupies its replay coordination
 * — so how long it survives with nobody watching is a resource question, not a
 * caching one. The polls are the opposite: their answers are worth keeping for
 * a few seconds.
 */
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type { PeerLoopSubscriptionEvent } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";

import {
  createPeerLoopEnvironmentAtoms,
  createPeerLoopEnvironmentCommands,
  PEER_LOOP_EVENTS_IDLE_TTL_MS,
  rechunkPeerLoopEvents,
} from "./peerLoop.ts";

const environmentId = "env-1" as never;

/**
 * The real factory, over a runtime that is never actually run.
 *
 * These assertions are about atom configuration, not about talking to a server,
 * and reading `idleTTL` is how that configuration is observable.
 */
const atoms = createPeerLoopEnvironmentAtoms(Atom.runtime(Layer.empty) as never);
const commands = createPeerLoopEnvironmentCommands(Atom.runtime(Layer.empty) as never);

describe("Peer Loop atom lifetimes", () => {
  it("disposes a run's event subscription as soon as nothing observes it", () => {
    const events = atoms.events({ environmentId, input: { runId: "run-1", afterSeq: 0 } });
    // Zero, not the family's five-minute default: leaving a run must stop its
    // attach, and a fresh visit must not be handed the last event of a stream
    // the viewer had already left.
    expect(events.idleTTL).toBe(0);
    expect(PEER_LOOP_EVENTS_IDLE_TTL_MS).toBe(0);
  });

  it("keeps the polled answers briefly, because they are answers", () => {
    const status = atoms.status({ environmentId, input: {} });
    const runs = atoms.runs({ environmentId, input: {} });
    expect(status.idleTTL).not.toBe(0);
    expect(runs.idleTTL).not.toBe(0);
  });

  it("keys a subscription by environment, run and cursor", () => {
    const first = atoms.events({ environmentId, input: { runId: "run-1", afterSeq: 0 } });
    const again = atoms.events({ environmentId, input: { runId: "run-1", afterSeq: 0 } });
    const moved = atoms.events({ environmentId, input: { runId: "run-1", afterSeq: 5 } });
    const other = atoms.events({
      environmentId: "env-2" as never,
      input: { runId: "run-1", afterSeq: 0 },
    });

    expect(again).toBe(first);
    expect(moved).not.toBe(first);
    expect(other).not.toBe(first);
  });
});

describe("Peer Loop event delivery", () => {
  /**
   * Every item reaches the fold, not just the last one that arrived together.
   *
   * The atom's stream adapter keeps only the final element of each chunk it
   * pulls, so a run's opening burst — transport, `run-attached`, the whole
   * replayed backlog — collapsed to its last item and the detail page rendered a
   * raw run id with no state, no owner question and no controls. This asserts
   * the delivery shape that prevents it, at the value level rather than through
   * the reactivity layer that consumes it.
   */
  effectIt.effect("splits an arriving burst into one item per chunk", () =>
    Effect.gen(function* () {
      const items = [1, 2, 3, 4, 5];
      const chunks = yield* rechunkPeerLoopEvents(
        // One chunk carrying everything, which is how a burst that arrives
        // together reaches the client.
        Stream.fromIterable(items) as unknown as Stream.Stream<PeerLoopSubscriptionEvent>,
      ).pipe(Stream.chunks, Stream.runCollect);

      // One item per chunk, all of them, in order — so nothing can be coalesced
      // away by an adapter that only keeps a chunk's last element.
      expect(chunks.map((chunk) => chunk.length)).toEqual([1, 1, 1, 1, 1]);
      expect(chunks.flatMap((chunk) => [...chunk])).toEqual(items);
    }),
  );
});

describe("Peer Loop commands", () => {
  it("exposes every owner control as its own typed command", () => {
    // One command per method, so the server authorizes each separately and a
    // client cannot invent a method name.
    for (const command of [
      commands.startRun,
      commands.resumeRun,
      commands.sendOwnerMessage,
      commands.pauseRun,
      commands.recoverRun,
      commands.executeProposal,
    ]) {
      expect(command).toBeDefined();
    }
  });

  it("offers executing an agreed proposal, distinct from starting a run", () => {
    // Two different operations: `startRun` names a project and an objective,
    // `executeProposal` names a thread and a proposal and lets the server
    // derive both. There is no UI on the second one yet.
    expect(commands.executeProposal).not.toBe(commands.startRun);
    expect(WS_METHODS.peerLoopExecuteProposal).toBe("peerLoop.executeProposal");
  });
});
