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

describe("Peer Loop command gate", () => {
  it("runs the first invocation", async () => {
    const run = vi.fn(async () => AsyncResult.success("done"));
    const { gate, states } = gateWith(run);

    expect(await gate.invoke("a")).toBe("done");
    expect(run).toHaveBeenCalledTimes(1);
    expect(states.at(0)?.pending).toBe(true);
    expect(states.at(-1)).toMatchObject({ pending: false, success: "ok: done", error: null });
  });

  it("ignores a same-tick duplicate: one intent, one RPC", async () => {
    const settle = deferred<AsyncResult.AsyncResult<string, unknown>>();
    const run = vi.fn(() => settle.promise);
    const { gate } = gateWith(run);

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
    const { gate, states } = gateWith(run);

    expect(await gate.invoke("a")).toBe(null);
    expect(gate.isBusy()).toBe(false);
    expect(states.at(-1)?.error?.code).toBe("CONTROL_UNAVAILABLE");
    // Trying again is the owner's choice, not something the gate does.
    expect(await gate.invoke("a")).toBe(null);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("releases the gate when the call throws", async () => {
    const run = vi.fn(async () => {
      throw new Error("boom");
    });
    const { gate } = gateWith(run as never);

    await expect(gate.invoke("a")).rejects.toThrow("boom");
    expect(gate.isBusy()).toBe(false);
  });

  it("keeps the raw refusal so a duplicate run can be linked to", async () => {
    const refusal = new PeerLoopCommandRefusedError({
      code: "PROJECT_HAS_UNFINISHED_RUN",
      detail: "This project already has an unfinished run.",
      data: { runId: "run-9", overrideParam: "newRun" },
    });
    const { gate, states } = gateWith(async () =>
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
    const { gate, states } = gateWith(run);

    expect(await gate.invoke("a")).toBe(null);
    expect(run).toHaveBeenCalledTimes(1);
    expect(states.at(-1)?.error?.mayHaveApplied).toBe(true);
    expect(states.at(-1)?.error?.detail).toContain("may still have accepted");
  });

  it("stops publishing after disposal and releases the gate", async () => {
    const settle = deferred<AsyncResult.AsyncResult<string, unknown>>();
    const { gate, states } = gateWith(() => settle.promise);

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
