import { useSettingsStore } from "../stores/settings";
import { useUiStore } from "../stores/ui";

/** Where a command navigates or what context it needs. */
export interface CommandCtx {
  /** SPA navigation (tanstack router). */
  navigate: (path: string) => void;
}

export interface Command {
  id: string;
  title: string;
  /** Palette grouping. */
  section: "Navigate" | "Actions" | "Threads" | "Appearance" | "Settings";
  keywords?: string;
  /** Default keyboard binding (§6.7); rebindable in Settings → Keybindings. */
  defaultBinding?: string;
  /** Short binding hint rendered in the palette. */
  binding?: string;
  run: (ctx: CommandCtx) => void;
}

/** Static commands — the same registry drives the palette and hotkeys (§6.7). */
export const STATIC_COMMANDS: Command[] = [
  {
    id: "chat.new",
    title: "New thread",
    section: "Actions",
    keywords: "create compose start",
    defaultBinding: "Mod+N",
    run: ({ navigate }) => navigate("/chat"),
  },
  {
    id: "navigate.chat",
    title: "Go to chat",
    section: "Navigate",
    keywords: "home threads",
    run: ({ navigate }) => navigate("/chat"),
  },
  {
    id: "navigate.welcome",
    title: "Go to onboarding",
    section: "Navigate",
    keywords: "setup detect agents wizard",
    run: ({ navigate }) => navigate("/welcome"),
  },
  {
    id: "view.sidebar",
    title: "Toggle sidebar",
    section: "Actions",
    keywords: "collapse rail",
    defaultBinding: "Mod+B",
    run: () => useUiStore.getState().toggleSidebar(),
  },
  {
    id: "view.panel",
    title: "Toggle right panel",
    section: "Actions",
    keywords: "diff files terminal side",
    run: () => useUiStore.getState().toggleRightPanel(),
  },
  {
    id: "view.panel.diff",
    title: "Show diff panel",
    section: "Actions",
    keywords: "changes review",
    defaultBinding: "Mod+Alt+D",
    run: () => useUiStore.getState().setRightPanelTab("diff"),
  },
  {
    id: "view.panel.terminal",
    title: "Show terminal panel",
    section: "Actions",
    keywords: "shell pty console",
    defaultBinding: "Mod+Alt+T",
    run: () => useUiStore.getState().setRightPanelTab("terminal"),
  },
  {
    id: "settings.open",
    title: "Open settings",
    section: "Settings",
    keywords: "settings preferences options",
    defaultBinding: "Mod+,",
    run: ({ navigate }) => navigate("/settings/appearance"),
  },
  {
    id: "settings.appearance",
    title: "Settings: Appearance",
    section: "Settings",
    keywords: "theme accent light dark graphite",
    run: ({ navigate }) => navigate("/settings/appearance"),
  },
  {
    id: "settings.providers",
    title: "Settings: Providers",
    section: "Settings",
    keywords: "agents instances matrix",
    run: ({ navigate }) => navigate("/settings/providers"),
  },
  {
    id: "settings.keybindings",
    title: "Settings: Keybindings",
    section: "Settings",
    keywords: "keyboard shortcuts rebind",
    run: ({ navigate }) => navigate("/settings/keybindings"),
  },
  {
    id: "settings.diagnostics",
    title: "Settings: Diagnostics",
    section: "Settings",
    keywords: "frames process log raw protocol",
    run: ({ navigate }) => navigate("/settings/diagnostics"),
  },
  {
    id: "settings.about",
    title: "Settings: About",
    section: "Settings",
    keywords: "version info",
    run: ({ navigate }) => navigate("/settings/about"),
  },
  {
    id: "theme.dark",
    title: "Theme: Dark",
    section: "Appearance",
    keywords: "switch theme dark",
    run: () => useSettingsStore.getState().setTheme("dark"),
  },
  {
    id: "theme.light",
    title: "Theme: Light",
    section: "Appearance",
    keywords: "switch theme light",
    run: () => useSettingsStore.getState().setTheme("light"),
  },
  {
    id: "theme.graphite",
    title: "Theme: Graphite",
    section: "Appearance",
    keywords: "switch theme monochrome",
    run: () => useSettingsStore.getState().setTheme("graphite"),
  },
];

/**
 * Full palette command list: static commands plus one per recent thread
 * (§6.7: threads live in the palette).
 */
export function buildCommands(
  ctx: CommandCtx,
  threads: { id: string; title: string; status: string }[],
): Command[] {
  const threadCommands: Command[] = threads.slice(0, 12).map((t) => ({
    id: `thread.open.${t.id}`,
    title: t.title || "Untitled thread",
    section: "Threads" as const,
    keywords: `open thread ${t.status}`,
    run: () => ctx.navigate(`/thread/${t.id}`),
  }));
  return [...STATIC_COMMANDS, ...threadCommands];
}
