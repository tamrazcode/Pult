import { create } from "zustand";
import { settingsGet, settingsSet } from "../lib/ipc";
import { isTauri } from "../lib/tauri";
import { applyTheme } from "../lib/theme";
import { useGitStore } from "./git";

export type PermissionMode = "supervised" | "auto_edit" | "auto" | "full_access";
export type ThemeName = "dark" | "light" | "graphite" | "liquid";

/** Human-readable labels for permission modes (raw enum ids are not user-facing copy). */
export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  supervised: "Supervised",
  auto_edit: "Auto edit",
  auto: "Auto",
  full_access: "Full access",
};

interface SettingsState {
  theme: ThemeName;
  accentHue: number | null;
  permissionMode: PermissionMode;
  /** Ask before deleting a thread (on by default). */
  confirmDeleteThread: boolean;
  /** Enter sends or inserts a newline; Mod+Enter always sends. */
  sendKey: "enter" | "mod-enter";
  /** Show message hover timestamps. */
  showTimestamps: boolean;
  /** Keep the transcript pinned to streaming output. */
  followStreaming: boolean;
  /** Default diff presentation (persisted; also seeds the git store). */
  diffViewMode: "unified" | "split";
  /** Editor used by Files/Project card "Open in editor". */
  preferredEditor: "zed" | "vscode" | "antigravity" | "explorer";
  /** Rebindable keyboard shortcuts (§6.7): command id → binding string. */
  keybindings: Record<string, string>;
  /** Starred model ids per provider instance (composer picker). */
  favoriteModels: Record<string, string[]>;
  setTheme: (theme: ThemeName) => void;
  setAccentHue: (hue: number | null) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  setConfirmDeleteThread: (value: boolean) => void;
  setSendKey: (value: "enter" | "mod-enter") => void;
  setShowTimestamps: (value: boolean) => void;
  setFollowStreaming: (value: boolean) => void;
  setDiffViewMode: (mode: "unified" | "split") => void;
  setPreferredEditor: (editor: "zed" | "vscode" | "antigravity" | "explorer") => void;
  setKeybinding: (commandId: string, binding: string) => void;
  toggleFavoriteModel: (instanceId: string, modelId: string) => void;
  /** Loads persisted appearance + permission settings once at boot. */
  hydrate: () => Promise<void>;
}

const isThemeName = (v: unknown): v is ThemeName =>
  v === "dark" || v === "light" || v === "graphite" || v === "liquid";

