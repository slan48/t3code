import { useNavigate } from "@tanstack/react-router";
import { RepeatIcon } from "lucide-react";
import { memo, useCallback } from "react";

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

/**
 * The Peer Loop navigation entry.
 *
 * DELIBERATELY STATIC, AND THAT IS THE INTERESTING PART. Peer Loop's bridge is
 * a subprocess started lazily by the first Peer Loop RPC, so a sidebar entry
 * that read the status atom to decide whether to show itself would spawn
 * `peer-loop` on every T3 Code startup — including on machines that have never
 * used the feature and are not meant to pay for it. Agent Runs can hide itself
 * because reading a directory costs nothing; this cannot.
 *
 * So the entry is always there, and opening it is what asks whether Peer Loop
 * is installed. The index says so plainly if it is not.
 */
export const SidebarPeerLoopEntry = memo(function SidebarPeerLoopEntry() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();

  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/peer-loop" });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="sm"
        className="h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        onClick={handleClick}
      >
        <RepeatIcon className="size-4.5 shrink-0" />
        <span>Peer Loop</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
});
