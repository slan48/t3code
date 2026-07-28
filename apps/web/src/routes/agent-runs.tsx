import { Outlet, createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useCallback, useEffect } from "react";

import { Button } from "../components/ui/button";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { isElectron } from "../env";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

/**
 * The Agent Runs surface.
 *
 * Laid out mobile-first: a single scrolling column with a sticky header, no
 * horizontal overflow, and no data table. Sergio reads this over Tailscale
 * from a phone at least as often as from a desktop, and the phone is the
 * harder constraint, so it is the one the layout is built around.
 */
function AgentRunsLayout() {
  const navigate = useNavigate();

  const goBack = useCallback(() => {
    void navigate({ to: "/" });
  }, [navigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      event.preventDefault();
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      goBack();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goBack]);

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header
          className={cn(
            "shrink-0 border-b px-3 py-2 transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none sm:px-5",
            isElectron && "drag-region h-[52px] items-center",
            COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS,
          )}
        >
          <div className="flex min-h-7 items-center gap-2 sm:min-h-6">
            <SidebarTrigger className="md:hidden" />
            <Button size="xs" variant="ghost" onClick={goBack} aria-label="Back to threads">
              <ArrowLeftIcon className="size-3.5" />
            </Button>
            <span className="text-sm font-medium text-foreground">Agent Runs</span>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-4 sm:px-5">
          <div className="mx-auto w-full max-w-3xl min-w-0">
            <Outlet />
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/agent-runs")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: AgentRunsLayout,
});
