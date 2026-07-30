import { GaugeIcon } from "lucide-react";
import { formatAccountPlanType, type AccountUsageSnapshot } from "~/lib/accountUsage";
import { formatRelativeTimeUntilLabel } from "~/timestampFormat";
import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

function formatPercentage(value: number): string {
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

function resetLabel(resetsAt: number | null): string | null {
  if (resetsAt === null) {
    return null;
  }
  const relative = formatRelativeTimeUntilLabel(new Date(resetsAt * 1000).toISOString());
  if (!relative) {
    return null;
  }
  if (relative === "Expired" || relative === "Soon") {
    return "Resets soon";
  }
  return `Resets in ${relative.replace(/ left$/, "")}`;
}

function remainingColor(remainingPercentage: number): string {
  if (remainingPercentage <= 10) {
    return "var(--color-red-500)";
  }
  if (remainingPercentage <= 25) {
    return "var(--color-amber-500)";
  }
  return "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";
}

export function AccountUsageMeter(props: { usage: AccountUsageSnapshot }) {
  const { usage } = props;
  const remainingValues = usage.windows.map((window) => window.remainingPercentage);
  if (usage.spendLimit) {
    remainingValues.push(usage.spendLimit.remainingPercentage);
  }
  const mostConstrained = remainingValues.length > 0 ? Math.min(...remainingValues) : null;
  const planLabel = formatAccountPlanType(usage.planType);
  const accessibleRemaining =
    mostConstrained === null ? "available" : `${formatPercentage(mostConstrained)} remaining`;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className={cn(
              "inline-flex h-7 cursor-pointer items-center gap-1 rounded-full border border-transparent px-1.5 text-muted-foreground outline-none transition-colors",
              "hover:bg-accent data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            )}
            aria-label={`Account usage ${accessibleRemaining}`}
          >
            <GaugeIcon className="size-3.5" aria-hidden="true" />
            {mostConstrained !== null ? (
              <span className="text-[11px] tabular-nums">{formatPercentage(mostConstrained)}</span>
            ) : null}
          </button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        className="dropdown-glass w-72 max-w-none border-0! bg-secondary! p-0 shadow-none! before:hidden"
      >
        <div className="flex flex-col gap-3 p-3">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">Account usage</div>
            {planLabel ? (
              <div className="text-[11px] text-muted-foreground/60">{planLabel}</div>
            ) : null}
          </div>

          {usage.windows.map((window) => {
            const color = remainingColor(window.remainingPercentage);
            const reset = resetLabel(window.resetsAt);
            return (
              <div key={window.id} className="flex flex-col gap-1.5">
                <div className="flex items-start justify-between gap-3 text-[11px]">
                  <div>
                    <div className="font-medium text-muted-foreground/85">{window.label}</div>
                    {reset ? <div className="text-muted-foreground/55">{reset}</div> : null}
                  </div>
                  <div className="shrink-0 font-medium tabular-nums text-muted-foreground/85">
                    {formatPercentage(window.remainingPercentage)} left
                  </div>
                </div>
                <div
                  className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(window.remainingPercentage)}
                  aria-label={`${window.label} remaining`}
                >
                  <div
                    className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                    style={{
                      width: `${window.remainingPercentage}%`,
                      backgroundColor: color,
                    }}
                  />
                </div>
              </div>
            );
          })}

          {usage.spendLimit ? (
            <div className="flex items-center justify-between gap-3 border-border/60 border-t pt-2 text-[11px]">
              <span className="text-muted-foreground/60">Extra usage</span>
              <span className="font-medium tabular-nums text-muted-foreground/85">
                {usage.spendLimit.used} / {usage.spendLimit.limit}
              </span>
            </div>
          ) : null}

          {usage.credits ? (
            <div className="flex items-center justify-between gap-3 border-border/60 border-t pt-2 text-[11px]">
              <span className="text-muted-foreground/60">Credits</span>
              <span className="font-medium tabular-nums text-muted-foreground/85">
                {usage.credits.unlimited
                  ? "Unlimited"
                  : (usage.credits.balance ?? (usage.credits.hasCredits ? "Available" : "None"))}
              </span>
            </div>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
