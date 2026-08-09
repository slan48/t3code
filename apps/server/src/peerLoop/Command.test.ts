/**
 * The machine-local stop bound, and how strictly it is read.
 *
 * Pure: no subprocess, no filesystem. What is under test is the parse, which is
 * the part where a lenient reading would silently hand the operator a shutdown
 * bound they never wrote — and shutting a Builder turn down early is exactly the
 * ambiguous half-applied state this integration exists to avoid.
 */
import { describe, expect, it } from "vite-plus/test";

import {
  PEER_LOOP_STOP_TIMEOUT_MAX_SECONDS,
  PEER_LOOP_STOP_TIMEOUT_MIN_SECONDS,
  readStopTimeoutSeconds,
} from "./Command.ts";

describe("readStopTimeoutSeconds", () => {
  it("uses the built-in default when nothing is configured", () => {
    expect(readStopTimeoutSeconds(undefined, undefined)).toBe(null);
  });

  it("accepts whole seconds inside the documented range", () => {
    expect(readStopTimeoutSeconds("120", undefined)).toBe(120);
    expect(readStopTimeoutSeconds(" 900 ", undefined)).toBe(900);
    expect(readStopTimeoutSeconds(undefined, 300)).toBe(300);
    expect(readStopTimeoutSeconds(String(PEER_LOOP_STOP_TIMEOUT_MIN_SECONDS), undefined)).toBe(
      PEER_LOOP_STOP_TIMEOUT_MIN_SECONDS,
    );
    expect(readStopTimeoutSeconds(String(PEER_LOOP_STOP_TIMEOUT_MAX_SECONDS), undefined)).toBe(
      PEER_LOOP_STOP_TIMEOUT_MAX_SECONDS,
    );
  });

  it("never reads a numeric prefix out of something that is not a number", () => {
    // `parseInt` would answer 120 here, and the operator would never know the
    // rest of what they typed had been thrown away.
    expect(readStopTimeoutSeconds("120junk", undefined)).toBe(null);
    expect(readStopTimeoutSeconds("120 seconds", undefined)).toBe(null);
    expect(readStopTimeoutSeconds("1e4", undefined)).toBe(null);
    expect(readStopTimeoutSeconds("0x1f4", undefined)).toBe(null);
    expect(readStopTimeoutSeconds("--600", undefined)).toBe(null);
    expect(readStopTimeoutSeconds("+600", undefined)).toBe(null);
    expect(readStopTimeoutSeconds("Infinity", undefined)).toBe(null);
    expect(readStopTimeoutSeconds("NaN", undefined)).toBe(null);
  });

  it("rejects fractions from either source: seconds are whole", () => {
    expect(readStopTimeoutSeconds("120.5", undefined)).toBe(null);
    expect(readStopTimeoutSeconds(undefined, 120.5)).toBe(null);
  });

  it("rejects non-finite and unsafe numbers from local.json", () => {
    expect(readStopTimeoutSeconds(undefined, Number.NaN)).toBe(null);
    expect(readStopTimeoutSeconds(undefined, Number.POSITIVE_INFINITY)).toBe(null);
    expect(readStopTimeoutSeconds(undefined, Number.MAX_VALUE)).toBe(null);
  });

  it("ignores anything outside one minute to one hour", () => {
    expect(readStopTimeoutSeconds("59", undefined)).toBe(null);
    expect(readStopTimeoutSeconds("3601", undefined)).toBe(null);
    expect(readStopTimeoutSeconds("0", undefined)).toBe(null);
    expect(readStopTimeoutSeconds(undefined, 59)).toBe(null);
    expect(readStopTimeoutSeconds(undefined, 3_601)).toBe(null);
    expect(readStopTimeoutSeconds(undefined, -600)).toBe(null);
  });

  it("treats a blank variable as unset, so local.json still decides", () => {
    expect(readStopTimeoutSeconds("", 300)).toBe(300);
    expect(readStopTimeoutSeconds("   ", 300)).toBe(300);
  });

  it("lets a valid variable win over local.json", () => {
    expect(readStopTimeoutSeconds("120", 900)).toBe(120);
  });

  it("falls back to the default, not to local.json, when the variable is unusable", () => {
    // Presence decides precedence, exactly as it does for the executable. An
    // operator who set the variable is looking at the variable; quietly obeying
    // a different number from a file they are not reading would be worse than
    // the documented default.
    expect(readStopTimeoutSeconds("120junk", 900)).toBe(null);
    expect(readStopTimeoutSeconds("30", 900)).toBe(null);
    expect(readStopTimeoutSeconds("120.5", 900)).toBe(null);
  });
});
