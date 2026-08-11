/**
 * `/navigator` — the persistent Navigator conversation surface.
 *
 * A Navigator conversation is an ordinary durable thread with
 * `purpose: "navigator"`, so this page is built entirely out of orchestration
 * project and thread shells. It reads no Peer Loop status, no run list, no
 * subscription, and issues no Peer Loop command: opening it must not spawn the
 * bridge, and the module imports nothing that could.
 *
 * `/peer-loop` remains the advanced execution inspector and is untouched.
 * Execute, confirmation and child run cards are later increments.
 */
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import {
  NavigatorLandingView,
  type NavigatorProject,
} from "../components/navigator/NavigatorLandingView";
import { Button } from "../components/ui/button";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { isElectron } from "../env";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { cn } from "~/lib/utils";
import { groupNavigatorThreadsByProject } from "~/navigatorThreads";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../state/entities";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "~/workspaceTitlebar";

function NavigatorRoute() {
  const navigate = useNavigate();
  const projects = useProjects();
  // The unfiltered shells on purpose: this is the one surface that wants the
  // Navigator threads the coding lists deliberately leave out.
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const handleNewThread = useNewThreadHandler();

  const groups = useMemo(
    () => groupNavigatorThreadsByProject(projects, threads),
    [projects, threads],
  );

  const goBack = useCallback(() => {
    void navigate({ to: "/" });
  }, [navigate]);

  const startConversation = useCallback(
    (project: NavigatorProject) => {
      // The same new-thread helper every coding surface uses, asked for a
      // different purpose. It opens (or reuses) this project's Navigator draft
      // slot, which is separate from its coding one.
      void handleNewThread(
        {
          environmentId: project.environmentId as NavigatorProject["environmentId"] & string,
          projectId: project.id,
        } as never,
        { purpose: "navigator" },
      );
    },
    [handleNewThread],
  );

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
            <span className="text-sm font-medium text-foreground">Navigator</span>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-4 sm:px-5">
          <div className="mx-auto w-full max-w-3xl min-w-0">
            <NavigatorLandingView
              groups={groups}
              connected={projects.length > 0 || bootstrapped}
              loading={!bootstrapped}
              onStartConversation={startConversation}
            />
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/navigator")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: NavigatorRoute,
});
