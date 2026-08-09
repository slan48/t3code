import { memo } from "react";

import { cn } from "~/lib/utils";
import type { PeerLoopErrorPresentation, PeerLoopTone } from "~/peerLoopPresentation";

const TONE_CLASS: Readonly<Record<PeerLoopTone, string>> = {
  neutral: "bg-muted text-muted-foreground",
  info: "bg-info/15 text-info",
  warning: "bg-warning/15 text-warning",
  danger: "bg-destructive/15 text-destructive",
  success: "bg-success/15 text-success",
};

export const PeerLoopPill = memo(function PeerLoopPill({
  label,
  tone,
  className,
}: {
  readonly label: string;
  readonly tone: PeerLoopTone;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[0.6875rem] font-medium",
        TONE_CLASS[tone],
        className,
      )}
    >
      {label}
    </span>
  );
});

export const PeerLoopSection = memo(function PeerLoopSection({
  title,
  count,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
        {count === undefined ? null : <span className="ms-1.5 font-normal">({count})</span>}
      </h2>
      <div className="flex min-w-0 flex-col gap-2">{children}</div>
    </section>
  );
});

/**
 * A failed command, shown with its structure intact.
 *
 * The refusal code is rendered because `CONTROL_UNAVAILABLE` and
 * `PROJECT_HAS_UNFINISHED_RUN` are different problems with different fixes, and
 * an operator who only sees prose cannot tell which they have. A timeout says
 * plainly that the command may already have applied — nothing is retried here,
 * because repeating a start would fork a session and repeating a recovery
 * would replay a Builder task.
 */
export const PeerLoopErrorNotice = memo(function PeerLoopErrorNotice({
  error,
  children,
}: {
  readonly error: PeerLoopErrorPresentation;
  readonly children?: React.ReactNode;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-md border px-3 py-2 text-sm",
        error.tone === "danger" ? "border-destructive/40" : "border-warning/40",
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">{error.title}</span>
        {error.code === null ? null : (
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.6875rem] text-muted-foreground">
            {error.code}
          </code>
        )}
      </div>
      {error.detail === null ? null : (
        <p className="break-words text-xs text-muted-foreground">{error.detail}</p>
      )}
      {error.mayHaveApplied ? (
        <p className="text-xs font-medium text-warning">
          Nothing was retried for you. Re-read the run before trying again.
        </p>
      ) : null}
      {children}
    </div>
  );
});
