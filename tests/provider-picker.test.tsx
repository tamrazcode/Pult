import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";
import type { InstanceInfo } from "../src/lib/types";

const { navigate, runsSetConfigOption, settingsSet, providersInstancesList } = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
  runsSetConfigOption: vi.fn(async () => undefined),
  settingsSet: vi.fn(async () => undefined),
  providersInstancesList: vi.fn(async (): Promise<InstanceInfo[]> => []),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    runsSetConfigOption,
    settingsSet,
    providersInstancesList,
    onAgentProcess: vi.fn(async () => () => {}),
  };
});

vi.mock("../src/lib/tauri", () => ({
  isTauri: () => true,
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate }),
}));

import { ProviderModelPicker } from "../src/components/chat/ComposerControls";
import { useRunsStore } from "../src/stores/runs";
import { useSettingsStore } from "../src/stores/settings";
import { useUiStore } from "../src/stores/ui";

const claudeInstance: InstanceInfo = {
  id: "claude",
  displayName: "Claude Code",
  enabled: true,
  driver: "claude",
  command: "claude",
  args: [],
  env: {},
  status: "running",
  promptImage: true,
  loadSession: true,
  modes: [],
  configOptions: [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "claude-sonnet-4",
      options: [
        { value: "claude-sonnet-4", name: "Sonnet 4" },
        { value: "claude-opus-4", name: "Opus 4" },
        { value: "claude-haiku-4", name: "Haiku 4" },
      ],
    },
  ],
  authMethods: [],
};

describe("ProviderModelPicker", () => {
  beforeEach(() => {
    navigate.mockReset().mockResolvedValue(undefined);
    runsSetConfigOption.mockReset().mockResolvedValue(undefined);
    settingsSet.mockReset().mockResolvedValue(undefined);
    providersInstancesList.mockReset().mockResolvedValue([claudeInstance]);

    useUiStore.setState({
      selectedInstanceId: "claude",
      instances: [claudeInstance],
      instanceByThread: {},
    });
    useRunsStore.setState({
      runsByThread: {},
      viewsByRun: {},
      appliedEvents: {},
      commandsByThread: {},
      queueByThread: {},
      desiredModeByThread: {},
      desiredConfigByThread: {},
      activeElicitation: null,
    });
    useSettingsStore.setState({
      favoriteModels: {},
    });
  });

  function openPicker() {
    render(<ProviderModelPicker threadId="th-1" />);
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/i }));
    return screen.getByRole("dialog", { name: "Provider, model, and reasoning" });
  }

  it("renders a search input with aria-label 'Search models' and filters model rows", () => {
    const dialog = openPicker();
    const search = within(dialog).getByLabelText("Search models");
    expect(search).toBeVisible();

    expect(within(dialog).getByRole("button", { name: "Sonnet 4" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Opus 4" })).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Haiku 4" })).toBeVisible();

    fireEvent.change(search, { target: { value: "Opus" } });

    expect(within(dialog).getByRole("button", { name: "Opus 4" })).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "Sonnet 4" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Haiku 4" })).toBeNull();
  });

  it("toggles useSettingsStore.favoriteModels when clicking 'Favorite model'", () => {
    const dialog = openPicker();
    const starButtons = within(dialog).getAllByRole("button", { name: "Favorite model" });
    expect(starButtons).toHaveLength(3);

    fireEvent.click(starButtons[1]);
    expect(useSettingsStore.getState().favoriteModels).toEqual({ claude: ["claude-opus-4"] });
    expect(settingsSet).toHaveBeenCalledWith("favorite_models", { claude: ["claude-opus-4"] });

    const unfavoriteBtn = within(dialog).getByRole("button", { name: "Unfavorite model" });
    fireEvent.click(unfavoriteBtn);
    expect(useSettingsStore.getState().favoriteModels).toEqual({ claude: [] });
  });

  it("selects the second visible model on Ctrl+2", () => {
    const dialog = openPicker();

    fireEvent.keyDown(dialog, { key: "2", ctrlKey: true });

    expect(useRunsStore.getState().desiredConfigByThread["th-1"]?.model).toBe("claude-opus-4");
    expect(runsSetConfigOption).toHaveBeenCalledWith("th-1", "model", "claude-opus-4");
  });
});
