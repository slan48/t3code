import { useNavigate } from "@tanstack/react-router";
import { CompassIcon } from "lucide-react";
import { memo, useCallback } from "react";

import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

/**
 * The Navigator navigation entry.
 *
 * Separate from the Peer Loop entry, and separate on purpose. Navigator is a
 * planning conversation built from ordinary durable threads; `/peer-loop` is
 * the advanced inspector for runs that have already been launched. They are
 * different surfaces with different costs, and folding them together would
 * suggest opening one does what the other does.
 *
 * Static, and reading nothing. It does not consult Peer Loop status — mounting
 * this must not spawn the bridge — and it does not consult the thread list
 * either: an owner with no Navigator conversations is exactly the owner who
 * needs to find this.
 */
export const SidebarNavigatorEntry = memo(function SidebarNavigatorEntry() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();

  const handleClick = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    void navigate({ to: "/navigator" });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="sm"
        className="h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        onClick={handleClick}
      >
        <CompassIcon className="size-4.5 shrink-0" />
        <span>Navigator</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
});
