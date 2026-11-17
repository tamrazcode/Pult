import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "../src/stores/settings";

const mocks = vi.hoisted(() => ({
  settingsGet: vi.fn(),
  settingsSet: vi.fn(),
  providersModelPrefsList: vi.fn(),
  providersModelPrefsSet: vi.fn(),
}));

vi.mock("../src/lib/ipc", () => mocks);
vi.mock("../src/lib/tauri", () => ({ isTauri: () => true }));

const prefs = {
  instanceId: "codex",
  defaultModelId: "gpt-6",
  disableAll: false,
  disabledModels: ["gpt-5"],
  modelOrder: ["gpt-6", "gpt-5"],
  customModels: ["custom-1"],
  updatedAt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settingsGet.mockResolvedValue(null);
  mocks.settingsSet.mockResolvedValue(undefined);
  mocks.providersModelPrefsList.mockResolvedValue([prefs]);
  mocks.providersModelPrefsSet.mockResolvedValue(undefined);
  useSettingsStore.setState({
    favoriteModels: {},
    disabledModels: {},
    modelOrder: {},
    modelPrefs: {},
    modelsDisabledAll: {},
  });
});

describe("provider model preferences", () => {
  it("hydrates disabled models and order from SQLite prefs", async () => {
    await useSettingsStore.getState().hydrate();
    const state = useSettingsStore.getState();
    expect(state.disabledModels.codex).toEqual(["gpt-5"]);
    expect(state.modelOrder.codex).toEqual(["gpt-6", "gpt-5"]);
    expect(state.modelPrefs.codex.customModels).toEqual(["custom-1"]);
  });

  it("persists disable-all and re-enabling a model", () => {
    useSettingsStore.getState().disableAllModels("codex", ["gpt-6", "gpt-5"]);
    expect(mocks.providersModelPrefsSet).toHaveBeenLastCalledWith(
      expect.objectContaining({
        instanceId: "codex",
        disableAll: true,
        disabledModels: ["gpt-6", "gpt-5"],
      }),
    );

    useSettingsStore.getState().toggleModelEnabled("codex", "gpt-6");
    expect(mocks.providersModelPrefsSet).toHaveBeenLastCalledWith(
      expect.objectContaining({
        instanceId: "codex",
        disableAll: false,
        disabledModels: ["gpt-5"],
      }),
    );
  });
});
