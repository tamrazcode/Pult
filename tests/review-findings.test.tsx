import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";
import type { InstanceInfo, InstanceSpec, ProviderModelPrefs } from "../src/lib/types";

const mocks = vi.hoisted(() => {
  const mockCodeToHtml = vi.fn(
    (code: string, options?: { lang: string; theme: string }) =>
      `<pre data-lang="${options?.lang ?? ""}">${code}</pre>`,
  );
  const mockLoadLanguage = vi.fn(async () => {});
  const mockCreateHighlighter = vi.fn(async () => ({
    codeToHtml: mockCodeToHtml,
    loadLanguage: mockLoadLanguage,
  }));
  return {
    mockCodeToHtml,
    mockLoadLanguage,
    mockCreateHighlighter,
    settingsGet: vi.fn(async () => null),
    settingsSet: vi.fn(async () => undefined),
    providersModelPrefsList: vi.fn(async (): Promise<ProviderModelPrefs[]> => []),
    providersModelPrefsSet: vi.fn(async () => undefined),
    providersInstancesList: vi.fn(async (): Promise<InstanceInfo[]> => []),
    providersInstancesSave: vi.fn(async (_instances: InstanceSpec[]) => undefined),
    providersPreflight: vi.fn(),
    providersConfigStatus: vi.fn(async () => null),
    providersDetectInstalled: vi.fn(async () => []),
    runsSetConfigOption: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
  };
});

vi.mock("shiki/core", () => ({ createHighlighterCore: mocks.mockCreateHighlighter }));
vi.mock("shiki/engine/javascript", () => ({ createJavaScriptRegexEngine: vi.fn(() => ({})) }));
vi.mock("shiki/langs/ts.mjs", () => ({ default: { name: "ts" } }));
vi.mock("shiki/themes/github-dark-default.mjs", () => ({
  default: { name: "github-dark-default" },
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    settingsGet: mocks.settingsGet,
    settingsSet: mocks.settingsSet,
    providersModelPrefsList: mocks.providersModelPrefsList,
    providersModelPrefsSet: mocks.providersModelPrefsSet,
    providersInstancesList: mocks.providersInstancesList,
    providersInstancesSave: mocks.providersInstancesSave,
    providersPreflight: mocks.providersPreflight,
    providersConfigStatus: mocks.providersConfigStatus,
    providersDetectInstalled: mocks.providersDetectInstalled,
    runsSetConfigOption: mocks.runsSetConfigOption,
    onAgentProcess: vi.fn(async () => () => {}),
  };
});

vi.mock("../src/lib/tauri", () => ({ isTauri: () => true }));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/settings/providers" } }),
  useRouter: () => ({ navigate: mocks.navigate }),
}));

import { CodeBlock } from "../src/components/chat/Markdown";
import { ProviderModelPicker } from "../src/components/chat/ComposerControls";
import { Route as ProvidersRoute } from "../src/routes/settings.providers";
import { useRunsStore } from "../src/stores/runs";
import { useSettingsStore } from "../src/stores/settings";
import { useUiStore } from "../src/stores/ui";

const ProvidersSettings = ProvidersRoute.options.component!;

const claudeInstance: InstanceInfo = {
  id: "claude",
  displayName: "Claude Code",
  enabled: true,
  driver: "acp",
  command: "npx",
  args: ["-y", "@zed-industries/claude-code-acp"],
  env: {},
  secretEnv: [{ key: "ANTHROPIC_API_KEY", hasValue: true, masked: "••••1234" }],
  homePath: "C:\\Users\\me\\.claude",
  shadowHomePath: "C:\\Users\\me\\.claude-shadow",
  status: "stopped",
  promptImage: true,
  loadSession: true,
  modes: [],
  configOptions: [],
  authMethods: [],
};

const codexInstance: InstanceInfo = {
  id: "codex",
  displayName: "Codex",
  enabled: true,
  driver: "acp",
  command: "npx",
  args: ["-y", "@agentclientprotocol/codex-acp"],
  env: {},
  secretEnv: [],
  homePath: null,
  shadowHomePath: null,
  status: "running",
  promptImage: false,
  loadSession: true,
  modes: [],
  configOptions: [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "gpt-6",
      options: [
        { value: "gpt-6", name: "GPT-6" },
        { value: "gpt-5", name: "GPT-5" },
      ],
    },
  ],
  authMethods: [],
};

