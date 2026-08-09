/**
 * The lifetimes of the Peer Loop atoms, on the real factory.
 *
 * A subscription here is an open `run.attach` on the machine running Peer Loop
 * — it holds that run's single attachment and occupies its replay coordination
 * — so how long it survives with nobody watching is a resource question, not a
 * caching one. The polls are the opposite: their answers are worth keeping for
 * a few seconds.
 */
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createPeerLoopEnvironmentAtoms, PEER_LOOP_EVENTS_IDLE_TTL_MS } from "./peerLoop.ts";

const environmentId = "env-1" as never;

/**
 * The real factory, over a runtime that is never actually run.
 *
 * These assertions are about atom configuration, not about talking to a server,
 * and reading `idleTTL` is how that configuration is observable.
 */
const atoms = createPeerLoopEnvironmentAtoms(Atom.runtime(Layer.empty) as never);

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
