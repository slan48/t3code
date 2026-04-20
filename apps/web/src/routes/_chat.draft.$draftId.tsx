import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";
import ChatView from "../components/ChatView";
import { threadHasStarted } from "../components/ChatView.logic";
import { useComposerDraftStore, DraftId } from "../composerDraftStore";
import { SidebarInset } from "../components/ui/sidebar";
import { createThreadSelectorAcrossEnvironments } from "../storeSelectors";
import { useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { DiffPanelInlineSidebar } from "../components/chat/DiffPanelInlineSidebar";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../rightPanelLayout";

const noop = () => {};

function DraftChatThreadRouteView() {
  const navigate = useNavigate();
  const { draftId: rawDraftId } = Route.useParams();
  const draftId = DraftId.make(rawDraftId);
  const draftSession = useComposerDraftStore((store) => store.getDraftSession(draftId));
  const serverThread = useStore(
    useMemo(
      () => createThreadSelectorAcrossEnvironments(draftSession?.threadId ?? null),
      [draftSession?.threadId],
    ),
  );
  const serverThreadStarted = threadHasStarted(serverThread);
  const canonicalThreadRef = useMemo(
    () =>
      draftSession?.promotedTo
        ? serverThreadStarted
          ? draftSession.promotedTo
          : null
        : serverThread
          ? {
              environmentId: serverThread.environmentId,
              threadId: serverThread.id,
            }
          : null,
    [draftSession?.promotedTo, serverThread, serverThreadStarted],
  );

  const draftThreadRef = useMemo(
    () =>
      draftSession
        ? scopeThreadRef(draftSession.environmentId, draftSession.threadId)
        : null,
    [draftSession],
  );
  const terminalDockPosition = useTerminalStateStore((s) => s.terminalDockPosition);
  const setTerminalDockPosition = useTerminalStateStore((s) => s.setTerminalDockPosition);
  const terminalStateForRoute = useTerminalStateStore((s) =>
    selectThreadTerminalState(s.terminalStateByThreadKey, draftThreadRef),
  );
  const terminalDockedRight =
    terminalDockPosition === "right" && terminalStateForRoute.terminalOpen;
  const onDockTerminalBottom = useCallback(() => {
    setTerminalDockPosition("bottom");
  }, [setTerminalDockPosition]);
  const shouldUseDiffSheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY);

  useEffect(() => {
    if (!canonicalThreadRef) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(canonicalThreadRef),
      replace: true,
    });
  }, [canonicalThreadRef, navigate]);

  useEffect(() => {
    if (draftSession || canonicalThreadRef) {
      return;
    }
    void navigate({ to: "/", replace: true });
  }, [canonicalThreadRef, draftSession, navigate]);

  if (canonicalThreadRef) {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <ChatView
          environmentId={canonicalThreadRef.environmentId}
          threadId={canonicalThreadRef.threadId}
          routeKind="server"
        />
      </SidebarInset>
    );
  }

  if (!draftSession) {
    return null;
  }

  return (
    <>
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <ChatView
          draftId={draftId}
          environmentId={draftSession.environmentId}
          threadId={draftSession.threadId}
          routeKind="draft"
        />
      </SidebarInset>
      {!shouldUseDiffSheet && (
        <DiffPanelInlineSidebar
          diffOpen={false}
          onCloseDiff={noop}
          onOpenDiff={noop}
          renderDiffContent={false}
          terminalDockedRight={terminalDockedRight}
          terminalHeightPx={terminalStateForRoute.terminalHeight}
          onDockTerminalBottom={onDockTerminalBottom}
        />
      )}
    </>
  );
}

export const Route = createFileRoute("/_chat/draft/$draftId")({
  component: DraftChatThreadRouteView,
});
