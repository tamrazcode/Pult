import { useSettingsStore } from "../stores/settings";
import { useProjectsStore } from "../stores/projects";
import { useUiStore } from "../stores/ui";
import { translate } from "./i18n";

/** Where a command navigates or what context it needs. */
export interface CommandCtx {
  /** SPA navigation (tanstack router). */
  navigate: (path: string) => void;
}

export type CommandSection = "actions" | "navigate" | "threads" | "appearance" | "settings";

/** Palette group labels, in display order. */
export const COMMAND_SECTION_KEYS: Record<CommandSection, string> = {
  actions: "common.commands.sections.actions",
  navigate: "common.commands.sections.navigate",
  threads: "common.commands.sections.threads",
  appearance: "common.commands.sections.appearance",
  settings: "common.commands.sections.settings",
};

export interface Command {
  id: string;
  /** Resolved title (thread titles); static commands use `titleKey`. */
  title?: string;
  /** Translation key resolved by the palette at render time. */
  titleKey?: string;
  /** Palette grouping. */
  section: CommandSection;
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
    titleKey: "common.commands.newThread",
    section: "actions",
    keywords: "create compose start",
    defaultBinding: "Mod+N",
    run: ({ navigate }) => {
      useProjectsStore.getState().selectProject(null);
      navigate("/chat");
    },
  },
  {
    id: "navigate.chat",
    titleKey: "common.commands.goToChat",
    section: "navigate",
    keywords: "home threads",
    run: ({ navigate }) => {
      useProjectsStore.getState().selectProject(null);
      navigate("/chat");
    },
  },
  {
    id: "navigate.usage",
    titleKey: "common.commands.goToUsage",
    section: "navigate",
    keywords: "usage tokens context cost stats",
    run: ({ navigate }) => navigate("/usage"),
  },
  {
    id: "navigate.welcome",
    titleKey: "common.commands.goToOnboarding",
    section: "navigate",
    keywords: "setup detect agents wizard",
    run: ({ navigate }) => navigate("/welcome"),
  },
  {
    id: "view.sidebar",
    titleKey: "common.commands.toggleSidebar",
    section: "actions",
    keywords: "collapse rail",
    defaultBinding: "Mod+B",
    run: () => useUiStore.getState().toggleSidebar(),
  },
  {
    id: "view.panel",
    titleKey: "common.commands.toggleRightPanel",
    section: "actions",
    keywords: "diff files terminal side",
    run: () => useUiStore.getState().toggleRightPanel(),
  },
  {
    id: "view.panel.diff",
    titleKey: "common.commands.showDiffPanel",
    section: "actions",
    keywords: "changes review",
    defaultBinding: "Mod+Alt+D",
    run: () => useUiStore.getState().setRightPanelTab("diff"),
  },
  {
    id: "view.panel.terminal",
    titleKey: "common.commands.showTerminalPanel",
    section: "actions",
    keywords: "shell pty console",
    defaultBinding: "Mod+Alt+T",
    run: () => useUiStore.getState().setRightPanelTab("terminal"),
  },
  {
    id: "view.panel.browser",
    titleKey: "common.commands.showBrowserPanel",
    section: "actions",
    keywords: "preview html web url",
    defaultBinding: "Mod+Alt+B",
    run: () => useUiStore.getState().setRightPanelTab("browser"),
  },
  {
    id: "view.panel.files",
    titleKey: "common.commands.showFilesPanel",
    section: "actions",
    keywords: "explorer workspace tree",
    defaultBinding: "Mod+Alt+F",
    run: () => useUiStore.getState().setRightPanelTab("files"),
  },
  {
    id: "view.panel.surfaces",
    titleKey: "common.commands.openSurface",
    section: "actions",
    keywords: "panel picker browser files diff terminal",
    run: () => useUiStore.setState({ rightPanelTab: "none", rightPanelOpen: true }),
  },
  {
    id: "view.bottomTerminal",
    titleKey: "common.commands.toggleBottomTerminal",
    section: "actions",
    keywords: "terminal shell console drawer bottom",
    defaultBinding: "Mod+`",
    run: () => useUiStore.getState().toggleBottomTerminal(),
  },
  {
    id: "settings.open",
    titleKey: "common.commands.openSettings",
    section: "settings",
    keywords: "settings preferences options",
    defaultBinding: "Mod+,",
    run: ({ navigate }) => navigate("/settings/appearance"),
  },
  {
    id: "settings.appearance",
    titleKey: "common.commands.settingsAppearance",
    section: "settings",
    keywords: "theme accent light dark graphite",
    run: ({ navigate }) => navigate("/settings/appearance"),
  },
  {
    id: "settings.providers",
    titleKey: "common.commands.settingsProviders",
    section: "settings",
    keywords: "agents instances matrix",
    run: ({ navigate }) => navigate("/settings/providers"),
  },
  {
    id: "settings.keybindings",
    titleKey: "common.commands.settingsKeybindings",
    section: "settings",
    keywords: "keyboard shortcuts rebind",
    run: ({ navigate }) => navigate("/settings/keybindings"),
  },
  {
    id: "settings.diagnostics",
    titleKey: "common.commands.settingsDiagnostics",
    section: "settings",
    keywords: "frames process log raw protocol",
    run: ({ navigate }) => navigate("/settings/diagnostics"),
  },
  {
    id: "settings.about",
    titleKey: "common.commands.settingsAbout",
    section: "settings",
    keywords: "version info",
    run: ({ navigate }) => navigate("/settings/about"),
  },
  {
    id: "theme.dark",
    titleKey: "common.commands.themeDark",
    section: "appearance",
    keywords: "switch theme dark",
    run: () => useSettingsStore.getState().setTheme("dark"),
  },
  {
    id: "theme.light",
    titleKey: "common.commands.themeLight",
    section: "appearance",
    keywords: "switch theme light",
    run: () => useSettingsStore.getState().setTheme("light"),
  },
  {
    id: "theme.graphite",
    titleKey: "common.commands.themeGraphite",
    section: "appearance",
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
    title: t.title || translate("common.commands.untitledThread"),
    section: "threads",
    keywords: `open thread ${t.status}`,
    run: () => ctx.navigate(`/thread/${t.id}`),
  }));
  return [...STATIC_COMMANDS, ...threadCommands];
}
