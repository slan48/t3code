import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { BotIcon } from "lucide-react";
import { memo, useCallback } from "react";

import { AGENT_RUN_ACK_STORAGE_KEY, agentRunBadgeCount } from "~/agentRunAlerts";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { agentRunsListAtom } from "~/state/agentRuns";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

const AcknowledgementsSchema = Schema.Struct({ keys: Schema.Array(Schema.String) });

/**
 * The navigation entry, and the only permanently visible footprint of this
 * feature.
 *
 * Hidden entirely when no orchestrator home is configured — an install that
 * has never run one should not carry a dead link to prove it. The badge counts
 * only runs that are actually asking for something, so it goes back to zero
 * when the work is dealt with rather than accumulating a lifetime total.
 */
export const SidebarAgentRunsEntry = memo(function SidebarAgentRunsEntry() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const list = useAtomValue(agentRunsListAtom);
  const [acknowledged] = useLocalStorage(
    AGENT_RUN_ACK_STORAGE_KEY,
    { keys: [] as readonly string[] },
    AcknowledgementsSchema,
  );

  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/agent-runs" });
  }, [isMobile, navigate, setOpenMobile]);

  if (!list.configured) return null;

  const badge = agentRunBadgeCount(list.runs, acknowledged.keys);
  const running = list.runs.some((run) => !run.terminal);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="sm"
        className="h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        onClick={handleClick}
      >
        <BotIcon className="size-4.5 shrink-0" />
        <span>Agent Runs</span>
        {badge > 0 ? (
          <span
            className="ms-auto inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-warning px-1 text-[0.6875rem] font-semibold text-warning-foreground"
            aria-label={`${badge} run${badge === 1 ? "" : "s"} need attention`}
          >
            {badge}
          </span>
        ) : running ? (
          <span
            className={cn("ms-auto size-1.5 shrink-0 rounded-full bg-info")}
            aria-label="A run is in progress"
          />
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
});
