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
  env: { CUSTOM_VAR: "keep-me" },
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
  secretEnv: [{ key: "OPENAI_API_KEY", hasValue: true, masked: "••••9999" }],
  homePath: "C:\\Users\\me\\.codex",
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

describe("Re-review verification and new findings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.settingsGet.mockResolvedValue(null);
    mocks.settingsSet.mockResolvedValue(undefined);
    mocks.providersModelPrefsList.mockResolvedValue([]);
    mocks.providersModelPrefsSet.mockResolvedValue(undefined);
    mocks.providersInstancesList.mockImplementation(async () => [
      structuredClone(claudeInstance),
      structuredClone(codexInstance),
    ]);
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

  it("home-path editor shows initial values, supports Cancel, trims to null, and preserves env/secretEnvKeys/other instances", async () => {
    render(<ProvidersSettings />);

    const homeInput = (await screen.findByLabelText("Home path")) as HTMLInputElement;
    const shadowInput = screen.getByLabelText("Shadow home path") as HTMLInputElement;
    expect(homeInput.value).toBe("C:\\Users\\me\\.claude");
    expect(shadowInput.value).toBe("C:\\Users\\me\\.claude-shadow");

    // Edit then Cancel restores original values.
    fireEvent.change(homeInput, { target: { value: "C:\\temp\\edit" } });
    expect(homeInput.value).toBe("C:\\temp\\edit");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(homeInput.value).toBe("C:\\Users\\me\\.claude");

    // Edit with surrounding whitespace and clear shadow to whitespace-only -> trims / null.
    fireEvent.change(homeInput, { target: { value: "  C:\\new\\claude  " } });
    fireEvent.change(shadowInput, { target: { value: "   " } });
    // Home-path Save appears right after Cancel inside the home-path editor.
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    fireEvent.click(within(cancelBtn.parentElement!).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(mocks.providersInstancesSave).toHaveBeenCalledTimes(1));
    const saved = mocks.providersInstancesSave.mock.calls[0]?.[0] ?? [];
    expect(saved[0]).toMatchObject({
      id: "claude",
      homePath: "C:\\new\\claude",
      shadowHomePath: null,
      env: { CUSTOM_VAR: "keep-me" },
      secretEnvKeys: ["ANTHROPIC_API_KEY"],
    });
    expect(saved[1]).toMatchObject({
      id: "codex",
      homePath: "C:\\Users\\me\\.codex",
      shadowHomePath: null,
      secretEnvKeys: ["OPENAI_API_KEY"],
    });
  });

  it("unrelated enabled toggle preserves homePath, shadowHomePath, and secretEnvKeys", async () => {
    render(<ProvidersSettings />);
    const toggleBtn = await screen.findByRole("switch", { name: /Disable Claude Code/i });
    fireEvent.click(toggleBtn);

    await waitFor(() => expect(mocks.providersInstancesSave).toHaveBeenCalledTimes(1));
    const saved = mocks.providersInstancesSave.mock.calls[0]?.[0] ?? [];
    expect(saved[0]).toMatchObject({
      id: "claude",
      enabled: false,
      homePath: "C:\\Users\\me\\.claude",
      shadowHomePath: "C:\\Users\\me\\.claude-shadow",
      secretEnvKeys: ["ANTHROPIC_API_KEY"],
    });
  });

  it("CodeBlock recovers highlight when switching supported -> unsupported -> same supported, and retries after highlight failure", async () => {
    vi.useFakeTimers();
    const { rerender, container } = render(<CodeBlock code="const x = 1;" lang="ts" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(container.querySelector("pre[data-lang='ts']")).not.toBeNull();

    // Switch to unsupported
    rerender(<CodeBlock code="const x = 1;" lang="unknown" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(container.querySelector("pre.md-code-fallback")).not.toBeNull();

    // Switch back to same supported code+lang
    rerender(<CodeBlock code="const x = 1;" lang="ts" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(container.querySelector("pre[data-lang='ts']")).not.toBeNull();

    // Fail once, then retry on next code change
    mocks.mockCodeToHtml.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    rerender(<CodeBlock code="const y = 2;" lang="ts" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(container.querySelector("pre.md-code-fallback")).not.toBeNull();

    rerender(<CodeBlock code="const z = 3;" lang="ts" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(container.querySelector("pre[data-lang='ts']")).not.toBeNull();
  });

  it("[NEW IMPORTANT] ProvidersSettings resets unsaved envDraft and apiKeyDraft when background preflight reloads instances (effect depends on [selected])", async () => {
    mocks.providersInstancesList.mockImplementation(async () => [structuredClone(claudeInstance)]);
    let resolvePreflight!: (val: unknown) => void;
    mocks.providersPreflight.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePreflight = resolve;
        }),
    );

    render(<ProvidersSettings />);
    const apiKeyInput = (await screen.findByPlaceholderText("••••1234")) as HTMLInputElement;
    const envVarInput = screen.getByDisplayValue("CUSTOM_VAR") as HTMLInputElement;
    expect(envVarInput).toBeInTheDocument();

    // User types a new API key and edits envDraft before initial preflight finishes.
    fireEvent.change(apiKeyInput, { target: { value: "sk-ant-unsaved-draft" } });
    fireEvent.click(screen.getByRole("button", { name: /Add variable/i }));
    const keyInputs = screen.getAllByPlaceholderText("KEY") as HTMLInputElement[];
    fireEvent.change(keyInputs[keyInputs.length - 1]!, { target: { value: "NEW_VAR" } });
    expect(apiKeyInput.value).toBe("sk-ant-unsaved-draft");

    // Background preflight finishes and calls providersInstancesList -> setInstances(refreshed).
    await act(async () => {
      resolvePreflight({
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
    });

    await waitFor(() => expect(mocks.providersInstancesList).toHaveBeenCalledTimes(2));

    // Unsaved edits should NOT be wiped out by a background refresh of the same selected instance.
    expect(apiKeyInput.value).toBe("sk-ant-unsaved-draft");
    expect(screen.queryAllByDisplayValue("NEW_VAR")).toHaveLength(1);
  });

  it("[NEW IMPORTANT] toggleModelEnabled when disableAll=true and disabledModels=[] unexpectedly enables all other models", async () => {
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

    // User re-enables ONLY gpt-6 when all models are disabled via disableAll=true.
    useSettingsStore.getState().toggleModelEnabled("codex", "gpt-6");

    render(<ProviderModelPicker threadId="th-1" />);
    fireEvent.click(screen.getByRole("button", { name: /Codex/i }));
    const dialog = screen.getByRole("dialog", { name: "Provider, model, and reasoning" });

    expect(within(dialog).getByRole("button", { name: "GPT-6" })).toBeVisible();
    // GPT-5 was disabled under disableAll=true and should remain hidden!
    expect(within(dialog).queryByRole("button", { name: "GPT-5" })).toBeNull();
  });
});
