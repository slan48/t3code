import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";

import {
  deriveLatestAccountUsageSnapshot,
  formatAccountPlanType,
  formatAccountUsageWindowLabel,
} from "./accountUsage";

function makeActivity(
  id: string,
  payload: unknown,
  createdAt = "2026-07-30T12:00:00.000Z",
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind: "account-usage.updated",
    summary: "Account usage updated",
    payload,
    turnId: null,
    createdAt,
  };
}

describe("accountUsage", () => {
  it("derives remaining percentages from the latest account usage snapshot", () => {
    const snapshot = deriveLatestAccountUsageSnapshot([
      makeActivity("usage-1", {
        windows: [
          {
            id: "primary",
            usedPercentage: 42,
            windowDurationMinutes: 300,
            resetsAt: 1_775_000_000,
          },
          {
            id: "secondary",
            usedPercentage: 17,
            windowDurationMinutes: 10_080,
          },
        ],
        planType: "plus",
      }),
    ]);

    expect(snapshot).toMatchObject({
      planType: "plus",
      windows: [
        {
          id: "primary",
          label: "5-hour limit",
          usedPercentage: 42,
          remainingPercentage: 58,
        },
        {
          id: "secondary",
          label: "Weekly limit",
          usedPercentage: 17,
          remainingPercentage: 83,
        },
      ],
    });
  });

  it("merges sparse rolling updates without replacing unchanged windows", () => {
    const snapshot = deriveLatestAccountUsageSnapshot([
      makeActivity("usage-1", {
        windows: [
          { id: "primary", usedPercentage: 20, windowDurationMinutes: 300 },
          { id: "secondary", usedPercentage: 40, windowDurationMinutes: 10_080 },
        ],
        planType: "pro",
        reachedType: "rate_limit_reached",
      }),
      makeActivity(
        "usage-2",
        {
          windows: [{ id: "primary", usedPercentage: 65, windowDurationMinutes: 300 }],
        },
        "2026-07-30T12:05:00.000Z",
      ),
    ]);

    expect(snapshot?.windows).toEqual([
      expect.objectContaining({ id: "primary", remainingPercentage: 35 }),
      expect.objectContaining({ id: "secondary", remainingPercentage: 60 }),
    ]);
    expect(snapshot?.planType).toBe("pro");
    expect(snapshot?.reachedType).toBeNull();
    expect(snapshot?.updatedAt).toBe("2026-07-30T12:05:00.000Z");
  });

  it("ignores malformed activities and clamps provider percentages", () => {
    const snapshot = deriveLatestAccountUsageSnapshot([
      makeActivity("usage-1", { windows: [{ id: "primary", usedPercentage: 125 }] }),
      makeActivity("usage-2", { windows: [{ usedPercentage: 50 }] }),
    ]);

    expect(snapshot?.windows).toEqual([
      expect.objectContaining({ id: "primary", usedPercentage: 100, remainingPercentage: 0 }),
    ]);
  });

  it("formats provider limit and plan labels", () => {
    expect(formatAccountUsageWindowLabel("seven_day_opus", null)).toBe("Weekly Opus limit");
    expect(formatAccountUsageWindowLabel("primary", 180)).toBe("3-hour limit");
    expect(formatAccountPlanType("self_serve_business_usage_based")).toBe(
      "Self Serve Business Usage Based",
    );
  });
});
