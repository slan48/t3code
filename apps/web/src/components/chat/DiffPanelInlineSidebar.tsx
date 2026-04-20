import { Suspense, lazy, useCallback, type ReactNode } from "react";

import { RIGHT_DOCK_TERMINAL_SLOT_ID } from "../ChatView";
import {
  DiffPanelHeaderSkeleton,
  DiffPanelLoadingState,
  DiffPanelShell,
  type DiffPanelMode,
} from "../DiffPanelShell";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import { Sidebar, SidebarProvider, SidebarRail } from "../ui/sidebar";

const DiffPanel = lazy(() => import("../DiffPanel"));
const DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY = "chat_diff_sidebar_width";
const DIFF_INLINE_DEFAULT_WIDTH = "clamp(28rem,48vw,44rem)";
const DIFF_INLINE_SIDEBAR_MIN_WIDTH = 26 * 16;
const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;

const DiffLoadingFallback = (props: { mode: DiffPanelMode }) => {
  return (
    <DiffPanelShell mode={props.mode} header={<DiffPanelHeaderSkeleton />}>
      <DiffPanelLoadingState label="Loading diff viewer..." />
    </DiffPanelShell>
  );
};

export const LazyDiffPanel = (props: { mode: DiffPanelMode }): ReactNode => {
  return (
    <DiffWorkerPoolProvider>
      <Suspense fallback={<DiffLoadingFallback mode={props.mode} />}>
        <DiffPanel mode={props.mode} />
      </Suspense>
    </DiffWorkerPoolProvider>
  );
};

export const DiffPanelInlineSidebar = (props: {
  diffOpen: boolean;
  onCloseDiff: () => void;
  onOpenDiff: () => void;
  renderDiffContent: boolean;
  terminalDockedRight: boolean;
  terminalHeightPx: number;
  onDockTerminalBottom: () => void;
}) => {
  const {
    diffOpen,
    onCloseDiff,
    onOpenDiff,
    renderDiffContent,
    terminalDockedRight,
    terminalHeightPx,
    onDockTerminalBottom,
  } = props;
  const sidebarOpen = diffOpen || terminalDockedRight;
  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        onOpenDiff();
        return;
      }
      if (terminalDockedRight) {
        onDockTerminalBottom();
      }
      onCloseDiff();
    },
    [onCloseDiff, onDockTerminalBottom, onOpenDiff, terminalDockedRight],
  );
  const shouldAcceptInlineSidebarWidth = useCallback(
    ({ nextWidth, wrapper }: { nextWidth: number; wrapper: HTMLElement }) => {
      const composerForm = document.querySelector<HTMLElement>("[data-chat-composer-form='true']");
      if (!composerForm) return true;
      const composerViewport = composerForm.parentElement;
      if (!composerViewport) return true;
      const previousSidebarWidth = wrapper.style.getPropertyValue("--sidebar-width");
      wrapper.style.setProperty("--sidebar-width", `${nextWidth}px`);

      const viewportStyle = window.getComputedStyle(composerViewport);
      const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
      const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
      const viewportContentWidth = Math.max(
        0,
        composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
      );
      const formRect = composerForm.getBoundingClientRect();
      const composerFooter = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-footer='true']",
      );
      const composerRightActions = composerForm.querySelector<HTMLElement>(
        "[data-chat-composer-actions='right']",
      );
      const composerRightActionsWidth = composerRightActions?.getBoundingClientRect().width ?? 0;
      const composerFooterGap = composerFooter
        ? Number.parseFloat(window.getComputedStyle(composerFooter).columnGap) ||
          Number.parseFloat(window.getComputedStyle(composerFooter).gap) ||
          0
        : 0;
      const minimumComposerWidth =
        COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + composerRightActionsWidth + composerFooterGap;
      const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
      const overflowsViewport = formRect.width > viewportContentWidth + 0.5;
      const violatesMinimumComposerWidth = composerForm.clientWidth + 0.5 < minimumComposerWidth;

      if (previousSidebarWidth.length > 0) {
        wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
      } else {
        wrapper.style.removeProperty("--sidebar-width");
      }

      return !hasComposerOverflow && !overflowsViewport && !violatesMinimumComposerWidth;
    },
    [],
  );

  const showDiff = diffOpen && renderDiffContent;
  const showStacked = showDiff && terminalDockedRight;

  return (
    <SidebarProvider
      defaultOpen={false}
      open={sidebarOpen}
      onOpenChange={onOpenChange}
      className="w-auto min-h-0 flex-none bg-transparent"
      style={{ "--sidebar-width": DIFF_INLINE_DEFAULT_WIDTH } as React.CSSProperties}
    >
      <Sidebar
        side="right"
        collapsible="offcanvas"
        className="border-l border-border bg-card text-foreground"
        resizable={{
          minWidth: DIFF_INLINE_SIDEBAR_MIN_WIDTH,
          shouldAcceptWidth: shouldAcceptInlineSidebarWidth,
          storageKey: DIFF_INLINE_SIDEBAR_WIDTH_STORAGE_KEY,
        }}
      >
        <div className="flex h-full min-h-0 flex-col">
          {showDiff ? (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <LazyDiffPanel mode="sidebar" />
            </div>
          ) : null}
          <div
            id={RIGHT_DOCK_TERMINAL_SLOT_ID}
            className={`flex min-w-0 flex-col ${
              showStacked ? "flex-none border-t border-border/80" : "min-h-0 flex-1"
            } ${terminalDockedRight ? "" : "hidden"}`}
            style={showStacked ? { height: `${terminalHeightPx}px` } : undefined}
          />
        </div>
        <SidebarRail />
      </Sidebar>
    </SidebarProvider>
  );
};