export const useSettingsStore = create<SettingsState>((set, get) => ({
  theme: "dark",
  accentHue: null,
  permissionMode: "supervised",
  confirmDeleteThread: true,
  sendKey: "enter",
  showTimestamps: true,
  followStreaming: true,
  diffViewMode: "unified",
  preferredEditor: "zed",
  keybindings: {},
  favoriteModels: {},
  setTheme: (theme) => {
    set({ theme });
    applyTheme(theme, get().accentHue);
    if (isTauri()) void settingsSet("theme", theme).catch(() => {});
  },
  setAccentHue: (hue) => {
    set({ accentHue: hue });
    applyTheme(get().theme, hue);
    if (isTauri()) void settingsSet("accent_hue", hue).catch(() => {});
  },
  setPermissionMode: (permissionMode) => {
    set({ permissionMode });
    if (isTauri()) void settingsSet("permission_mode", permissionMode).catch(() => {});
  },
  setConfirmDeleteThread: (confirmDeleteThread) => {
    set({ confirmDeleteThread });
    if (isTauri()) void settingsSet("confirm_delete_thread", confirmDeleteThread).catch(() => {});
  },
  setSendKey: (sendKey) => {
    set({ sendKey });
    if (isTauri()) void settingsSet("send_key", sendKey).catch(() => {});
  },
  setShowTimestamps: (showTimestamps) => {
    set({ showTimestamps });
    if (isTauri()) void settingsSet("show_timestamps", showTimestamps).catch(() => {});
  },
  setFollowStreaming: (followStreaming) => {
    set({ followStreaming });
    if (isTauri()) void settingsSet("follow_streaming", followStreaming).catch(() => {});
  },
  setDiffViewMode: (diffViewMode) => {
    set({ diffViewMode });
    useGitStore.setState({ viewMode: diffViewMode });
    if (isTauri()) void settingsSet("diff_view_mode", diffViewMode).catch(() => {});
  },
  setPreferredEditor: (preferredEditor) => {
    set({ preferredEditor });
    if (isTauri()) void settingsSet("preferred_editor", preferredEditor).catch(() => {});
  },
  setKeybinding: (commandId, binding) => {
    // A binding ending in a bare modifier ("Mod+Control") matches the
    // modifier's own keydown and hijacks the keyboard — refuse it.
    const last = binding.split("+").at(-1) ?? "";
    if (["Control", "Shift", "Alt", "Meta"].includes(last)) return;
    const keybindings = { ...get().keybindings, [commandId]: binding };
    set({ keybindings });
    if (isTauri()) void settingsSet("keybindings", keybindings).catch(() => {});
  },
  toggleFavoriteModel: (instanceId, modelId) => {
    const current = get().favoriteModels[instanceId] ?? [];
    const next = current.includes(modelId)
      ? current.filter((id) => id !== modelId)
      : [...current, modelId];
    const favoriteModels = { ...get().favoriteModels, [instanceId]: next };
    set({ favoriteModels });
    if (isTauri()) void settingsSet("favorite_models", favoriteModels).catch(() => {});
  },
  hydrate: async () => {
    if (!isTauri()) return;
    const [
      theme,
      accentHue,
      permissionMode,
      keybindings,
      favoriteModels,
      confirmDelete,
      sendKey,
      showTimestamps,
      followStreaming,
      diffViewMode,
      preferredEditor,
    ] = await Promise.all([
      settingsGet("theme").catch(() => null),
      settingsGet("accent_hue").catch(() => null),
      settingsGet("permission_mode").catch(() => null),
      settingsGet("keybindings").catch(() => null),
      settingsGet("favorite_models").catch(() => null),
      settingsGet("confirm_delete_thread").catch(() => null),
      settingsGet("send_key").catch(() => null),
      settingsGet("show_timestamps").catch(() => null),
      settingsGet("follow_streaming").catch(() => null),
      settingsGet("diff_view_mode").catch(() => null),
      settingsGet("preferred_editor").catch(() => null),
    ]);
    const resolvedTheme = isThemeName(theme) ? theme : "dark";
    const resolvedHue =
      typeof accentHue === "number" && accentHue >= 0 && accentHue < 360 ? accentHue : null;
    const resolvedMode =
      permissionMode === "supervised" ||
      permissionMode === "auto_edit" ||
      permissionMode === "auto" ||
      permissionMode === "full_access"
        ? permissionMode
        : "supervised";
    set({
      theme: resolvedTheme,
      accentHue: resolvedHue,
      permissionMode: resolvedMode,
      confirmDeleteThread: confirmDelete !== false,
      sendKey: sendKey === "mod-enter" ? "mod-enter" : "enter",
      showTimestamps: showTimestamps !== false,
      followStreaming: followStreaming !== false,
      diffViewMode: diffViewMode === "split" ? "split" : "unified",
      preferredEditor:
        preferredEditor === "vscode" ||
        preferredEditor === "antigravity" ||
        preferredEditor === "explorer"
          ? preferredEditor
          : "zed",
      keybindings:
        keybindings && typeof keybindings === "object"
          ? (keybindings as Record<string, string>)
          : {},
      favoriteModels:
        favoriteModels && typeof favoriteModels === "object"
          ? (favoriteModels as Record<string, string[]>)
          : {},
    });
    applyTheme(resolvedTheme, resolvedHue);
    useGitStore.setState({ viewMode: diffViewMode === "split" ? "split" : "unified" });
  },
}));
