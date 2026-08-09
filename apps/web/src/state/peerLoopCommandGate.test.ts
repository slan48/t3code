/**
 * The command gate: one intent, one RPC.
 *
 * The gate is deliberately free of React so this can be exercised directly. The
 * hook holds one of these in a ref; everything interesting about duplicate
 * suppression, release on failure and never retrying a timeout lives here.
 */
import { PeerLoopCommandRefusedError, PeerLoopTimeoutError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { createPeerLoopCommandGate, IDLE, type PeerLoopCommandState } from "./peerLoopCommands";
import { existingRunIdFromRefusal } from "~/peerLoopPresentation";

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((settle) => {
    resolve = settle;
  });
  return { promise, resolve } as const;
};

const gateWith = (run: (input: string) => Promise<AsyncResult.AsyncResult<string, unknown>>) => {
  const states: PeerLoopCommandState[] = [];
  const gate = createPeerLoopCommandGate<string, string>({
    run,
    describeSuccess: (value) => `ok: ${value}`,
    onState: (state) => states.push(state),
  });
  return { gate, states } as const;
};

/** A gate its owning effect has already activated, which is the normal case. */
const activeGateWith = (
  run: (input: string) => Promise<AsyncResult.AsyncResult<string, unknown>>,
) => {
  const harness = gateWith(run);
  harness.gate.activate();
  return harness;
};

