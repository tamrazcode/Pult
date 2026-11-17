import type { ComponentProps } from "react";
import type ReactMarkdownType from "react-markdown";
import type * as ReactMarkdownModule from "react-markdown";
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
    markdownRenders: { count: 0 },
    settingsGet: vi.fn(async () => null),
    settingsSet: vi.fn(async () => undefined),
    providersModelPrefsList: vi.fn(async (): Promise<ProviderModelPrefs[]> => []),
    providersModelPrefsSet: vi.fn(async () => undefined),
    providersInstancesList: vi.fn(async (): Promise<InstanceInfo[]> => []),
    providersInstancesSave: vi.fn(async (_instances: InstanceSpec[]) => undefined),
    providersPreflight: vi.fn(),
    providersInstall: vi.fn(async () => "installed"),
    providersConfigStatus: vi.fn(async () => null),
    providersDetectInstalled: vi.fn(async () => []),
    runsSetConfigOption: vi.fn(async () => undefined),
    navigate: vi.fn(async () => undefined),
  };
});

vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactMarkdownModule>();
  const RealReactMarkdown = actual.default;
  return {
    ...actual,
    default: (props: ComponentProps<typeof ReactMarkdownType>) => {
      mocks.markdownRenders.count += 1;
      return <RealReactMarkdown {...props} />;
    },
  };
});

vi.mock("shiki/core", () => ({ createHighlighterCore: mocks.mockCreateHighlighter }));
vi.mock("shiki/engine/javascript", () => ({ createJavaScriptRegexEngine: vi.fn(() => ({})) }));
vi.mock("shiki/langs/ts.mjs", () => ({ default: { name: "ts" } }));
vi.mock("shiki/langs/rust.mjs", () => ({ default: { name: "rust" } }));
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
    providersInstall: mocks.providersInstall,
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
    select({ location: { pathname: "/chat" } }),
  useRouter: () => ({ navigate: mocks.navigate }),
}));

import { CodeBlock, Markdown } from "../src/components/chat/Markdown";
import { ProviderModelPicker } from "../src/components/chat/ComposerControls";
import { AddProviderDialog } from "../src/components/settings/AddProviderDialog";
import { useRunsStore } from "../src/stores/runs";
import { useSettingsStore } from "../src/stores/settings";
import { useUiStore } from "../src/stores/ui";

