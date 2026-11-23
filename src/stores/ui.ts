import { create } from "zustand";
import { onAgentProcess, providersInstancesList, settingsGet, settingsSet } from "../lib/ipc";
import { isTauri } from "../lib/tauri";
import type { InstanceInfo } from "../lib/types";

export type RightPanelTab = "none" | "browser" | "diff" | "files" | "terminal" | "pull-requests";

/**
 * App-level error with a designed recovery path (§8 M7): agent crash,
 * storage failure, protocol failure. Rendered as a dismissible banner.
 */
export interface GlobalError {
  kind: "agent_crash" | "storage" | "protocol";
  /** Instance id when kind is agent_crash. */
  instanceId?: string;
  message: string;
}

/** Maps "agent:process" kinds onto InstanceInfo.status. */
const PROCESS_KIND_TO_STATUS: Record<string, InstanceInfo["status"]> = {
  starting: "starting",
  spawned: "running",
  running: "running",
  exited: "stopped",
  crashed: "crashed",
  needs_auth: "needs_auth",
};

/** Pane width bounds (§6.1 resizable sidebar/panel). */
export const SIDEBAR_MIN = 220;
export const SIDEBAR_MAX = 480;
export const RIGHT_PANEL_MIN = 300;
export const RIGHT_PANEL_MAX = 720;

interface UiState {
  sidebarOpen: boolean;
  sidebarWidth: number;
  rightPanelOpen: boolean;
  rightPanelWidth: number;
  rightPanelTab: RightPanelTab;
  /** Floating project card in the chat; independent of the right panel. */
  projectWidgetOpen: boolean;
  instances: InstanceInfo[];
  selectedInstanceId: string | null;
  /** ⌘K command palette visibility (§6.7) — opened from hotkeys and buttons. */
  paletteOpen: boolean;
  /** One-shot text handed to the composer (Branch from a message). */
  composerPrefill: string | null;
  /** Target queued for the built-in browser surface (path or URL). */
  browserTarget: string | null;
  /** Full-screen image preview (chat images, generated images, attachments). */
  imagePreview: { src: string; alt?: string } | null;
  /** Workspace-relative file the Files surface should preview. */
  filePreview: string | null;
  /** Thread the UI should open after a Branch action. */
  pendingThreadId: string | null;
  /** Diagnostics ring: last process events per instance (M6). */
  processEvents: Record<string, { at: number; kind: string; detail?: string | null }[]>;
  /** Latest unrecovered app-level error (§8 M7 error states). */
  globalError: GlobalError | null;
  /** Docked terminal under the chat, independent of the right panel. */
  bottomTerminalOpen: boolean;
  toggleSidebar: () => void;
  /** Project ids whose thread list is collapsed (session memory). */
  collapsedProjects: string[];
  toggleProjectCollapsed: (projectId: string) => void;
  toggleRightPanel: () => void;
  toggleBottomTerminal: () => void;
  setBottomTerminalOpen: (open: boolean) => void;
  toggleProjectWidget: () => void;
  setProjectWidgetOpen: (open: boolean) => void;
  setRightPanelTab: (tab: RightPanelTab) => void;
  setPaletteOpen: (open: boolean) => void;
  setComposerPrefill: (text: string | null) => void;
  openFilePreview: (path: string | null) => void;
  openInBrowserPanel: (target: string) => void;
  setBrowserTarget: (target: string | null) => void;
  openImagePreview: (src: string, alt?: string) => void;
  closeImagePreview: () => void;
  setPendingThread: (threadId: string | null) => void;
  setSidebarWidth: (width: number, persist?: boolean) => void;
  setRightPanelWidth: (width: number, persist?: boolean) => void;
  setSelectedInstanceId: (instanceId: string | null) => void;
  /** Remember the selected provider per thread (restored when reopening). */
  instanceByThread: Record<string, string>;
  rememberInstance: (threadId: string, instanceId: string) => void;
  /** Drops the per-thread agent choice when the thread is deleted. */
  clearThreadState: (threadId: string) => void;
  /** Applies a "agent:caps" patch without re-listing all providers. */
  patchInstance: (
    instanceId: string,
    patch: Partial<
      Pick<
        InstanceInfo,
        | "configOptions"
        | "modes"
        | "promptImage"
        | "loadSession"
        | "steeringSupported"
        | "authMethods"
        | "authHint"
        | "status"
      >
    >,
  ) => void;
  setGlobalError: (error: GlobalError) => void;
  clearGlobalError: () => void;
  /** Absolute root for projectless threads; hydrated from the Rust runtime. */
  globalWorkspaceRoot: string | null;
  setGlobalWorkspaceRoot: (root: string | null) => void;
  loadInstances: () => Promise<void>;
  applyProcessEvent: (instanceId: string, kind: string, detail?: string | null) => void;
}