describe("Review regression findings (expected to fail until product fixes land)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.settingsGet.mockResolvedValue(null);
    mocks.settingsSet.mockResolvedValue(undefined);
    mocks.providersModelPrefsList.mockResolvedValue([]);
    mocks.providersModelPrefsSet.mockResolvedValue(undefined);
    mocks.providersInstancesList.mockResolvedValue([claudeInstance, codexInstance]);
    mocks.providersInstancesSave.mockResolvedValue(undefined);
    mocks.providersPreflight.mockResolvedValue({
      instanceId: "claude",
      agentName: "Claude",
      agentVersion: "1.0.0",
      loadSession: true,
      promptImage: true,
      authRequired: false,
      authHint: null,
      configOptions: [],
      authMethods: [],
    });
    vi.spyOn(useUiStore.getState(), "loadInstances").mockResolvedValue(undefined);
    useSettingsStore.setState({
      favoriteModels: {},
      disabledModels: {},
      modelOrder: {},
      modelPrefs: {},
      modelsDisabledAll: {},
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("[CRITICAL] ProvidersSettings.remove preserves homePath, shadowHomePath, and secretEnvKeys on remaining instances", async () => {
    render(<ProvidersSettings />);

    // Select Codex (second provider) and disconnect it.
    const codexButton = await screen.findByRole("button", { name: /Codex/i });
    fireEvent.click(codexButton);
    fireEvent.click(screen.getByRole("button", { name: /Disconnect/i }));

    await waitFor(() => expect(mocks.providersInstancesSave).toHaveBeenCalledTimes(1));
    const remaining = mocks.providersInstancesSave.mock.calls[0]?.[0] ?? [];
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      id: "claude",
      homePath: "C:\\Users\\me\\.claude",
      shadowHomePath: "C:\\Users\\me\\.claude-shadow",
      secretEnvKeys: ["ANTHROPIC_API_KEY"],
    });
  });

  it("[IMPORTANT] useSettingsStore.toggleModelEnabled preserves SQLite defaultModelId after hydrate when legacy favorite_models is empty", async () => {
    mocks.providersModelPrefsList.mockResolvedValue([
      {
        instanceId: "codex",
        defaultModelId: "gpt-6",
        disableAll: false,
        disabledModels: [],
        modelOrder: ["gpt-6", "gpt-5"],
        customModels: ["custom-1"],
        updatedAt: 100,
      },
    ]);

    await useSettingsStore.getState().hydrate();
    useSettingsStore.getState().toggleModelEnabled("codex", "gpt-5");

    expect(mocks.providersModelPrefsSet).toHaveBeenLastCalledWith(
      expect.objectContaining({
        instanceId: "codex",
        defaultModelId: "gpt-6",
        customModels: ["custom-1"],
        disabledModels: ["gpt-5"],
      }),
    );
  });

  it("[IMPORTANT] CodeBlock clears stale Shiki HTML when lang changes to an unsupported language", async () => {
    vi.useFakeTimers();
    const { rerender, container } = render(<CodeBlock code="const secret = 1;" lang="ts" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(container.querySelector("pre[data-lang='ts']")).not.toBeNull();

    rerender(<CodeBlock code="plain text now" lang="unknown" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(container.querySelector("pre.md-code-fallback")).not.toBeNull();
    expect(container.textContent).toContain("plain text now");
    expect(container.textContent).not.toContain("const secret = 1;");
  });

  it("[IMPORTANT] ProviderModelPicker hides all models when disableAll (modelsDisabledAll) is true", async () => {
    mocks.providersModelPrefsList.mockResolvedValue([
      {
        instanceId: "codex",
        defaultModelId: null,
        disableAll: true,
        disabledModels: [],
        modelOrder: [],
        customModels: [],
        updatedAt: 100,
      },
    ]);
    useUiStore.setState({ selectedInstanceId: "codex", instances: [codexInstance] });

    await useSettingsStore.getState().hydrate();
    render(<ProviderModelPicker threadId="th-1" />);
    fireEvent.click(screen.getByRole("button", { name: /Codex/i }));
    const dialog = screen.getByRole("dialog", { name: "Provider, model, and reasoning" });

    expect(within(dialog).queryByRole("button", { name: "GPT-6" })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "GPT-5" })).toBeNull();
  });
});
