import { useEffect, useRef, useState } from "react";
import { Outlet, createRootRoute, useRouter, useRouterState } from "@tanstack/react-router";
import { Sidebar } from "../components/layout/Sidebar";
import { RightPanel } from "../components/layout/RightPanel";
import { ElicitationModal } from "../components/chat/ElicitationModal";
import { CommandPalette, useGlobalHotkeys } from "../components/ui/CommandPalette";
import { ErrorBanner, RouteErrorCard } from "../components/ui/ErrorBanner";
import { ContextMenu, type ContextMenuItem } from "../components/ui/ContextMenu";
import { FpsOverlay } from "../components/ui/FpsOverlay";
import { ImageLightbox } from "../components/ui/ImageLightbox";
import { ResizeHandle } from "../components/ui/ResizeHandle";
import {
  ipcErrorMessage,
  openExternalUrl,
  openInEditor,
  projectsList,
  providersWarmup,
  runsRespondElicitation,
  settingsGet,
  settingsSet,
  threadsList,
  workspaceGlobalRoot,
} from "../lib/ipc";
import { activeWorkspaceRoot } from "../lib/activeWorkspace";
import { classifyMarkdownHref, localFilePath } from "../lib/links";
import { preflightInstances } from "../lib/providerChecks";
import { isTauri } from "../lib/tauri";
import { useT } from "../lib/i18n";
import { useRunsStore } from "../stores/runs";
import { useProjectsStore } from "../stores/projects";
import { useSettingsStore } from "../stores/settings";
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
  const t = useT();
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUiStore((s) => s.setSidebarWidth);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const rightPanelWidth = useUiStore((s) => s.rightPanelWidth);
  const setRightPanelWidth = useUiStore((s) => s.setRightPanelWidth);
  const paletteOpen = useUiStore((s) => s.paletteOpen);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const activeElicitation = useRunsStore((s) => s.activeElicitation);
  const pendingThreadId = useUiStore((s) => s.pendingThreadId);
  const selectedInstanceId = useUiStore((s) => s.selectedInstanceId);
  const selectedProjectId = useProjectsStore((s) => s.selectedProjectId);
  const projects = useProjectsStore((s) => s.projects);
  const [resizing, setResizing] = useState(false);
  const router = useRouter();
  const onboarding = useRouterState({ select: (s) => s.location.pathname === "/welcome" });
  useGlobalHotkeys(() => setPaletteOpen(true));

  useEffect(() => {
    if (!pendingThreadId) return;
    useUiStore.getState().setPendingThread(null);
    void router.navigate({ to: "/thread/$threadId", params: { threadId: pendingThreadId } });
  }, [pendingThreadId, router]);

  // Clean install → guided onboarding. Existing installs with any project or
  // thread are marked complete silently, so the wizard never interrupts them.
  useEffect(() => {
    if (!isTauri() || router.state.location.pathname === "/welcome") return;
    let cancelled = false;
    void (async () => {
      const [done, threads, projects] = await Promise.all([
        settingsGet("onboarding_completed").catch(() => undefined),
        threadsList().catch(() => undefined),
        projectsList().catch(() => undefined),
      ]);
      if (
        cancelled ||
        done === undefined ||
        threads === undefined ||
        projects === undefined ||
        done === true
      ) {
        return;
      }
      if (threads.length === 0 && projects.length === 0) {
        void router.navigate({ to: "/welcome", replace: true });
      } else {
        void settingsSet("onboarding_completed", true).catch(() => {});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // Warm the selected provider so the first turn does not pay the 5–13 s CLI
  // cold start. Only provider changes trigger this: project switches must not
  // spawn agents (a cold Codex start on every project click looked like a hang).
  const projectRoot = projects.find((project) => project.id === selectedProjectId)?.rootPath;
  const projectRootRef = useRef(projectRoot);
  projectRootRef.current = projectRoot;
  const warmedInstanceRef = useRef("");
  useEffect(() => {
    if (!isTauri() || !selectedInstanceId) return;
    if (warmedInstanceRef.current === selectedInstanceId) return;
    const timer = window.setTimeout(() => {
      warmedInstanceRef.current = selectedInstanceId;
      void providersWarmup(selectedInstanceId, projectRootRef.current ?? null).catch(() => {
        warmedInstanceRef.current = "";
      });
    }, 700);
    return () => window.clearTimeout(timer);
  }, [selectedInstanceId]);
  useEffect(() => {
    void hydrateLayout();
    if (!isTauri()) return;
    void workspaceGlobalRoot()
      .then((root) => useUiStore.getState().setGlobalWorkspaceRoot(root))
      .catch(() => undefined);
  }, []);

  // Connection status is a startup chore, not a button: probe enabled providers
  // in the background and let Settings show the cached result instantly.
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    void (async () => {
      await useUiStore
        .getState()
        .loadInstances()
        .catch(() => undefined);
      if (cancelled) return;
      await preflightInstances(useUiStore.getState().instances).catch(() => undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Shrinking the window with both side rails open must not crush the chat.
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth < 1180 && sidebarOpen && rightPanelOpen) {
        useUiStore.getState().toggleSidebar();
      }
    };
    window.addEventListener("resize", onResize);
    onResize();
    return () => window.removeEventListener("resize", onResize);
  }, [sidebarOpen, rightPanelOpen]);

  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    items: Array<ContextMenuItem | "separator">;
  } | null>(null);
  const imagePreview = useUiStore((s) => s.imagePreview);
  const closeImagePreview = useUiStore((s) => s.closeImagePreview);

  // Kill the WebView's default right-click menu everywhere; show a real one
  // only where a real action exists (editable text, selected text, links).
  const openContextMenu = (event: React.MouseEvent) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    const target = event.target as HTMLElement;
    const field = target.closest<HTMLInputElement | HTMLTextAreaElement>(
      "input, textarea, [contenteditable='true']",
    );
    const selection = window.getSelection()?.toString() ?? "";
    const items: Array<ContextMenuItem | "separator"> = [];
    const mod = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";

    if (field) {
      const start = "selectionStart" in field ? (field.selectionStart ?? 0) : 0;
      const end = "selectionEnd" in field ? (field.selectionEnd ?? 0) : 0;
      const hasSelection = start !== end || selection.length > 0;
      const refocus = () => {
        field.focus();
        if ("setSelectionRange" in field) field.setSelectionRange(start, end);
      };
      items.push(
        {
          id: "cut",
          label: t("common.cut"),
          shortcut: `${mod}X`,
          disabled: !hasSelection || field.readOnly,
          onSelect: () => {
            refocus();
            document.execCommand("cut");
          },
        },
        {
          id: "copy",
          label: t("common.copy"),
          shortcut: `${mod}C`,
          disabled: !hasSelection,
          onSelect: () => {
            refocus();
            document.execCommand("copy");
          },
        },
        {
          id: "paste",
          label: t("common.paste"),
          shortcut: `${mod}V`,
          disabled: field.readOnly,
          onSelect: () => {
            void navigator.clipboard
              .readText()
              .then((text) => {
                refocus();
                document.execCommand("insertText", false, text);
              })
              .catch(() => undefined);
          },
        },
        {
          id: "select-all",
          label: t("common.selectAll"),
          shortcut: `${mod}A`,
          onSelect: () => {
            field.focus();
            field.select();
          },
        },
      );
    } else {
      const fail = (err: unknown) =>
        useUiStore.getState().setGlobalError({ kind: "protocol", message: ipcErrorMessage(err) });
      const link = target.closest<HTMLAnchorElement>("a[href]");
      const localHost = target.closest<HTMLElement>("[data-local-path]");
      const image =
        target.closest<HTMLImageElement>("img") ??
        localHost?.querySelector<HTMLImageElement>("img") ??
        null;
      if (image && !link) {
        const localPath = (image.closest<HTMLElement>("[data-local-path]") ?? localHost)?.dataset
          .localPath;
        items.push({
          id: "open-image",
          label: t("chat.openImage"),
          onSelect: () => useUiStore.getState().openImagePreview(image.src, image.alt),
        });
        if (localPath) {
          items.push(
            "separator",
            {
              id: "reveal",
              label: t("common.revealInExplorer"),
              onSelect: () => void openInEditor(localPath, "explorer").catch(fail),
            },
            {
              id: "open-editor",
              label: t("common.openInEditor"),
              onSelect: () =>
                void openInEditor(localPath, useSettingsStore.getState().preferredEditor).catch(
                  fail,
                ),
            },
            {
              id: "copy-path",
              label: t("common.copyPath"),
              onSelect: () => void navigator.clipboard.writeText(localPath).catch(() => undefined),
            },
          );
        } else if (/^https?:/i.test(image.src)) {
          items.push({
            id: "copy-image",
            label: t("common.copyLink"),
            onSelect: () => void navigator.clipboard.writeText(image.src).catch(() => undefined),
          });
        }
      }
      const rawHref = link?.getAttribute("href") ?? "";
      const workspace = activeWorkspaceRoot();
      const classified = rawHref ? classifyMarkdownHref(rawHref, workspace) : null;

      if (classified?.kind === "external") {
        items.push(
          {
            id: "open-browser",
            label: t("common.openInBrowser"),
            onSelect: () => void openExternalUrl(classified.url).catch(fail),
          },
          {
            id: "copy-link",
            label: t("common.copyLink"),
            onSelect: () =>
              void navigator.clipboard.writeText(classified.url).catch(() => undefined),
          },
        );
      } else if (classified?.kind === "workspace") {
        if (/\.html?$/i.test(classified.relativePath)) {
          items.push({
            id: "open-browser",
            label: t("common.openInBrowser"),
            onSelect: () => useUiStore.getState().openInBrowserPanel(classified.relativePath),
          });
        }
        items.push(
          {
            id: "reveal",
            label: t("common.revealInExplorer"),
            onSelect: () => void openInEditor(classified.fullPath, "explorer").catch(fail),
          },
          {
            id: "open-editor",
            label: t("common.openInEditor"),
            onSelect: () =>
              void openInEditor(
                classified.fullPath,
                useSettingsStore.getState().preferredEditor,
              ).catch(fail),
          },
          {
            id: "copy-path",
            label: t("common.copyPath"),
            onSelect: () =>
              void navigator.clipboard.writeText(classified.fullPath).catch(() => undefined),
          },
        );
      } else {
        const absolute = localFilePath(rawHref);
        if (absolute) {
          items.push(
            {
              id: "reveal",
              label: t("common.revealInExplorer"),
              onSelect: () => void openInEditor(absolute, "explorer").catch(fail),
            },
            {
              id: "open-editor",
              label: t("common.openInEditor"),
              onSelect: () =>
                void openInEditor(absolute, useSettingsStore.getState().preferredEditor).catch(
                  fail,
                ),
            },
            {
              id: "copy-path",
              label: t("common.copyPath"),
              onSelect: () => void navigator.clipboard.writeText(absolute).catch(() => undefined),
            },
          );
        } else if (selection) {
          items.push({
            id: "copy-selection",
            label: t("common.copy"),
            shortcut: `${mod}C`,
            onSelect: () => void navigator.clipboard.writeText(selection).catch(() => undefined),
          });
        }
      }
    }

    if (items.length === 0) {
      setContextMenu(null);
      return;
    }
    setContextMenu({ x: event.clientX, y: event.clientY, items });
  };

  return (
    <div
      className="relative flex h-screen flex-col overflow-hidden bg-canvas text-text-primary"
      onContextMenu={openContextMenu}
    >
      <div className="flex min-h-0 flex-1">
        <div
          aria-hidden={!sidebarOpen || onboarding}
          className={`shrink-0 overflow-hidden ${
            resizing ? "" : "transition-[width] duration-200 ease-out"
          } ${sidebarOpen && !onboarding ? "" : "pointer-events-none"}`}
          style={{ width: sidebarOpen && !onboarding ? sidebarWidth : 0 }}
        >
          <Sidebar width={sidebarWidth} />
        </div>
        {sidebarOpen && !onboarding && (
          <ResizeHandle
            label={t("common.sidebarWidth")}
            value={sidebarWidth}
            min={220}
            max={480}
            side="right"
            onResize={setSidebarWidth}
            onCommit={(w) => setSidebarWidth(w, true)}
            onDragChange={setResizing}
          />
        )}
        <main className="flex min-w-0 flex-1 flex-col">
          <Outlet />
        </main>
        {rightPanelOpen && !onboarding && (
          <ResizeHandle
            label={t("common.rightPanelWidth")}
            value={rightPanelWidth}
            min={300}
            max={720}
            side="left"
            onResize={setRightPanelWidth}
            onCommit={(w) => setRightPanelWidth(w, true)}
            onDragChange={setResizing}
          />
        )}
        <div
          aria-hidden={!rightPanelOpen || onboarding}
          className={`shrink-0 overflow-hidden ${
            resizing ? "" : "transition-[width] duration-200 ease-out"
          } ${rightPanelOpen && !onboarding ? "" : "pointer-events-none"}`}
          style={{ width: rightPanelOpen && !onboarding ? rightPanelWidth : 0 }}
        >
          <RightPanel width={rightPanelWidth} />
        </div>
      </div>
      {activeElicitation && (
        <ElicitationModal
          key={activeElicitation.requestId}
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
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenu.items}
          onClose={() => setContextMenu(null)}
        />
      )}
      {!onboarding && <ErrorBanner />}
      <FpsOverlay />
      {imagePreview && (
        <ImageLightbox src={imagePreview.src} alt={imagePreview.alt} onClose={closeImagePreview} />
      )}
    </div>
  );
}
