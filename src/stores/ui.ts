import { create } from "zustand";
import { onAgentProcess, providersInstancesList, settingsGet, settingsSet } from "../lib/ipc";
import { isTauri } from "../lib/tauri";
import type { InstanceInfo } from "../lib/types";

export type RightPanelTab = "diff" | "files" | "terminal";

/** Options applied to the next thread created from the empty /chat route. */
export interface NewThreadOptions {
  /** Workspace path (empty = the global workspace root). */
  workspace: string;
  /** Work in an isolated git worktree of the workspace's repo (M4). */
  worktree: boolean;
}

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
  appVersion: string | null;
  instances: InstanceInfo[];
  selectedInstanceId: string | null;
  /** ⌘K command palette visibility (§6.7) — opened from hotkeys and buttons. */
  paletteOpen: boolean;
  /** Diagnostics ring: last process events per instance (M6). */
  processEvents: Record<string, { at: number; kind: string; detail?: string | null }[]>;
  /** Latest unrecovered app-level error (§8 M7 error states). */
  globalError: GlobalError | null;
  newThreadOptions: NewThreadOptions;
  toggleSidebar: () => void;
  toggleRightPanel: () => void;
  setRightPanelTab: (tab: RightPanelTab) => void;
  setPaletteOpen: (open: boolean) => void;
  setSidebarWidth: (width: number, persist?: boolean) => void;
  setRightPanelWidth: (width: number, persist?: boolean) => void;
  setAppVersion: (version: string) => void;
  setSelectedInstanceId: (instanceId: string | null) => void;
  setGlobalError: (error: GlobalError) => void;
  clearGlobalError: () => void;
  setNewThreadOptions: (patch: Partial<NewThreadOptions>) => void;
  loadInstances: () => Promise<void>;
  applyProcessEvent: (instanceId: string, kind: string, detail?: string | null) => void;
}

let unlistenProcessEvents: (() => void) | null = null;

/** Merges one pane width into the persisted layout setting (§4.5). */
async function persistLayout(patch: { sidebarWidth?: number; rightPanelWidth?: number }) {
  try {
    const current = (await settingsGet("layout")) as Record<string, number> | null;
    await settingsSet("layout", { ...(current ?? {}), ...patch });
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

export const useUiStore = create<UiState>((set) => ({
  sidebarOpen: true,
  sidebarWidth: 288, // w-72 default (§6.1)
  rightPanelOpen: false,
  rightPanelWidth: 420, // slightly wider than the old fixed w-96
  rightPanelTab: "diff",
  appVersion: null,
  instances: [],
  selectedInstanceId: null,
  paletteOpen: false,
  processEvents: {},
  globalError: null,
  newThreadOptions: { workspace: "", worktree: false },
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  toggleRightPanel: () => set((s) => ({ rightPanelOpen: !s.rightPanelOpen })),
  setRightPanelTab: (tab) => set({ rightPanelTab: tab, rightPanelOpen: true }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setSidebarWidth: (width, persist = false) => {
    const sidebarWidth = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(width)));
    set({ sidebarWidth });
    if (persist && isTauri()) void persistLayout({ sidebarWidth });
  },
  setRightPanelWidth: (width, persist = false) => {
    const rightPanelWidth = Math.min(RIGHT_PANEL_MAX, Math.max(RIGHT_PANEL_MIN, Math.round(width)));
    set({ rightPanelWidth });
    if (persist && isTauri()) void persistLayout({ rightPanelWidth });
  },
  setAppVersion: (version) => set({ appVersion: version }),
  setSelectedInstanceId: (selectedInstanceId) => set({ selectedInstanceId }),
  setGlobalError: (globalError) => set({ globalError }),
  clearGlobalError: () => set({ globalError: null }),
  setNewThreadOptions: (patch) =>
    set((s) => ({ newThreadOptions: { ...s.newThreadOptions, ...patch } })),

  loadInstances: async () => {
    await ensureProcessEventSubscription();
    try {
      const instances = await providersInstancesList(); // [] outside Tauri
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
