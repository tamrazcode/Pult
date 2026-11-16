import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";
import type { PluginInfo, PluginList } from "../src/lib/ipc";

const { pluginsList, pluginsSetEnabled, openInEditor } = vi.hoisted(() => ({
  pluginsList: vi.fn(async (): Promise<PluginList> => ({ dir: "", plugins: [] })),
  pluginsSetEnabled: vi.fn(async () => undefined),
  openInEditor: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/tauri", () => ({
  isTauri: () => true,
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    pluginsList,
    pluginsSetEnabled,
    openInEditor,
  };
});

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));

import { Route as PluginsRoute } from "../src/routes/settings.plugins";

const PluginsSettings = PluginsRoute.options.component!;

const MOCK_PLUGINS: PluginInfo[] = [
  {
    id: "git-helper",
    name: "Git Helper",
    version: "1.2.0",
    description: "Adds extra git shortcuts.",
    author: "Pult",
    path: "C:\\Users\\me\\.pult\\plugins\\git-helper",
    enabled: true,
    commands: ["rebase-check"],
    slots: ["sidebar"],
  },
  {
    id: "theme-pack",
    name: "Theme Pack",
    version: "0.4.1",
    description: null,
    author: null,
    path: "C:\\Users\\me\\.pult\\plugins\\theme-pack",
    enabled: false,
    commands: [],
    slots: [],
  },
];

describe("Plugins settings", () => {
  beforeEach(() => {
    pluginsList.mockReset().mockResolvedValue({ dir: "", plugins: [] });
    pluginsSetEnabled.mockReset().mockResolvedValue(undefined);
    openInEditor.mockReset().mockResolvedValue(undefined);
  });

  it("renders empty state when no plugins are installed and disables open folder when dir is empty", async () => {
    render(<PluginsSettings />);

    expect(await screen.findByText("No plugins installed yet.")).toBeVisible();
    expect(screen.getByRole("button", { name: /open plugins folder/i })).toBeDisabled();
  });

  it("lists mocked plugins, toggles enabled state via pluginsSetEnabled, and opens folder in explorer", async () => {
    const pluginDir = "C:\\Users\\me\\.pult\\plugins";
    pluginsList.mockResolvedValue({ dir: pluginDir, plugins: MOCK_PLUGINS });

    render(<PluginsSettings />);

    expect(await screen.findByText("Git Helper")).toBeVisible();
    expect(screen.getByText("v1.2.0")).toBeVisible();
    expect(screen.getByText("Adds extra git shortcuts.")).toBeVisible();
    expect(screen.getByText("/rebase-check")).toBeVisible();
    expect(screen.getByText("sidebar")).toBeVisible();
    expect(screen.getByText("Theme Pack")).toBeVisible();

    const gitSwitch = screen.getByRole("switch", { name: "Enabled: Git Helper" });
    expect(gitSwitch).toHaveAttribute("aria-checked", "true");
    fireEvent.click(gitSwitch);
    expect(gitSwitch).toHaveAttribute("aria-checked", "false");
    expect(pluginsSetEnabled).toHaveBeenCalledWith("git-helper", false);

    const themeSwitch = screen.getByRole("switch", { name: "Enabled: Theme Pack" });
    expect(themeSwitch).toHaveAttribute("aria-checked", "false");
    fireEvent.click(themeSwitch);
    expect(themeSwitch).toHaveAttribute("aria-checked", "true");
    expect(pluginsSetEnabled).toHaveBeenCalledWith("theme-pack", true);

    const openBtn = screen.getByRole("button", { name: /open plugins folder/i });
    expect(openBtn).toBeEnabled();
    fireEvent.click(openBtn);
    await waitFor(() => expect(openInEditor).toHaveBeenCalledWith(pluginDir, "explorer"));
  });
});