describe("Peer Loop command gate lifecycle", () => {
  /**
   * React's development mount, without React.
   *
   * StrictMode runs setup → cleanup → setup. The gate used to be created live
   * and only ever disposable, so that middle cleanup killed it for good and
   * every Peer Loop mutation — Start, Pause, Owner message, Resume, Recover —
   * silently returned null in development without ever calling the RPC.
   */
  const strictModeMount = (gate: { activate: () => void; dispose: () => void }) => {
    gate.activate();
    gate.dispose();
    gate.activate();
  };

  it("sends exactly one command after a StrictMode remount", async () => {
    const run = vi.fn(async () => AsyncResult.success("done"));
    const { gate } = gateWith(run);

    strictModeMount(gate);
    expect(gate.isLive()).toBe(true);

    expect(await gate.invoke("a")).toBe("done");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("still suppresses a same-tick duplicate after the remount", async () => {
    const settle = deferred<AsyncResult.AsyncResult<string, unknown>>();
    const run = vi.fn(() => settle.promise);
    const { gate } = gateWith(run);
    strictModeMount(gate);

    const first = gate.invoke("a");
    expect(await gate.invoke("a")).toBe(null);
    expect(run).toHaveBeenCalledTimes(1);

    settle.resolve(AsyncResult.success("done"));
    expect(await first).toBe("done");
  });

  it("starts nothing before the owning effect has activated it", async () => {
    const run = vi.fn(async () => AsyncResult.success("done"));
    const { gate } = gateWith(run);
    // Created during render; the effect has not run yet.
    expect(gate.isLive()).toBe(false);
    expect(await gate.invoke("a")).toBe(null);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses every command after the final cleanup", async () => {
    const run = vi.fn(async () => AsyncResult.success("done"));
    const { gate } = gateWith(run);
    strictModeMount(gate);
    gate.dispose();

    expect(gate.isLive()).toBe(false);
    expect(await gate.invoke("a")).toBe(null);
    expect(run).not.toHaveBeenCalled();
  });

  it("publishes nothing when a command settles after the final cleanup", async () => {
    const settle = deferred<AsyncResult.AsyncResult<string, unknown>>();
    const { gate, states } = gateWith(() => settle.promise);
    strictModeMount(gate);

    void gate.invoke("a");
    const seen = states.length;
    gate.dispose();
    settle.resolve(AsyncResult.success("done"));
    await Promise.resolve();
    await Promise.resolve();

    expect(states.length).toBe(seen);
    expect(gate.isBusy()).toBe(false);
  });
});

describe("Peer Loop command gate", () => {
  it("runs the first invocation", async () => {
    const run = vi.fn(async () => AsyncResult.success("done"));
    const { gate, states } = activeGateWith(run);

    expect(await gate.invoke("a")).toBe("done");
    expect(run).toHaveBeenCalledTimes(1);
    expect(states.at(0)?.pending).toBe(true);
    expect(states.at(-1)).toMatchObject({ pending: false, success: "ok: done", error: null });
  });

  it("ignores a same-tick duplicate: one intent, one RPC", async () => {
    const settle = deferred<AsyncResult.AsyncResult<string, unknown>>();
    const run = vi.fn(() => settle.promise);
    const { gate } = activeGateWith(run);

    const first = gate.invoke("a");
    const second = gate.invoke("a");
    expect(run).toHaveBeenCalledTimes(1);
    expect(await second).toBe(null);

    settle.resolve(AsyncResult.success("done"));
    expect(await first).toBe("done");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("releases the gate on a typed refusal, so the owner may try again", async () => {
    const refusal = new PeerLoopCommandRefusedError({
      code: "CONTROL_UNAVAILABLE",
      detail: "held elsewhere",
      data: null,
    });
    const run = vi.fn(async () => AsyncResult.failure<string, unknown>(Cause.fail(refusal)));
    const { gate, states } = activeGateWith(run);

    expect(await gate.invoke("a")).toBe(null);
    expect(gate.isBusy()).toBe(false);
    expect(states.at(-1)?.error?.code).toBe("CONTROL_UNAVAILABLE");
    // Trying again is the owner's choice, not something the gate does.
    expect(await gate.invoke("a")).toBe(null);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("settles a thrown defect instead of staying pending for ever", async () => {
    const run = vi.fn(async () => {
      throw new Error("boom: /Users/nobody/secret-place");
    });
    const { gate, states } = activeGateWith(run as never);

    // No rejection escapes: the route's `.then` chain must not become an
    // unhandled rejection, and the button must not stay spinning.
    expect(await gate.invoke("a")).toBe(null);
    expect(gate.isBusy()).toBe(false);
    expect(states.at(-1)?.pending).toBe(false);
    expect(states.at(-1)?.error).not.toBe(null);
    // Whatever the defect carried never reaches a remote client.
    expect(JSON.stringify(states.at(-1))).not.toContain("secret-place");
    expect(states.at(-1)?.error?.mayHaveApplied).toBe(false);

    // And the owner can try again; nothing retried on its own.
    expect(run).toHaveBeenCalledTimes(1);
    await gate.invoke("a");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("starts no mutation after disposal", async () => {
    const run = vi.fn(async () => AsyncResult.success("done"));
    const { gate, states } = activeGateWith(run);

    gate.dispose();
    expect(await gate.invoke("a")).toBe(null);
    expect(run).not.toHaveBeenCalled();
    expect(states).toEqual([]);
  });

  it("keeps the raw refusal so a duplicate run can be linked to", async () => {
    const refusal = new PeerLoopCommandRefusedError({
      code: "PROJECT_HAS_UNFINISHED_RUN",
      detail: "This project already has an unfinished run.",
      data: { runId: "run-9", overrideParam: "newRun" },
    });
    const { gate, states } = activeGateWith(async () =>
      AsyncResult.failure<string, unknown>(Cause.fail(refusal)),
    );

    await gate.invoke("a");
    const failure = states.at(-1)?.failure ?? null;
    expect(failure).not.toBe(null);
    expect(failure === null ? null : existingRunIdFromRefusal(failure)).toBe("run-9");
    // The presentation stays sanitized; the structured data is not rendered.
    expect(states.at(-1)?.error?.detail).toBe("This project already has an unfinished run.");
  });

  it("does not retry a timed-out mutation, and says it may have applied", async () => {
    const timeout = new PeerLoopTimeoutError({
      method: "run.recover",
      timeoutMs: 30_000,
      mayHaveApplied: true,
    });
    const run = vi.fn(async () => AsyncResult.failure<string, unknown>(Cause.fail(timeout)));
    const { gate, states } = activeGateWith(run);

    expect(await gate.invoke("a")).toBe(null);
    expect(run).toHaveBeenCalledTimes(1);
    expect(states.at(-1)?.error?.mayHaveApplied).toBe(true);
    expect(states.at(-1)?.error?.detail).toContain("may still have accepted");
  });

  it("stops publishing after disposal and releases the gate", async () => {
    const settle = deferred<AsyncResult.AsyncResult<string, unknown>>();
    const { gate, states } = activeGateWith(() => settle.promise);

    void gate.invoke("a");
    const seen = states.length;
    gate.dispose();
    settle.resolve(AsyncResult.success("done"));
    await Promise.resolve();
    await Promise.resolve();

    expect(states.length).toBe(seen);
    expect(gate.isBusy()).toBe(false);
  });

  it("starts idle", () => {
    expect(IDLE).toMatchObject({ pending: false, error: null, failure: null, success: null });
  });
});
