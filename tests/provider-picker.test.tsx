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
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/chat" } }),
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

  it("shows only the model name in the composer trigger, without the provider prefix", () => {
    const opencode: InstanceInfo = {
      ...claudeInstance,
      id: "opencode",
      displayName: "OpenCode",
      configOptions: [
        {
          type: "select",
          id: "model",
          name: "Model",
          category: "model",
          currentValue: "opencode-go/deepseek-v4.1-flash",
          options: [
            {
              value: "opencode-go/deepseek-v4.1-flash",
              name: "opencode-go/DeepSeek V4.1 Flash 1017",
            },
          ],
        },
      ],
    };
    useUiStore.setState({ selectedInstanceId: "opencode", instances: [opencode] });
    render(<ProviderModelPicker threadId="th-1" />);

    const trigger = screen.getByRole("button", { name: "OpenCode · DeepSeek V4.1 Flash 1017" });
    expect(trigger).toBeVisible();
    expect(within(trigger).getByText("DeepSeek V4.1 Flash 1017")).toBeVisible();
    expect(screen.queryByText(/opencode-go\/DeepSeek/)).toBeNull();
  });

  it("keeps model names without a slash intact and preserves 'DisplayName · Model' aria-label", () => {
    const withReasoning: InstanceInfo = {
      ...claudeInstance,
      configOptions: [
        ...claudeInstance.configOptions,
        {
          type: "select",
          id: "thinking_level",
          name: "Thinking",
          category: "thought_level",
          currentValue: "high",
          options: [
            { value: "low", name: "Low" },
            { value: "high", name: "High" },
          ],
        },
      ],
    };
    useUiStore.setState({ selectedInstanceId: "claude", instances: [withReasoning] });
    const { unmount } = render(<ProviderModelPicker threadId="th-1" />);

    const triggerWithReasoning = screen.getByRole("button", {
      name: "Claude Code · Sonnet 4 · High",
    });
    expect(within(triggerWithReasoning).getByText("Sonnet 4")).toBeVisible();
    unmount();

    useUiStore.setState({ selectedInstanceId: "claude", instances: [claudeInstance] });
    render(<ProviderModelPicker threadId="th-1" />);
    const trigger = screen.getByRole("button", { name: "Claude Code · Sonnet 4" });
    expect(within(trigger).getByText("Sonnet 4")).toBeVisible();
  });

  it("strips only up to the first slash for model names with multiple slashes and preserves aria-label", () => {
    const opencode: InstanceInfo = {
      ...claudeInstance,
      id: "opencode",
      displayName: "OpenCode",
      configOptions: [
        {
          type: "select",
          id: "model",
          name: "Model",
          category: "model",
          currentValue: "openrouter/anthropic/claude-sonnet-4",
          options: [
            {
              value: "openrouter/anthropic/claude-sonnet-4",
              name: "openrouter/anthropic/claude-sonnet-4",
            },
          ],
        },
      ],
    };
    useUiStore.setState({ selectedInstanceId: "opencode", instances: [opencode] });
    const { unmount } = render(<ProviderModelPicker threadId="th-1" />);

    const trigger = screen.getByRole("button", {
      name: "OpenCode · anthropic/claude-sonnet-4",
    });
    expect(within(trigger).getByText("anthropic/claude-sonnet-4")).toBeVisible();
    expect(within(trigger).queryByText(/openrouter\//)).toBeNull();
    unmount();

    const fallbackOpencode: InstanceInfo = {
      ...opencode,
      configOptions: [
        {
          type: "select",
          id: "model",
          name: "Model",
          category: "model",
          currentValue: "opencode-go/unlisted-model",
          options: [],
        },
      ],
    };
    useUiStore.setState({ selectedInstanceId: "opencode", instances: [fallbackOpencode] });
    render(<ProviderModelPicker threadId="th-1" />);
    const fallbackTrigger = screen.getByRole("button", { name: "OpenCode · unlisted-model" });
    expect(within(fallbackTrigger).getByText("unlisted-model")).toBeVisible();
  });

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
