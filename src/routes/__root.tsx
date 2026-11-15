import { useEffect } from "react";
import { Outlet, createRootRoute } from "@tanstack/react-router";
import { Sidebar } from "../components/layout/Sidebar";
import { RightPanel } from "../components/layout/RightPanel";
import { ElicitationModal } from "../components/chat/ElicitationModal";
import { CommandPalette, useGlobalHotkeys } from "../components/ui/CommandPalette";
import { ErrorBanner, RouteErrorCard } from "../components/ui/ErrorBanner";
import { FpsOverlay } from "../components/ui/FpsOverlay";
import { ResizeHandle } from "../components/ui/ResizeHandle";
import { runsRespondElicitation } from "../lib/ipc";
import { useRunsStore } from "../stores/runs";
import { hydrateLayout, useUiStore } from "../stores/ui";

export const Route = createRootRoute({
  component: RootLayout,
  // Render crashes land in a designed card, never a blank pane (§8 M7).
  errorComponent: ({ error }) => (
    <RouteErrorCard
      error={error instanceof Error ? error : undefined}
      reset={() => window.location.reload()}
    />
  ),
});

function RootLayout() {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const rightPanelWidth = useUiStore((s) => s.rightPanelWidth);
  const setRightPanelWidth = useUiStore((s) => s.setRightPanelWidth);
  const paletteOpen = useUiStore((s) => s.paletteOpen);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const activeElicitation = useRunsStore((s) => s.activeElicitation);
  useGlobalHotkeys(() => setPaletteOpen(true));
  useEffect(() => {
    void hydrateLayout();
  }, []);

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-canvas text-text-primary">
      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <>
            <Sidebar width={sidebarWidth} />
            <ResizeHandle
              label="Sidebar width"
              value={sidebarWidth}
              min={220}
              max={480}
              side="right"
              onResize={setSidebarWidth}
              onCommit={(w) => setSidebarWidth(w, true)}
            />
          </>
        )}
        <main className="flex min-w-0 flex-1 flex-col">
          <Outlet />
        </main>
        {rightPanelOpen && (
          <>
            <ResizeHandle
              label="Right panel width"
              value={rightPanelWidth}
              min={300}
              max={720}
              side="left"
              onResize={setRightPanelWidth}
              onCommit={(w) => setRightPanelWidth(w, true)}
            />
            <RightPanel width={rightPanelWidth} />
          </>
        )}
      </div>
      {activeElicitation && (
        <ElicitationModal
          request={activeElicitation}
          onSubmit={(action, content) => {
            const { runId, requestId } = activeElicitation;
            useRunsStore.getState().clearElicitation();
            runsRespondElicitation(runId, requestId, action, content).catch((err) =>
              console.error("runs_respond_elicitation failed", err),
            );
          }}
        />
      )}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <ErrorBanner />
      <FpsOverlay />
    </div>
  );
}
