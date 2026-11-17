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
  providersInstall: vi.fn(async () => undefined),
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
    providersInstall: mocks.providersInstall,
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

import { Route as ProvidersRoute } from "../src/routes/settings.providers";
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
  env: { CODEX_VAR: "codex-val" },
  secretEnv: [],
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

const realLoadInstances = useUiStore.getState().loadInstances;

describe("Verify 86ef050 fixes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.providersInstancesList.mockImplementation(async () => [
      structuredClone(claudeInstance),
      structuredClone(codexInstance),
    ]);
    mocks.providersInstancesSave.mockResolvedValue(undefined);
    mocks.providersPreflight.mockImplementation(async (id: string) => ({
      instanceId: id,
      agentName: id,
      agentVersion: "1.0.0",
      loadSession: true,
      promptImage: true,
      authRequired: false,
      authHint: null,
      configOptions: [],
      authMethods: [],
    }));
    useUiStore.setState({
      instances: [],
      selectedInstanceId: null,
      loadInstances: realLoadInstances,
    });
    useSettingsStore.setState({
      favoriteModels: {},
      disabledModels: {},
      modelOrder: {},
      modelPrefs: {},
      modelsDisabledAll: {},
    });
  });

  it("switching providers resets envDraft and apiKeyDraft; background preflight keeps unsaved edits once envDraft mounts", async () => {
    vi.spyOn(useUiStore.getState(), "loadInstances").mockResolvedValue(undefined);
    const resolvers: Array<(val: unknown) => void> = [];
    mocks.providersPreflight.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );

    render(<ProvidersSettings />);
    // Wait for useEffect([selectedId]) to populate envDraft before querying inputs
    await screen.findByDisplayValue("CUSTOM_VAR");
    const claudeAccount = screen.getByText("Claude account").parentElement!;
    const apiKeyInput = within(claudeAccount).getByPlaceholderText("••••1234") as HTMLInputElement;

    fireEvent.change(apiKeyInput, { target: { value: "sk-ant-unsaved-draft" } });
    fireEvent.click(screen.getByRole("button", { name: /Add variable/i }));
    const keyInputs = screen.getAllByPlaceholderText("KEY") as HTMLInputElement[];
    fireEvent.change(keyInputs[keyInputs.length - 1]!, { target: { value: "NEW_VAR" } });

    // Background preflight reload preserves unsaved drafts
    await waitFor(() => expect(resolvers.length).toBe(2));
    await act(async () => {
      resolvers[0]!({
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
      resolvers[1]!({
        instanceId: "codex",
        agentName: "Codex",
        agentVersion: "1.0.0",
        loadSession: true,
        promptImage: false,
        authRequired: false,
        authHint: null,
        configOptions: [],
        authMethods: [],
      });
    });
    await waitFor(() => expect(mocks.providersInstancesList).toHaveBeenCalledTimes(2));
    expect(apiKeyInput.value).toBe("sk-ant-unsaved-draft");
    expect(screen.queryAllByDisplayValue("NEW_VAR")).toHaveLength(1);

    // Switching providers resets envDraft and apiKeyDraft
    fireEvent.click(screen.getByRole("button", { name: /Codex/i }));
    await screen.findByDisplayValue("CODEX_VAR");
    expect(screen.queryByDisplayValue("NEW_VAR")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/i }));
    await screen.findByDisplayValue("CUSTOM_VAR");
    const resetApiKeyInput = within(
      screen.getByText("Claude account").parentElement!,
    ).getByPlaceholderText("••••1234") as HTMLInputElement;
    expect(resetApiKeyInput.value).toBe("");
    expect(screen.queryByDisplayValue("NEW_VAR")).toBeNull();
  });

  it("post-preflight reloads useUiStore.instances so knownModelIds sees newly discovered models when toggling off disableAll", async () => {
    const codexNoModels: InstanceInfo = { ...structuredClone(codexInstance), configOptions: [] };
    let preflightRan = false;
    mocks.providersPreflight.mockImplementation(async (id: string) => {
      preflightRan = true;
      return {
        instanceId: id,
        agentName: "Codex",
        agentVersion: "1.0.0",
        loadSession: true,
        promptImage: false,
        authRequired: false,
        authHint: null,
        configOptions: codexInstance.configOptions,
        authMethods: [],
      };
    });
    mocks.providersInstancesList.mockImplementation(async () => [
      preflightRan ? structuredClone(codexInstance) : structuredClone(codexNoModels),
    ]);
    useSettingsStore.setState({
      modelsDisabledAll: { codex: true },
      disabledModels: { codex: [] },
    });

    render(<ProvidersSettings />);
    // Wait until post-preflight refresh renders GPT-6 toggle AND syncs useUiStore.instances
    const gpt6Toggle = await screen.findByRole("switch", { name: /Enable GPT-6/i });
    await waitFor(() =>
      expect(useUiStore.getState().instances[0]?.configOptions.length).toBeGreaterThan(0),
    );
    fireEvent.click(gpt6Toggle);

    // knownModelIds("codex") saw ["gpt-6", "gpt-5"], so enabling gpt-6 kept gpt-5 disabled
    expect(useSettingsStore.getState().modelsDisabledAll.codex).toBe(false);
    expect(useSettingsStore.getState().disabledModels.codex).toEqual(["gpt-5"]);
  });

  it("AddProviderDialog onAdded awaits reload() before selecting the new provider so envDraft is populated", async () => {
    const newCodex: InstanceInfo = {
      id: "codex-added",
      displayName: "Codex Added",
      enabled: true,
      driver: "acp",
      command: "npx",
      args: ["-y", "@agentclientprotocol/codex-acp"],
      env: { CODEX_ENDPOINT: "https://example.test" },
      secretEnv: [{ key: "OPENAI_API_KEY", hasValue: true, masked: "••••5678" }],
      homePath: null,
      shadowHomePath: null,
      status: "stopped",
      promptImage: true,
      loadSession: true,
      modes: [],
      configOptions: [],
      authMethods: [],
    };
    let currentList = [structuredClone(claudeInstance)];
    mocks.providersInstancesList.mockImplementation(async () => currentList);
    mocks.providersInstancesSave.mockImplementationOnce(async () => {
      currentList = [structuredClone(claudeInstance), newCodex];
    });

    render(<ProvidersSettings />);
    await screen.findByDisplayValue("CUSTOM_VAR");

    fireEvent.click(screen.getAllByRole("button", { name: "Add provider" })[0]!);
    const dialog = screen.getByRole("dialog", { name: "Add provider" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Codex/i }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    fireEvent.change(within(dialog).getByLabelText(/Label/i), {
      target: { value: "Codex Added" },
    });
    fireEvent.change(within(dialog).getByLabelText(/Instance ID/i), {
      target: { value: "codex-added" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    fireEvent.change(within(dialog).getByPlaceholderText("OPENAI_API_KEY"), {
      target: { value: "sk-test-key" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Install & connect" }));

    await screen.findByRole("heading", { name: "Codex Added" });
    expect(await screen.findByDisplayValue("OPENAI_API_KEY")).toBeInTheDocument();
    expect(screen.getByDisplayValue("CODEX_ENDPOINT")).toBeInTheDocument();
  });

  it("saveEnv keeps secretEnvKeys and clears typed secret values after reload", async () => {
    let currentClaude = structuredClone(claudeInstance);
    mocks.providersInstancesList.mockImplementation(async () => [structuredClone(currentClaude)]);
    mocks.providersInstancesSave.mockImplementation(async (specs: InstanceSpec[]) => {
      const claudeSpec = specs.find((s) => s.id === "claude")!;
      const nextEnv = { ...claudeSpec.env };
      const nextSecrets = (claudeSpec.secretEnvKeys ?? []).map((key) => {
        const typed = nextEnv[key];
        delete nextEnv[key];
        const prev = currentClaude.secretEnv?.find((s) => s.key === key);
        return {
          key,
          hasValue: Boolean(typed) || Boolean(prev?.hasValue),
          masked: typed ? `••••${typed.slice(-4)}` : (prev?.masked ?? "••••"),
        };
      });
      currentClaude = { ...currentClaude, env: nextEnv, secretEnv: nextSecrets };
    });

    render(<ProvidersSettings />);
    await screen.findByDisplayValue("CUSTOM_VAR");
    // Wait for initial preflight to settle so save doesn't race it
    await waitFor(() => expect(mocks.providersInstancesList).toHaveBeenCalledTimes(4));

    const envSaveBtn = screen.getAllByRole("button", { name: "Save" }).at(-1)!;
    const secretRowInput = within(envSaveBtn.closest("div")!.parentElement!).getByPlaceholderText(
      "••••1234",
    ) as HTMLInputElement;
    fireEvent.change(secretRowInput, { target: { value: "sk-ant-rotated-9876" } });
    expect(secretRowInput.value).toBe("sk-ant-rotated-9876");

    fireEvent.click(envSaveBtn);
    await waitFor(() => expect(mocks.providersInstancesSave).toHaveBeenCalledTimes(1));

    // After reload, typed secret is cleared and placeholder reflects the updated mask
    await waitFor(() => {
      const updatedInput = within(
        screen.getAllByRole("button", { name: "Save" }).at(-1)!.closest("div")!.parentElement!,
      ).getByPlaceholderText("••••9876") as HTMLInputElement;
      expect(updatedInput.value).toBe("");
    });

    // A subsequent save keeps secretEnvKeys without re-sending plaintext
    fireEvent.click(screen.getAllByRole("button", { name: "Save" }).at(-1)!);
    await waitFor(() => expect(mocks.providersInstancesSave).toHaveBeenCalledTimes(2));
    const secondSaved = mocks.providersInstancesSave.mock.calls[1]![0][0]!;
    expect(secondSaved.secretEnvKeys).toEqual(["ANTHROPIC_API_KEY"]);
    expect(secondSaved.env).toEqual({ CUSTOM_VAR: "keep-me" });
  });

  it("saveClaudeKey clears apiKeyDraft, syncs envDraft without stale plaintext, and a later saveEnv keeps ANTHROPIC_API_KEY", async () => {
    let currentClaude: InstanceInfo = { ...structuredClone(claudeInstance), secretEnv: [] };
    mocks.providersInstancesList.mockImplementation(async () => [structuredClone(currentClaude)]);
    mocks.providersInstancesSave.mockImplementation(async (specs: InstanceSpec[]) => {
      const claudeSpec = specs.find((s) => s.id === "claude")!;
      const nextEnv = { ...claudeSpec.env };
      const nextSecrets = (claudeSpec.secretEnvKeys ?? []).map((key) => {
        const typed = nextEnv[key];
        delete nextEnv[key];
        const prev = currentClaude.secretEnv?.find((s) => s.key === key);
        return {
          key,
          hasValue: Boolean(typed) || Boolean(prev?.hasValue),
          masked: typed ? `••••${typed.slice(-4)}` : (prev?.masked ?? "••••"),
        };
      });
      currentClaude = { ...currentClaude, env: nextEnv, secretEnv: nextSecrets };
    });

    render(<ProvidersSettings />);
    await screen.findByDisplayValue("CUSTOM_VAR");
    await waitFor(() => expect(mocks.providersInstancesList).toHaveBeenCalledTimes(4));

    const claudeAccount = screen.getByText("Claude account").parentElement!;
    const claudeKeyInput = within(claudeAccount).getByPlaceholderText(
      "ANTHROPIC_API_KEY",
    ) as HTMLInputElement;
    fireEvent.change(claudeKeyInput, { target: { value: "sk-ant-fresh-4321" } });
    fireEvent.click(within(claudeAccount).getByRole("button", { name: /Save & connect/i }));

    await waitFor(() => expect(mocks.providersInstancesSave).toHaveBeenCalledTimes(1));
    // apiKeyDraft is cleared and envDraft now includes masked ANTHROPIC_API_KEY with no plaintext value
    await waitFor(() => {
      const clearedClaudeInput = within(
        screen.getByText("Claude account").parentElement!,
      ).getByPlaceholderText("••••4321") as HTMLInputElement;
      expect(clearedClaudeInput.value).toBe("");
    });
    const envSecretKeyInput = await screen.findByDisplayValue("ANTHROPIC_API_KEY");
    const envSecretValueInput = within(envSecretKeyInput.parentElement!).getByPlaceholderText(
      "••••4321",
    ) as HTMLInputElement;
    expect(envSecretValueInput.value).toBe("");
    expect(envSecretValueInput.type).toBe("password");

    // Later saveEnv keeps ANTHROPIC_API_KEY in secretEnvKeys without leaking plaintext
    fireEvent.click(screen.getAllByRole("button", { name: "Save" }).at(-1)!);
    await waitFor(() => expect(mocks.providersInstancesSave).toHaveBeenCalledTimes(2));
    const laterSaved = mocks.providersInstancesSave.mock.calls[1]![0][0]!;
    expect(laterSaved.secretEnvKeys).toEqual(["ANTHROPIC_API_KEY"]);
    expect(laterSaved.env).toEqual({ CUSTOM_VAR: "keep-me" });
  });
});