let unlistenProcessEvents: (() => void) | null = null;

/** Writes both pane widths as one snapshot (no read-modify-write race). */
async function persistLayout() {
  try {
    const { sidebarWidth, rightPanelWidth } = useUiStore.getState();
    await settingsSet("layout", { sidebarWidth, rightPanelWidth });
  } catch (err) {
    console.error("persist layout failed", err);
  }
}

/** Loads persisted pane widths once at boot (§6.1 resizable panes). */
export async function hydrateLayout(): Promise<void> {
  if (!isTauri()) return;
  try {
    const layout = (await settingsGet("layout")) as Record<string, number> | null;
    if (!layout || typeof layout !== "object") return;
    useUiStore.setState((s) => ({
      sidebarWidth:
        typeof layout.sidebarWidth === "number"
          ? Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, layout.sidebarWidth))
          : s.sidebarWidth,
      rightPanelWidth:
        typeof layout.rightPanelWidth === "number"
          ? Math.min(RIGHT_PANEL_MAX, Math.max(RIGHT_PANEL_MIN, layout.rightPanelWidth))
          : s.rightPanelWidth,
    }));
  } catch (err) {
    console.error("hydrate layout failed", err);
  }
}

/** Subscribes "agent:process" once per session; no-op outside Tauri. */
async function ensureProcessEventSubscription(): Promise<void> {
  if (!isTauri() || unlistenProcessEvents) return;
  unlistenProcessEvents = await onAgentProcess(({ instanceId, kind, detail }) => {
    useUiStore.getState().applyProcessEvent(instanceId, kind, detail);
  });
}

const NARROW_WITH_PANELS = 1180;

