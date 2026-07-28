import type { AgentRunActivity, AgentRunProcess } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeActivity,
  describeProcess,
  formatDuration,
  formatRelative,
} from "./agentRunFormat";

const process = (overrides: Partial<AgentRunProcess>): AgentRunProcess => ({
  lockHeld: true,
  pid: 100,
  hostname: "host",
  lockState: "WORKER_RUNNING",
  acquiredAt: null,
  sameHost: true,
  alive: true,
  detached: false,
  inconsistent: false,
  ...overrides,
});

const activity = (overrides: Partial<AgentRunActivity>): AgentRunActivity => ({
  lastActivityAt: null,
  lastActivitySource: null,
  lastStreamWriteAt: null,
  streamBytes: null,
  filesChanged: null,
  filesChangedAt: null,
  filesChangedSource: null,
  ...overrides,
});

describe("formatDuration", () => {
  it("formats seconds, minutes, and hours", () => {
    expect(formatDuration(48_000)).toBe("48s");
    expect(formatDuration(451_000)).toBe("07m 31s");
    expect(formatDuration(4_320_000)).toBe("1h 12m");
  });

  it("refuses to render nonsense as a number", () => {
    expect(formatDuration(Number.NaN)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
  });
});

describe("formatRelative", () => {
  const now = Date.parse("2026-07-28T12:00:00.000Z");

  it("returns null when there is nothing to describe", () => {
    expect(formatRelative(null, now)).toBeNull();
    expect(formatRelative("not a date", now)).toBeNull();
  });

  it("describes recent and older timestamps", () => {
    expect(formatRelative("2026-07-28T11:59:57.000Z", now)).toBe("just now");
    expect(formatRelative("2026-07-28T11:17:00.000Z", now)).toBe("43m 00s ago");
  });
});

describe("describeProcess", () => {
  it("names the contradiction rather than smoothing it over", () => {
    const { label, tone } = describeProcess(process({ inconsistent: true, alive: false }));
    expect(label).toContain("Process not found");
    expect(label).toContain("still reports an agent running");
    expect(tone).toBe("attention");
  });

  it("says plainly when nothing is running", () => {
    expect(describeProcess(process({ lockHeld: false })).label).toBe("No agent is running");
  });

  it("distinguishes alive from unknown", () => {
    expect(describeProcess(process({ alive: true })).label).toBe("Process alive");
    expect(describeProcess(process({ alive: true, detached: true })).label).toBe(
      "Process alive (detached)",
    );
    // Off-host liveness is unknowable, and is never reported as dead.
    expect(describeProcess(process({ alive: null, sameHost: false })).label).toContain(
      "another host",
    );
    expect(describeProcess(process({ alive: null, sameHost: true })).label).toBe(
      "Process liveness unknown",
    );
  });
});

describe("describeActivity", () => {
  const now = Date.parse("2026-07-28T12:00:00.000Z");

  it("admits when nothing durable has happened", () => {
    expect(describeActivity(activity({}), now)).toEqual(["No durable activity recorded yet"]);
  });

  it("names the source of the activity it reports", () => {
    const lines = describeActivity(
      activity({
        lastActivityAt: "2026-07-28T11:59:26.000Z",
        lastActivitySource: "attempt-stream",
      }),
      now,
    );
    expect(lines[0]).toBe("Last durable activity 34s ago (agent output)");
  });

  it("marks a live file count as live", () => {
    const lines = describeActivity(
      activity({ filesChanged: 7, filesChangedSource: "workspace-probe" }),
      now,
    );
    expect(lines).toContain("7 files changed (live)");
  });

  it("does not mark a recorded file count as live", () => {
    const lines = describeActivity(
      activity({ filesChanged: 1, filesChangedSource: "run-record" }),
      now,
    );
    expect(lines).toContain("1 file changed");
  });
});