const codexInstance: InstanceInfo = {
  id: "codex",
  displayName: "Codex",
  enabled: true,
  driver: "acp",
  command: "npx",
  args: ["-y", "@agentclientprotocol/codex-acp"],
  env: {},
  secretEnv: [{ key: "OPENAI_API_KEY", hasValue: true, masked: "••••1234" }],
  homePath: "C:\\Users\\me\\.codex",
  shadowHomePath: "C:\\Users\\me\\.codex-shadow",
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

describe("Scope A: Markdown memoization and CodeBlock cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mocks.markdownRenders.count = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("memoizes MarkdownBody across sub-32ms token updates and flushes at <=32ms", async () => {
    const { rerender, container } = render(<Markdown text="a" streaming />);
    expect(mocks.markdownRenders.count).toBe(1);

    // Advance 10ms and push multiple rapid deltas inside the 32ms throttle window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    rerender(<Markdown text="ab" streaming />);
    rerender(<Markdown text="abc" streaming />);
    rerender(<Markdown text="abcd" streaming />);

    // MarkdownBody must NOT have re-parsed ReactMarkdown during throttled updates.
    expect(mocks.markdownRenders.count).toBe(1);
    expect(container.textContent).toBe("a");

    // Advancing the remaining 22ms (total 32ms) flushes the latest text once.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(22);
    });
    expect(mocks.markdownRenders.count).toBe(2);
    expect(container.textContent).toBe("abcd");
  });

  it("re-highlights CodeBlock when code or supported lang changes and skips identical rerenders", async () => {
    const { rerender, container } = render(<CodeBlock code="const a = 1;" lang="ts" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(mocks.mockCodeToHtml).toHaveBeenCalledTimes(1);
    expect(container.querySelector("pre")?.getAttribute("data-lang")).toBe("ts");
    expect(container.textContent).toContain("const a = 1;");

    // Identical rerender skips Shiki.
    rerender(<CodeBlock code="const a = 1;" lang="ts" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(mocks.mockCodeToHtml).toHaveBeenCalledTimes(1);

    // Code change re-highlights without stale HTML.
    rerender(<CodeBlock code="const b = 2;" lang="ts" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(mocks.mockCodeToHtml).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("const b = 2;");

    // Language change re-highlights with new language.
    rerender(<CodeBlock code="fn main() {}" lang="rust" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(mocks.mockCodeToHtml).toHaveBeenCalledTimes(3);
    expect(container.querySelector("pre")?.getAttribute("data-lang")).toBe("rust");
    expect(container.textContent).toContain("fn main() {}");
  });
});

describe("Scope B: provider home paths, model prefs, and unfiltered model picker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settingsGet.mockResolvedValue(null);
    mocks.settingsSet.mockResolvedValue(undefined);
    mocks.providersModelPrefsList.mockResolvedValue([]);
    mocks.providersModelPrefsSet.mockResolvedValue(undefined);
    mocks.providersInstancesList.mockResolvedValue([codexInstance]);
    mocks.providersInstancesSave.mockResolvedValue(undefined);
    mocks.providersPreflight.mockResolvedValue({
      instanceId: "claude-2",
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

    useUiStore.setState({
      selectedInstanceId: "codex",
      instances: [codexInstance],
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
      disabledModels: {},
      modelOrder: {},
      modelPrefs: {},
      modelsDisabledAll: {},
    });
  });

  it("AddProviderDialog trims homePath and shadowHomePath and preserves existing instances' home paths", async () => {
    render(
      <AddProviderDialog
        detected={[]}
        instances={[codexInstance]}
        onClose={vi.fn()}
        onAdded={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Claude/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.change(screen.getByLabelText(/^Instance ID/i), { target: { value: "claude-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    fireEvent.change(screen.getByLabelText(/^Home path/i), {
      target: { value: "  C:\\claude-home  " },
    });
    fireEvent.change(screen.getByLabelText(/^Shadow home path/i), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install & connect" }));

    await waitFor(() => expect(mocks.providersInstancesSave).toHaveBeenCalledTimes(1));
    const saved = mocks.providersInstancesSave.mock.calls[0]?.[0] ?? [];
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({
      id: "codex",
      homePath: "C:\\Users\\me\\.codex",
      shadowHomePath: "C:\\Users\\me\\.codex-shadow",
      secretEnvKeys: ["OPENAI_API_KEY"],
    });
    expect(saved[1]).toMatchObject({
      id: "claude-2",
      homePath: "C:\\claude-home",
      shadowHomePath: null,
    });
  });

  it("model picker sees unfiltered runtime instances and filters only via client disabledModels/modelOrder", () => {
    useSettingsStore.setState({
      disabledModels: { codex: ["gpt-5"] },
      modelOrder: { codex: ["gpt-5", "gpt-6"] },
    });

    render(<ProviderModelPicker threadId="th-1" />);
    fireEvent.click(screen.getByRole("button", { name: /Codex/i }));
    const dialog = screen.getByRole("dialog", { name: "Provider, model, and reasoning" });

    expect(within(dialog).getByRole("button", { name: "GPT-6" })).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: "GPT-5" })).toBeNull();

    // Runtime instance list itself remains unfiltered.
    expect(
      useUiStore.getState().instances[0]?.configOptions[0],
    ).toMatchObject({
      options: [
        { value: "gpt-6", name: "GPT-6" },
        { value: "gpt-5", name: "GPT-5" },
      ],
    });
  });

  it("preserves customModels and favorite defaultModelId across toggleModelEnabled/setModelOrder", () => {
    useSettingsStore.setState({
      favoriteModels: { codex: ["gpt-6"] },
      modelPrefs: {
        codex: {
          instanceId: "codex",
          defaultModelId: "gpt-6",
          disableAll: false,
          disabledModels: [],
          modelOrder: [],
          customModels: ["my-custom-model"],
          updatedAt: 100,
        },
      },
    });

    useSettingsStore.getState().toggleModelEnabled("codex", "gpt-5");
    expect(mocks.providersModelPrefsSet).toHaveBeenLastCalledWith(
      expect.objectContaining({
        instanceId: "codex",
        defaultModelId: "gpt-6",
        customModels: ["my-custom-model"],
        disabledModels: ["gpt-5"],
      }),
    );

    useSettingsStore.getState().setModelOrder("codex", ["gpt-5", "gpt-6"]);
    expect(mocks.providersModelPrefsSet).toHaveBeenLastCalledWith(
      expect.objectContaining({
        instanceId: "codex",
        defaultModelId: "gpt-6",
        customModels: ["my-custom-model"],
        modelOrder: ["gpt-5", "gpt-6"],
      }),
    );
  });
});
