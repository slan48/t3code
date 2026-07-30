import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export interface AccountUsageWindowSnapshot {
  readonly id: string;
  readonly label: string;
  readonly usedPercentage: number;
  readonly remainingPercentage: number;
  readonly resetsAt: number | null;
  readonly windowDurationMinutes: number | null;
}

export interface AccountUsageSnapshot {
  readonly windows: ReadonlyArray<AccountUsageWindowSnapshot>;
  readonly planType: string | null;
  readonly limitName: string | null;
  readonly credits: {
    readonly balance: string | null;
    readonly hasCredits: boolean;
    readonly unlimited: boolean;
  } | null;
  readonly spendLimit: {
    readonly limit: string;
    readonly used: string;
    readonly remainingPercentage: number;
    readonly resetsAt: number | null;
  } | null;
  readonly reachedType: string | null;
  readonly updatedAt: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function formatAccountUsageWindowLabel(
  id: string,
  windowDurationMinutes: number | null,
): string {
  switch (id) {
    case "five_hour":
      return "5-hour limit";
    case "seven_day":
      return "Weekly limit";
    case "seven_day_opus":
      return "Weekly Opus limit";
    case "seven_day_sonnet":
      return "Weekly Sonnet limit";
    case "overage":
      return "Extra usage";
  }

  if (windowDurationMinutes === 300) {
    return "5-hour limit";
  }
  if (windowDurationMinutes === 10_080) {
    return "Weekly limit";
  }
  if (windowDurationMinutes === 1_440) {
    return "Daily limit";
  }
  if (windowDurationMinutes === 60) {
    return "Hourly limit";
  }
  if (windowDurationMinutes !== null && windowDurationMinutes > 0) {
    if (windowDurationMinutes % 1_440 === 0) {
      return `${windowDurationMinutes / 1_440}-day limit`;
    }
    if (windowDurationMinutes % 60 === 0) {
      return `${windowDurationMinutes / 60}-hour limit`;
    }
  }
  return id === "secondary" ? "Secondary limit" : "Usage limit";
}

export function deriveLatestAccountUsageSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): AccountUsageSnapshot | null {
  const windows = new Map<string, AccountUsageWindowSnapshot>();
  let latestUpdatedAt: string | null = null;
  let planType: string | null = null;
  let limitName: string | null = null;
  let credits: AccountUsageSnapshot["credits"] = null;
  let spendLimit: AccountUsageSnapshot["spendLimit"] = null;
  let reachedType: string | null = null;
  let foundLatestPayload = false;

  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (!activity || activity.kind !== "account-usage.updated") {
      continue;
    }
    latestUpdatedAt ??= activity.createdAt;
    const payload = asRecord(activity.payload);
    if (!payload) {
      continue;
    }

    if (!foundLatestPayload) {
      reachedType = asString(payload.reachedType);
      foundLatestPayload = true;
    }
    planType ??= asString(payload.planType);
    limitName ??= asString(payload.limitName);

    if (credits === null) {
      const value = asRecord(payload.credits);
      const hasCredits = asBoolean(value?.hasCredits);
      const unlimited = asBoolean(value?.unlimited);
      if (value && hasCredits !== null && unlimited !== null) {
        credits = {
          balance: asString(value.balance),
          hasCredits,
          unlimited,
        };
      }
    }

    if (spendLimit === null) {
      const value = asRecord(payload.spendLimit);
      const limit = asString(value?.limit);
      const used = asString(value?.used);
      const remainingPercentage = asFiniteNumber(value?.remainingPercentage);
      if (limit && used && remainingPercentage !== null) {
        spendLimit = {
          limit,
          used,
          remainingPercentage: clampPercentage(remainingPercentage),
          resetsAt: asFiniteNumber(value?.resetsAt),
        };
      }
    }

    const rawWindows = Array.isArray(payload.windows) ? payload.windows : [];
    for (const rawWindow of rawWindows) {
      const value = asRecord(rawWindow);
      const id = asString(value?.id);
      const usedPercentage = asFiniteNumber(value?.usedPercentage);
      if (!id || usedPercentage === null || windows.has(id)) {
        continue;
      }
      const windowDurationMinutes = asFiniteNumber(value?.windowDurationMinutes);
      const normalizedUsedPercentage = clampPercentage(usedPercentage);
      windows.set(id, {
        id,
        label: formatAccountUsageWindowLabel(id, windowDurationMinutes),
        usedPercentage: normalizedUsedPercentage,
        remainingPercentage: 100 - normalizedUsedPercentage,
        resetsAt: asFiniteNumber(value?.resetsAt),
        windowDurationMinutes,
      });
    }
  }

  if (latestUpdatedAt === null || (windows.size === 0 && spendLimit === null && credits === null)) {
    return null;
  }

  return {
    windows: Array.from(windows.values()).sort(
      (left, right) =>
        (left.windowDurationMinutes ?? Number.POSITIVE_INFINITY) -
        (right.windowDurationMinutes ?? Number.POSITIVE_INFINITY),
    ),
    planType,
    limitName,
    credits,
    spendLimit,
    reachedType,
    updatedAt: latestUpdatedAt,
  };
}

export function formatAccountPlanType(planType: string | null): string | null {
  if (!planType || planType === "unknown") {
    return null;
  }
  return planType
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
