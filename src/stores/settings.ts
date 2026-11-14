import { create } from "zustand";
import { settingsGet, settingsSet } from "../lib/ipc";
import { isTauri } from "../lib/tauri";
import { applyTheme } from "../lib/theme";

export type PermissionMode = "supervised" | "auto_edit" | "auto" | "full_access";
export type ThemeName = "dark" | "light" | "graphite";

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
  /** Rebindable keyboard shortcuts (§6.7): command id → binding string. */
  keybindings: Record<string, string>;
  setTheme: (theme: ThemeName) => void;
  setAccentHue: (hue: number | null) => void;
  setPermissionMode: (mode: PermissionMode) => void;
  setKeybinding: (commandId: string, binding: string) => void;
  /** Loads persisted appearance + permission settings once at boot. */
  hydrate: () => Promise<void>;
}

const isThemeName = (v: unknown): v is ThemeName =>
  v === "dark" || v === "light" || v === "graphite";

export const useSettingsStore = create<SettingsState>((set, get) => ({
  theme: "dark",
  accentHue: null,
  permissionMode: "supervised",
  keybindings: {},
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
  setKeybinding: (commandId, binding) => {
    // A binding ending in a bare modifier ("Mod+Control") matches the
    // modifier's own keydown and hijacks the keyboard — refuse it.
    const last = binding.split("+").at(-1) ?? "";
    if (["Control", "Shift", "Alt", "Meta"].includes(last)) return;
    const keybindings = { ...get().keybindings, [commandId]: binding };
    set({ keybindings });
    if (isTauri()) void settingsSet("keybindings", keybindings).catch(() => {});
  },
  hydrate: async () => {
    if (!isTauri()) return;
    const [theme, accentHue, permissionMode, keybindings] = await Promise.all([
      settingsGet("theme").catch(() => null),
      settingsGet("accent_hue").catch(() => null),
      settingsGet("permission_mode").catch(() => null),
      settingsGet("keybindings").catch(() => null),
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
      keybindings:
        keybindings && typeof keybindings === "object"
          ? (keybindings as Record<string, string>)
          : {},
    });
    applyTheme(resolvedTheme, resolvedHue);
  },
}));