/** Sidebar + right panel + transcript do not fit below this width. */
function isNarrowViewport(): boolean {
  return typeof window !== "undefined" && window.innerWidth < NARROW_WITH_PANELS;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarOpen: true,
  collapsedProjects: [],
  sidebarWidth: 288, // w-72 default (§6.1)
  rightPanelOpen: false,
  rightPanelWidth: 420, // slightly wider than the old fixed w-96
  rightPanelTab: "none",
  projectWidgetOpen: true,
  instances: [],
  selectedInstanceId: null,
  instanceByThread: {},
  paletteOpen: false,
  composerPrefill: null,
  filePreview: null,
  browserTarget: null,
  imagePreview: null,
  pendingThreadId: null,
  processEvents: {},
  globalError: null,
  bottomTerminalOpen: false,
  globalWorkspaceRoot: null,
  toggleSidebar: () =>
    set((s) => {
      const sidebarOpen = !s.sidebarOpen;
      return {
        sidebarOpen,
        rightPanelOpen: sidebarOpen && isNarrowViewport() ? false : s.rightPanelOpen,
      };
    }),
  toggleProjectCollapsed: (projectId) =>
    set((s) => ({
      collapsedProjects: s.collapsedProjects.includes(projectId)
        ? s.collapsedProjects.filter((id) => id !== projectId)
        : [...s.collapsedProjects, projectId],
    })),
  toggleRightPanel: () =>
    set((s) => {
      const rightPanelOpen = !s.rightPanelOpen;
      return {
        rightPanelOpen,
        sidebarOpen: rightPanelOpen && isNarrowViewport() ? false : s.sidebarOpen,
      };
    }),
  toggleBottomTerminal: () => set((s) => ({ bottomTerminalOpen: !s.bottomTerminalOpen })),
  setBottomTerminalOpen: (bottomTerminalOpen) => set({ bottomTerminalOpen }),
  toggleProjectWidget: () => set((s) => ({ projectWidgetOpen: !s.projectWidgetOpen })),
  setProjectWidgetOpen: (projectWidgetOpen) => set({ projectWidgetOpen }),
  setRightPanelTab: (tab) =>
    set((s) => ({
      rightPanelTab: tab,
      rightPanelOpen: true,
      sidebarOpen: isNarrowViewport() ? false : s.sidebarOpen,
    })),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setComposerPrefill: (composerPrefill) => set({ composerPrefill }),
  openFilePreview: (filePreview) =>
    set((s) => ({
      filePreview,
      rightPanelTab: "files",
      rightPanelOpen: true,
      sidebarOpen: isNarrowViewport() ? false : s.sidebarOpen,
    })),
  openInBrowserPanel: (browserTarget) =>
    set((s) => ({
      browserTarget,
      rightPanelTab: "browser",
      rightPanelOpen: true,
      sidebarOpen: isNarrowViewport() ? false : s.sidebarOpen,
    })),
  setBrowserTarget: (browserTarget) => set({ browserTarget }),
  openImagePreview: (src, alt) => set({ imagePreview: { src, alt } }),
  closeImagePreview: () => set({ imagePreview: null }),
  setPendingThread: (pendingThreadId) => set({ pendingThreadId }),
  setSidebarWidth: (width, persist = false) => {
    const sidebarWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)));
    set({ sidebarWidth });
    if (persist && isTauri()) void persistLayout();
  },
  setRightPanelWidth: (width, persist = false) => {
    const rightPanelWidth = Math.min(RIGHT_PANEL_MAX, Math.max(RIGHT_PANEL_MIN, Math.round(width)));
    set({ rightPanelWidth });
    if (persist && isTauri()) void persistLayout();
  },
  setSelectedInstanceId: (selectedInstanceId) => set({ selectedInstanceId }),
  rememberInstance: (threadId, instanceId) =>
    set((s) => ({
      instanceByThread: { ...s.instanceByThread, [threadId]: instanceId },
    })),
  clearThreadState: (threadId) =>
    set((s) => {
      if (!(threadId in s.instanceByThread)) return s;
      const { [threadId]: _dropped, ...instanceByThread } = s.instanceByThread;
      void _dropped;
      return { instanceByThread };
    }),
  patchInstance: (instanceId, patch) =>
    set((s) => ({
      instances: s.instances.map((instance) =>
        instance.id === instanceId ? { ...instance, ...patch } : instance,
      ),
    })),
  setGlobalError: (globalError) => set({ globalError }),
  clearGlobalError: () => set({ globalError: null }),
  setGlobalWorkspaceRoot: (globalWorkspaceRoot) => set({ globalWorkspaceRoot }),

  loadInstances: async () => {
    await ensureProcessEventSubscription();
    try {
      const fetched = await providersInstancesList(); // [] outside Tauri
      const instances = Array.isArray(fetched) ? fetched : [];
      set((s) => ({
        instances,
        selectedInstanceId:
          s.selectedInstanceId && instances.some((i) => i.id === s.selectedInstanceId)
            ? s.selectedInstanceId
            : (instances[0]?.id ?? null),
      }));
    } catch (err) {
      console.error("providers_instances_list failed", err);
    }
  },

  applyProcessEvent: (instanceId, kind, detail) =>
    set((s) => {
      const ring = s.processEvents[instanceId] ?? [];
      const processEvents = {
        ...s.processEvents,
        [instanceId]: [...ring, { at: Date.now(), kind, detail }].slice(-30),
      };
      const status = PROCESS_KIND_TO_STATUS[kind];
      const patch: Partial<UiState> = { processEvents };
      // An agent process dying mid-session is a designed error state (§8 M7):
      // banner with a recovery path, not a silent dot.
      if (kind === "crashed") {
        const name = s.instances.find((i) => i.id === instanceId)?.displayName ?? instanceId;
        patch.globalError = {
          kind: "agent_crash",
          instanceId,
          message: `${name} — the agent process crashed mid-session. Its running turns stopped; restart the thread or pick another agent.`,
        };
      }
      if (!status || !s.instances.some((i) => i.id === instanceId)) return patch;
      return {
        ...patch,
        instances: s.instances.map((i) => (i.id === instanceId ? { ...i, status } : i)),
      };
    }),
}));
