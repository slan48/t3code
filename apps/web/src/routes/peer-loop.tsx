import { Outlet, createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useCallback, useEffect } from "react";

import { Button } from "../components/ui/button";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { isElectron } from "../env";
import { cn } from "~/lib/utils";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

/**
 * The Peer Loop surface.
 *
 * Same mobile-first shape as Agent Runs — one scrolling column, sticky header,
 * no data table — and deliberately a separate surface. Agent Runs observes
 * durable files T3 Code wrote; Peer Loop is a separate tool driven over a
 * protocol, and merging the two would suggest they are the same kind of thing.
 *
 * The bridge subprocess starts on the first Peer Loop RPC, which is why the
 * status is read here rather than anywhere that mounts on ordinary startup.
 */
function PeerLoopLayout() {
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
            <span className="text-sm font-medium text-foreground">Peer Loop</span>
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

export const Route = createFileRoute("/peer-loop")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: PeerLoopLayout,
});
