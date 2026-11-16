import { create } from "zustand";
import { isEditorId, type EditorId } from "../lib/editors";
import { settingsGet, settingsSet } from "../lib/ipc";
import { isTauri } from "../lib/tauri";
import { applyLocale } from "../lib/i18n/store";
import type { LocaleId } from "../lib/i18n/types";
import { isLocaleId } from "../lib/i18n/types";
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

/** What each mode actually allows; shown next to the mode picker. */
export const PERMISSION_MODE_DESCRIPTIONS: Record<PermissionMode, string> = {
  supervised: "Asks before every tool action.",
  auto_edit: "Files inside the workspace are edited without asking; deletes and outside paths ask.",
  auto: "Reads and non-destructive tools run; deletes and outside paths ask.",
  full_access: "Never asks. The agent still runs as you, with your file and network access.",
};

export interface LocalProfileAvatar {
  kind: "initials" | "image";
  /** Data URL for an uploaded avatar; empty for initials. */
  value: string;
  /** Accent hue (0–360) for the initials avatar ring. */
  hue: number;
}

export interface LocalProfile {
  version: 1;
  nickname: string;
  handle: string;
  avatar: LocalProfileAvatar;
}

interface SettingsState {
  theme: ThemeName;
  accentHue: number | null;
  permissionMode: PermissionMode;
  /** Local-only identity used by the profile card and notifications. */
  profile: LocalProfile | null;
  setProfile: (profile: LocalProfile | null) => void;
  /** UI language; English is the default and the fallback catalog. */
  language: LocaleId;
  setLanguage: (language: LocaleId) => void;
  /** Ask before deleting a thread (on by default). */
  confirmDeleteThread: boolean;
  /** Enter sends or inserts a newline; Mod+Enter always sends. */
  sendKey: "enter" | "mod-enter";
  /** Show message hover timestamps. */
  showTimestamps: boolean;
  /** Native notifications when a run finishes while Pult is in the background. */
  notificationsEnabled: boolean;
  /** Play a soft chime with those notifications. */
  notificationSound: boolean;
  /** Keep the transcript pinned to streaming output. */
  followStreaming: boolean;
  /** Composer glass tint opacity (0–100). */
  glassOpacity: number;
  /** Default diff presentation (persisted; also seeds the git store). */
  diffViewMode: "unified" | "split";
  /** Editor used by Files/Project card "Open in editor". */
  preferredEditor: EditorId;
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
  setNotificationsEnabled: (value: boolean) => void;
  setNotificationSound: (value: boolean) => void;
  setFollowStreaming: (value: boolean) => void;
  setGlassOpacity: (value: number) => void;
  setDiffViewMode: (mode: "unified" | "split") => void;
  setPreferredEditor: (editor: EditorId) => void;
  setKeybinding: (commandId: string, binding: string) => void;
  toggleFavoriteModel: (instanceId: string, modelId: string) => void;
  /** Loads persisted appearance + permission settings once at boot. */
  hydrate: () => Promise<void>;
}

const isThemeName = (v: unknown): v is ThemeName =>
  v === "dark" || v === "light" || v === "graphite" || v === "liquid";

/** Lowercase handle without the leading @; 2–24 letters, digits or underscores. */
export function isValidHandle(value: string): boolean {
  return /^[a-z0-9_]{2,24}$/.test(value);
}

