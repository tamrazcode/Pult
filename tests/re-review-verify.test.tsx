import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";
import type { InstanceInfo, InstanceSpec, ProviderModelPrefs } from "../src/lib/types";

const mocks = vi.hoisted(() => ({
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
  env: { CLAUDE_ENV: "alpha" },
  secretEnv: [{ key: "ANTHROPIC_API_KEY", hasValue: true, masked: "••••1234" }],
  homePath: null,
  shadowHomePath: null,
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
  env: { CODEX_ENV: "beta" },
  secretEnv: [{ key: "OPENAI_API_KEY", hasValue: true, masked: "••••9999" }],
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
        {
          group: "flagship",
          name: "Flagship",
          options: [
            { value: "gpt-6", name: "GPT-6" },
            { value: "gpt-5", name: "GPT-5" },
          ],
        },
      ],
    },
  ],
  authMethods: [],
};

describe("86ef050 verification", () => {
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

  it("switching providers resets envDraft and apiKeyDraft while preflight refresh preserves unsaved edits", async () => {
    const resolvers: Array<(val: unknown) => void> = [];
    mocks.providersPreflight.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    render(<ProvidersSettings />);
    await screen.findByDisplayValue("CLAUDE_ENV");
    const apiKeyInput = screen.getAllByPlaceholderText("••••1234")[0] as HTMLInputElement;

    fireEvent.change(apiKeyInput, { target: { value: "sk-ant-unsaved" } });
    fireEvent.click(screen.getByRole("button", { name: /Add variable/i }));
    const keyInputs = screen.getAllByPlaceholderText("KEY") as HTMLInputElement[];
    fireEvent.change(keyInputs[keyInputs.length - 1]!, { target: { value: "UNSAVED_ENV" } });

    // Wait for both preflight calls (claude + codex) to start, then resolve them.
    await waitFor(() => expect(resolvers).toHaveLength(2));
    await act(async () => {
      for (const resolve of resolvers) {
        resolve({
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
      }
    });
    await waitFor(() => expect(mocks.providersInstancesList).toHaveBeenCalledTimes(2));
    expect(apiKeyInput.value).toBe("sk-ant-unsaved");
    expect(screen.getByDisplayValue("UNSAVED_ENV")).toBeInTheDocument();

    // Switch to Codex -> envDraft resets to Codex's env, unsaved Claude edits are cleared.
    fireEvent.click(screen.getByRole("button", { name: /Codex/i }));
    expect(screen.queryByDisplayValue("UNSAVED_ENV")).toBeNull();
    expect(screen.queryByDisplayValue("CLAUDE_ENV")).toBeNull();
    expect(screen.getByDisplayValue("CODEX_ENV")).toBeInTheDocument();

    // Switch back to Claude -> apiKeyDraft was reset to empty.
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/i }));
    await screen.findByDisplayValue("CLAUDE_ENV");
    expect((screen.getAllByPlaceholderText("••••1234")[0] as HTMLInputElement).value).toBe("");
  });

  it("toggleModelEnabled with grouped options disables all other advertised models and agrees with picker", async () => {
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

    const { unmount } = render(<ProvidersSettings />);
    fireEvent.click(await screen.findByRole("button", { name: /Codex/i }));

    // Before toggling: both switches reflect off under disableAll=true.
    expect(screen.getByRole("switch", { name: "Enable GPT-6" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    expect(screen.getByRole("switch", { name: "Enable GPT-5" })).toHaveAttribute(
      "aria-checked",
      "false",
    );

    fireEvent.click(screen.getByRole("switch", { name: "Enable GPT-6" }));

    expect(useSettingsStore.getState().modelsDisabledAll["codex"]).toBe(false);
    expect(useSettingsStore.getState().disabledModels["codex"]).toEqual(["gpt-5"]);
    expect(screen.getByRole("switch", { name: "Disable GPT-6" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("switch", { name: "Enable GPT-5" })).toHaveAttribute(
      "aria-checked",
      "false",
    );

    unmount();
    render(<ProviderModelPicker threadId="th-1" />);
    fireEvent.click(screen.getByRole("button", { name: /Codex/i }));
    const dialog = screen.getByRole("dialog", { name: "Provider, model, and reasoning" });
    expect(within(dialog).getByRole("button", { name: "GPT-6" })).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "GPT-5" })).toBeNull();
  });
});