export function sanitizeProfile(value: unknown): LocalProfile | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const nickname = typeof record.nickname === "string" ? record.nickname.trim().slice(0, 40) : "";
  const handle =
    typeof record.handle === "string"
      ? record.handle.replace(/^@/, "").toLowerCase().slice(0, 24)
      : "";
  if (!nickname || !isValidHandle(handle)) return null;
  const avatar =
    record.avatar && typeof record.avatar === "object"
      ? (record.avatar as Record<string, unknown>)
      : {};
  const rawValue = typeof avatar.value === "string" ? avatar.value : "";
  const image = rawValue.startsWith("data:image/") && rawValue.length < 2_500_000;
  const hue =
    typeof avatar.hue === "number" && Number.isFinite(avatar.hue) ? avatar.hue % 360 : 215;
  return {
    version: 1,
    nickname,
    handle,
    avatar: {
      kind: image ? "image" : "initials",
      value: image ? rawValue : "",
      hue: Math.max(0, hue),
    },
  };
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  theme: "dark",
  accentHue: null,
  permissionMode: "supervised",
  profile: null,
  language: "en",
  confirmDeleteThread: true,
  sendKey: "enter",
  showTimestamps: true,
  notificationsEnabled: true,
  notificationSound: true,
  followStreaming: true,
  glassOpacity: 100,
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
  setProfile: (profile) => {
    set({ profile });
    if (isTauri()) void settingsSet("profile", profile).catch(() => {});
  },
  setLanguage: (language) => {
    set({ language });
    applyLocale(language);
    if (isTauri()) void settingsSet("language", language).catch(() => {});
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
  setNotificationsEnabled: (notificationsEnabled) => {
    set({ notificationsEnabled });
    if (isTauri()) {
      void settingsSet("notifications_enabled", notificationsEnabled).catch(() => {});
    }
  },
  setNotificationSound: (notificationSound) => {
    set({ notificationSound });
    if (isTauri()) void settingsSet("notification_sound", notificationSound).catch(() => {});
  },
  setFollowStreaming: (followStreaming) => {
    set({ followStreaming });
    if (isTauri()) void settingsSet("follow_streaming", followStreaming).catch(() => {});
  },
  setGlassOpacity: (value) => {
    const glassOpacity = Math.min(100, Math.max(0, Math.round(value)));
    set({ glassOpacity });
    if (isTauri()) void settingsSet("glass_opacity", glassOpacity).catch(() => {});
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
      notificationsEnabled,
      notificationSound,
      followStreaming,
      diffViewMode,
      preferredEditor,
      glassOpacity,
      language,
      profile,
    ] = await Promise.all([
      settingsGet("theme").catch(() => null),
      settingsGet("accent_hue").catch(() => null),
      settingsGet("permission_mode").catch(() => null),
      settingsGet("keybindings").catch(() => null),
      settingsGet("favorite_models").catch(() => null),
      settingsGet("confirm_delete_thread").catch(() => null),
      settingsGet("send_key").catch(() => null),
      settingsGet("show_timestamps").catch(() => null),
      settingsGet("notifications_enabled").catch(() => null),
      settingsGet("notification_sound").catch(() => null),
      settingsGet("follow_streaming").catch(() => null),
      settingsGet("diff_view_mode").catch(() => null),
      settingsGet("preferred_editor").catch(() => null),
      settingsGet("glass_opacity").catch(() => null),
      settingsGet("language").catch(() => null),
      settingsGet("profile").catch(() => null),
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
    const resolvedLanguage: LocaleId = isLocaleId(language) ? language : "en";
    const resolvedProfile = sanitizeProfile(profile);
    applyLocale(resolvedLanguage);
    set({
      theme: resolvedTheme,
      accentHue: resolvedHue,
      permissionMode: resolvedMode,
      language: resolvedLanguage,
      profile: resolvedProfile,
      confirmDeleteThread: confirmDelete !== false,
      sendKey: sendKey === "mod-enter" ? "mod-enter" : "enter",
      showTimestamps: showTimestamps !== false,
      notificationsEnabled: notificationsEnabled !== false,
      notificationSound: notificationSound !== false,
      followStreaming: followStreaming !== false,
      diffViewMode: diffViewMode === "split" ? "split" : "unified",
      preferredEditor: isEditorId(preferredEditor) ? preferredEditor : "zed",
      glassOpacity:
        typeof glassOpacity === "number" ? Math.min(100, Math.max(0, glassOpacity)) : 100,
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
