import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";
import type { InstanceInfo, Run, SessionConfigOption } from "../src/lib/types";

const {
  navigate,
  runsCancel,
  runsDispatch,
  runsRespondPermission,
  runsQueueSteer,
  runsQueueRemove,
  runsQueueUpdate,
  runsQueueReorder,
  workspaceFiles,
  runsSetMode,
  runsSetConfigOption,
  runsSetPermissionMode,
  threadsCreate,
  settingsSet,
  providersInstancesList,
  gitStatus,
  gitDiff,
  gitDiffSummary,
  gitDiffFile,
} = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
  runsCancel: vi.fn(),
  runsDispatch: vi.fn(),
  runsRespondPermission: vi.fn(),
  runsQueueSteer: vi.fn(),
  runsQueueRemove: vi.fn(),
  runsQueueUpdate: vi.fn(),
  runsQueueReorder: vi.fn(),
  workspaceFiles: vi.fn(),
  runsSetMode: vi.fn(),
  runsSetConfigOption: vi.fn(),
  runsSetPermissionMode: vi.fn(),
  threadsCreate: vi.fn(),
  settingsSet: vi.fn(),
  providersInstancesList: vi.fn(),
  gitStatus: vi.fn(),
  gitDiff: vi.fn(),
  gitDiffSummary: vi.fn(),
  gitDiffFile: vi.fn(),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    runsCancel,
    runsDispatch,
    runsRespondPermission,
    runsQueueSteer,
    runsQueueRemove,
    runsQueueUpdate,
    runsQueueReorder,
    workspaceFiles,
    runsSetMode,
    runsSetConfigOption,
    runsSetPermissionMode,
    threadsCreate,
    settingsSet,
    providersInstancesList,
    gitStatus,
    gitDiff,
    gitDiffSummary,
    gitDiffFile,
    onThreadUpdate: vi.fn(async () => () => {}),
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

import {
  Composer,
  configForSend,
  extractMentionQuery,
  formatSlashInsertion,
  modeForSend,
  shouldCancelOnEscape,
} from "../src/components/chat/Composer";
import {
  ConfigOptionPickers,
  ProviderModelPicker,
  isReasoningOption,
  pickerConfigValue,
  pickerModeId,
} from "../src/components/chat/ComposerControls";
import { ProviderLogo } from "../src/components/chat/ProviderLogo";
import { useGitStore } from "../src/stores/git";
import { useProjectsStore } from "../src/stores/projects";
import { useRunsStore } from "../src/stores/runs";
import { useDraftsStore } from "../src/stores/drafts";
import { useSettingsStore } from "../src/stores/settings";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

const runningRun: Run = {
  id: "r1",
  threadId: "th",
  idx: 0,
  status: "running",
  instanceId: "mock",
  startedAt: 0,
};

function makeInstance(overrides: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    id: "mock",
    displayName: "Mock Agent",
    enabled: true,
    driver: "mock",
    command: "node",
    args: [],
    env: {},
    status: "running",
    promptImage: true,
    loadSession: true,
    modes: [],
    configOptions: [],
    authMethods: [],
    ...overrides,
  };
}

describe("composer", () => {
  beforeEach(() => {
    navigate.mockReset().mockResolvedValue(undefined);
    runsCancel.mockReset().mockResolvedValue(undefined);
    runsDispatch.mockReset().mockResolvedValue({ run: null, queued: false, queueId: null });
    runsRespondPermission.mockReset().mockResolvedValue(undefined);
    runsQueueRemove.mockReset().mockResolvedValue(undefined);
    runsQueueSteer.mockReset().mockResolvedValue(undefined);
    runsQueueUpdate.mockReset().mockResolvedValue(undefined);
    runsQueueReorder.mockReset().mockResolvedValue(undefined);
    workspaceFiles.mockReset().mockResolvedValue([]);
    runsSetMode.mockReset().mockResolvedValue(undefined);
    runsSetConfigOption.mockReset().mockResolvedValue(undefined);
    runsSetPermissionMode.mockReset().mockResolvedValue(undefined);
    threadsCreate.mockReset();
    settingsSet.mockReset().mockResolvedValue(undefined);
    providersInstancesList
      .mockReset()
      .mockImplementation(async () => useUiStore.getState().instances);
    gitStatus.mockReset().mockResolvedValue({ branch: "main", entries: [] });
    gitDiff.mockReset().mockResolvedValue({ files: [] });
    gitDiffSummary
      .mockReset()
      .mockResolvedValue({ repoRoot: "", base: "HEAD", totalAdded: 0, totalRemoved: 0, files: [] });
    gitDiffFile.mockReset();

    useRunsStore.setState({
      runsByThread: {},
      viewsByRun: {},
      appliedEvents: {},
      commandsByThread: {},
      queueByThread: {},
      cancellingByRun: {},
      desiredModeByThread: {},
      desiredConfigByThread: {},
      activeElicitation: null,
    });
    useRunsStore.getState().registerRun(runningRun);
    useUiStore.setState({
      selectedInstanceId: "mock",
      instanceByThread: {},
      paletteOpen: false,
      instances: [],
    });
    useSettingsStore.setState({ permissionMode: "supervised", glassOpacity: 100 });
    useThreadsStore.setState({ threads: [], activeThreadId: null });
    useProjectsStore.setState({ projects: [], selectedProjectId: null });
    useDraftsStore.setState({ byThread: {}, heightByThread: {} });
  });

  it("inserts the leading slash for a picked command", () => {
    expect(formatSlashInsertion({ name: "commit", description: "" })).toBe("/commit ");
  });

  it("cancels the active run on Escape", () => {
    render(<Composer threadId="th" />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(runsCancel).toHaveBeenCalledWith("r1", false);
  });

  it("does not cancel while the slash menu owns Escape", () => {
    render(<Composer threadId="th" />);
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "/" } });
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(runsCancel).not.toHaveBeenCalled();
  });

  it("shows a clickable allow_always option next to allow_once and reject", () => {
    useRunsStore.setState((s) => ({
      viewsByRun: {
        ...s.viewsByRun,
        r1: {
          ...s.viewsByRun.r1,
          pendingApproval: {
            requestId: "req",
            title: "Run the tests?",
            options: [
              { optionId: "o1", name: "Allow once", kind: "allow_once" },
              { optionId: "o2", name: "Always allow", kind: "allow_always" },
              { optionId: "o3", name: "Reject", kind: "reject_once" },
            ],
          },
        },
      },
    }));
    render(<Composer threadId="th" />);
    const always = screen.getByRole("button", { name: /Always allow/ });
    fireEvent.click(always);
    expect(runsRespondPermission).toHaveBeenCalledWith("r1", "req", "o2");
  });

  it("does not cancel while a picker layer owns Escape", () => {
    render(<Composer threadId="th" />);
    const layer = document.createElement("div");
    layer.setAttribute("data-escape-layer", "");
    document.body.appendChild(layer);
    try {
      fireEvent.keyDown(window, { key: "Escape" });
      expect(runsCancel).not.toHaveBeenCalled();
    } finally {
      layer.remove();
    }
  });

  it("keeps a per-thread draft across unmount and remount", () => {
    const { unmount } = render(<Composer threadId="th" />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "unsent draft" } });
    unmount();

    render(<Composer threadId="th" />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("unsent draft");
    expect(useDraftsStore.getState().byThread.th).toBe("unsent draft");
  });

  it("keeps drafts isolated per thread", () => {
    const first = render(<Composer threadId="th" />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "thread one" } });
    first.unmount();

    render(<Composer threadId="other" />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "thread two" } });
    expect(useDraftsStore.getState().byThread).toEqual({
      th: "thread one",
      other: "thread two",
    });
  });

  it("picks a slash command with the leading slash in the textarea", () => {
    render(<Composer threadId="th" />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "/com" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("/commit ");
  });

  it("picks a slash command with Tab", () => {
    render(<Composer threadId="th" />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "/com" } });
    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea.value).toBe("/commit ");
  });

  it("picks an @ mention with Tab", async () => {
    workspaceFiles.mockResolvedValue(["src/main.ts", "docs/readme.md"]);
    render(<Composer threadId="th" />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "look @mai" } });
    expect(await screen.findByText("src/main.ts")).toBeTruthy();
    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea.value).toBe("look @src/main.ts ");
  });

  it("detects an @ token at the caret and ignores emails", () => {
    expect(extractMentionQuery("look at @src/ma", 15)).toEqual({ start: 8, query: "src/ma" });
    expect(extractMentionQuery("foo@bar.com", 11)).toBeNull();
    expect(extractMentionQuery("done @main.ts ", 14)).toBeNull();
  });

  it("picks a workspace file for an @ mention", async () => {
    workspaceFiles.mockResolvedValue(["src/main.ts", "docs/readme.md"]);
    render(<Composer threadId="th" />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "look @mai" } });
    expect(await screen.findByText("src/main.ts")).toBeTruthy();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("look @src/main.ts ");
  });

  it("keeps the /chat mode out of existing threads", () => {
    const desired = { "": "architect", th2: "code" };
    expect(modeForSend(desired, "th2")).toBe("code");
    expect(modeForSend(desired, "th3")).toBeNull();
    expect(modeForSend(desired)).toBe("architect");
  });

  it("prefers the remembered mode over a finished run's mode", () => {
    expect(pickerModeId({ status: "finished" }, "code", "architect")).toBe("architect");
    expect(pickerModeId({ status: "running" }, "code", undefined)).toBe("code");
    expect(pickerModeId({ status: "running" }, "code", "architect")).toBe("architect");
  });

  it("keeps /chat config picks out of existing threads", () => {
    const desired = { "": { model: "mock-pro" }, th2: { web_search: true } };
    expect(configForSend(desired, "th2")).toEqual({ web_search: true });
    expect(configForSend(desired, "th3")).toBeNull();
    expect(configForSend(desired)).toEqual({ model: "mock-pro" });
  });

  it("filters configForSend against optional instanceOptions when provided", () => {
    const desired = {
      "": { model: "mock-pro" },
      th2: { model: "gpt-5", thinking_level: "high", effort: "max", web_search: true },
    };
    // undefined preserves 2-arg legacy behavior
    expect(configForSend(desired, "th2", undefined)).toEqual({
      model: "gpt-5",
      thinking_level: "high",
      effort: "max",
      web_search: true,
    });
    // [] drops all config and returns null
    expect(configForSend(desired, "th2", [])).toBeNull();
    expect(configForSend(desired, undefined, [])).toBeNull();

    const codexOptions: SessionConfigOption[] = [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "gpt-5",
        options: [{ value: "gpt-5", name: "GPT-5" }],
      },
      {
        type: "boolean",
        id: "web_search",
        name: "Web search",
        category: "other",
        currentValue: false,
      },
    ];
    expect(configForSend(desired, "th2", codexOptions)).toEqual({
      model: "gpt-5",
      web_search: true,
    });
    expect(
      configForSend(
        { th2: { model: "claude-sonnet-4", thinking_level: "high" } },
        "th2",
        codexOptions,
      ),
    ).toBeNull();
  });

  it("falls back when a remembered config value is invalid", () => {
    const option: SessionConfigOption = {
      type: "select",
      id: "model",
      name: "Model",
      currentValue: "mock-fast",
      options: [
        { value: "mock-fast", name: "Fast" },
        { value: "mock-pro", name: "Pro" },
      ],
    };
    expect(pickerConfigValue(option, undefined, undefined, { model: "mock-pro" })).toBe("mock-pro");
    expect(pickerConfigValue(option, undefined, undefined, { model: "gone" })).toBe("mock-fast");
  });

  it("renders grouped config pickers; Esc closes without cancelling", async () => {
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [
        {
          id: "mock",
          displayName: "Mock",
          enabled: true,
          driver: "mock",
          command: "node",
          args: [],
          env: {},
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
              currentValue: "mock-fast",
              options: [
                {
                  group: "recommended",
                  name: "Recommended",
                  options: [
                    { value: "mock-fast", name: "Fast" },
                    { value: "mock-pro", name: "Pro" },
                  ],
                },
                {
                  group: "legacy",
                  name: "Legacy",
                  options: [{ value: "mock-v1", name: "V1" }],
                },
              ],
            },
            {
              type: "boolean",
              id: "web_search",
              name: "Web search",
              category: "other",
              currentValue: false,
            },
          ],
          authMethods: [],
        },
      ],
    });
    render(<ConfigOptionPickers threadId="th" />);
    fireEvent.click(screen.getByRole("button", { name: /Model/ }));
    expect(screen.getByText("Recommended")).toBeTruthy();
    expect(screen.getByText("Legacy")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText("Recommended")).toBeNull());
    expect(runsCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Web search" }));
    expect(useRunsStore.getState().desiredConfigByThread["th"]).toEqual({ web_search: true });
  });

  it("keeps Esc priority rules explicit", () => {
    expect(shouldCancelOnEscape({ runActive: true, overlayOpen: false })).toBe(true);
    expect(shouldCancelOnEscape({ runActive: true, overlayOpen: true })).toBe(false);
    expect(shouldCancelOnEscape({ runActive: false, overlayOpen: false })).toBe(false);
  });

  it("renders paperclip attach, model pill, overflow button, round send/stop, and no microphone", () => {
    useRunsStore.setState({ runsByThread: {} });
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [makeInstance({ displayName: "Claude Code", promptImage: true })],
    });

    const { container } = render(<Composer threadId="th" />);

    const attach = screen.getByLabelText("Attach files");
    expect(attach.querySelector("svg.lucide-paperclip")).toBeTruthy();
    expect(attach.querySelector("svg.lucide-plus")).toBeNull();

    expect(screen.getByRole("button", { name: /Claude Code/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Composer options" })).toBeNull();

    const sendBtn = screen.getByRole("button", { name: "Send message" });
    expect(sendBtn.className).toContain("rounded-full");
    expect(screen.queryByRole("button", { name: "Stop run" })).toBeNull();
    expect(screen.queryByRole("button", { name: /mic|voice/i })).toBeNull();
    expect(container.querySelector('[aria-label*="mic" i], [aria-label*="voice" i]')).toBeNull();

    cleanup();

    useRunsStore.getState().registerRun(runningRun);
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [
        makeInstance({
          displayName: "Claude Code",
          configOptions: [
            {
              type: "select",
              id: "model",
              name: "Model",
              category: "model",
              currentValue: "mock-pro",
              options: [
                { value: "mock-fast", name: "Fast" },
                { value: "mock-pro", name: "Pro" },
              ],
            },
          ],
        }),
      ],
    });

    render(<Composer threadId="th" />);
    expect(screen.getByRole("button", { name: /Pro/ })).toBeTruthy();
    const stopBtn = screen.getByRole("button", { name: "Stop run" });
    expect(stopBtn.className).toContain("rounded-full");
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
  });

  it("keeps permission inline in the composer bar and deduplicates mode configOption inside overflow", () => {
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [
        makeInstance({
          displayName: "Claude Code",
          modes: [
            { id: "architect", name: "Architect" },
            { id: "code", name: "Code" },
          ],
        }),
      ],
    });
    useRunsStore.setState((s) => ({
      viewsByRun: {
        ...s.viewsByRun,
        r1: {
          ...s.viewsByRun.r1,
          modeId: "architect",
          configOptions: [
            {
              type: "select",
              id: "model",
              name: "Model",
              category: "model",
              currentValue: "mock-pro",
              options: [
                { value: "mock-fast", name: "Fast" },
                { value: "mock-pro", name: "Pro" },
              ],
            },
            {
              type: "select",
              id: "mode",
              name: "Mode",
              category: "mode",
              currentValue: "architect",
              options: [
                { value: "architect", name: "Architect" },
                { value: "code", name: "Code" },
              ],
            },
            {
              type: "select",
              id: "thought_level",
              name: "Effort",
              category: "thought_level",
              currentValue: "high",
              options: [
                { value: "low", name: "Low" },
                { value: "high", name: "High" },
              ],
            },
            {
              type: "boolean",
              id: "web_search",
              name: "Web search",
              category: "other",
              currentValue: false,
            },
          ],
        },
      },
    }));

    render(<Composer threadId="th" />);

    expect(screen.getByRole("button", { name: /Permission mode/i })).toBeTruthy();
    expect(screen.getByText(/^(Full access|Supervised|Auto edit|Auto)$/)).toBeTruthy();
    expect(screen.queryByText("Architect")).toBeNull();
    expect(screen.queryByText("Web search")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Mode:/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Pro/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Pro/ }));
    const dialog = screen.getByRole("dialog", { name: "Provider, model, and reasoning" });

    expect(within(dialog).queryByRole("button", { name: /Permission mode/i })).toBeNull();
    expect(within(dialog).getAllByText("Architect")).toHaveLength(1);
    expect(within(dialog).queryByRole("button", { name: /^Mode:/i })).toBeNull();
    expect(within(dialog).getByText("Web search")).toBeTruthy();
    expect(within(dialog).getByText("High")).toBeTruthy();
    expect(within(dialog).queryByText(/thought_level/i)).toBeNull();
  });

  it("shows only the model name without the provider prefix, without fading or ellipsis", () => {
    useRunsStore.setState({ runsByThread: {} });
    useUiStore.setState({
      selectedInstanceId: "opencode",
      instances: [
        makeInstance({
          id: "opencode",
          displayName: "opencode",
          driver: "opencode",
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
                  name: "opencode-go/deepseek-v4.1-flash",
                },
              ],
            },
          ],
        }),
      ],
    });

    render(<Composer threadId="th" />);

    const label = screen.getByText("deepseek-v4.1-flash");
    expect(label.className).not.toContain("max-w-[150px]");
    expect(label.className).not.toContain("truncate");
    const trigger = label.closest("button")!;
    expect(trigger.className).not.toContain("max-w-[320px]");
  });

  it.skip("uses EllipsisText for non-opencode providers and omits truncation for opencode matched by driver", () => {
    const scrollSpy = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(220);
    const clientSpy = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(120);

    try {
      useRunsStore.setState({ runsByThread: {} });
      useUiStore.setState({
        selectedInstanceId: "claude",
        instances: [
          makeInstance({
            id: "claude",
            displayName: "Claude Code",
            driver: "claude",
            configOptions: [
              {
                type: "select",
                id: "model",
                name: "Model",
                category: "model",
                currentValue: "claude-sonnet-4-very-long-model-name",
                options: [
                  {
                    value: "claude-sonnet-4-very-long-model-name",
                    name: "claude-sonnet-4-very-long-model-name",
                  },
                ],
              },
            ],
          }),
          makeInstance({
            id: "custom-oc",
            displayName: "OpenCode Custom",
            driver: "opencode",
            configOptions: [
              {
                type: "select",
                id: "model",
                name: "Model",
                category: "model",
                currentValue: "opencode-go/qwen-3-coder-480b",
                options: [
                  {
                    value: "opencode-go/qwen-3-coder-480b",
                    name: "opencode-go/qwen-3-coder-480b",
                  },
                ],
              },
            ],
          }),
        ],
      });

      const firstRender = render(<Composer threadId="th" />);
      const claudeLabel = screen.getByText("claude-sonnet-4-very-long-model-name");
      expect(claudeLabel).toHaveClass("max-w-[150px]", "truncate", "block", "min-w-0");
      expect(claudeLabel).not.toHaveClass("fade-truncate");
      expect(claudeLabel).not.toHaveClass("shrink-0");
      expect(claudeLabel.closest("button")).toHaveClass("max-w-[320px]");
      firstRender.unmount();

      // Switch to opencode matched by driver (non-"opencode" id): still renders full model name.
      useUiStore.setState({ selectedInstanceId: "custom-oc" });
      render(<Composer threadId="th" />);
      const ocLabel = screen.getByText("qwen-3-coder-480b");
      expect(ocLabel).toHaveClass("shrink-0", "whitespace-nowrap");
      expect(ocLabel).not.toHaveClass(
        "max-w-[150px]",
        "overflow-hidden",
        "truncate",
        "fade-truncate",
      );
      expect(ocLabel.closest("button")).not.toHaveClass("max-w-[320px]");
    } finally {
      scrollSpy.mockRestore();
      clientSpy.mockRestore();
    }
  });

  it("tints Full access orange and highlights the selected row in the menu", () => {
    useRunsStore.setState({ runsByThread: {} });
    useSettingsStore.setState({ permissionMode: "full_access" });
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [makeInstance({ displayName: "Claude Code" })],
    });

    render(<Composer threadId="th" />);
    const pill = screen.getByRole("button", { name: "Permission mode" });
    expect(pill.className).toContain("text-warning");
    expect(pill.querySelector("svg")?.getAttribute("class")).toContain("text-warning");

    fireEvent.click(pill);
    const option = screen.getByRole("button", { name: /Full access/ });
    expect(option.className).toContain("bg-warning/10");
    expect(within(option).getByText("Full access").className).toContain("text-warning");
  });

  it("shows a fast-mode bolt only when the provider exposes it and toggles it", () => {
    useRunsStore.setState({ runsByThread: {} });
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [
        makeInstance({
          displayName: "Codex",
          configOptions: [
            {
              type: "boolean",
              id: "fast_mode",
              name: "Fast mode",
              category: "other",
              currentValue: false,
            },
          ],
        }),
      ],
    });

    render(<Composer threadId="th" />);
    const bolt = screen.getByRole("button", { name: "Fast mode" });
    expect(bolt.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(bolt);
    expect(runsSetConfigOption).toHaveBeenCalledWith("th", "fast_mode", true);
    expect(bolt.getAttribute("aria-pressed")).toBe("true");
    expect(bolt.className).toContain("text-warning");
  });

  it("keeps permission inline in the composer bar and opens overflow with Session mode and extra options", async () => {
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [
        makeInstance({
          id: "mock",
          displayName: "Claude Code",
          modes: [
            { id: "architect", name: "Architect" },
            { id: "code", name: "Code" },
          ],
          configOptions: [
            {
              type: "select",
              id: "thought_level",
              name: "Effort",
              category: "thought_level",
              currentValue: "medium",
              options: [
                { value: "low", name: "Low" },
                { value: "medium", name: "Medium" },
                { value: "high", name: "High" },
              ],
            },
            {
              type: "boolean",
              id: "web_search",
              name: "Web search",
              category: "other",
              currentValue: false,
            },
          ],
        }),
        makeInstance({ id: "codex", displayName: "Codex" }),
      ],
    });

    render(<Composer threadId="th" />);

    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    const dialog = screen.getByRole("dialog", { name: "Provider, model, and reasoning" });
    expect(within(dialog).getByText("Options")).toBeTruthy();
    expect(within(dialog).getByText("Architect")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Permission mode/i })).toBeTruthy();
    expect(within(dialog).getByText("Web search")).toBeTruthy();
    expect(within(dialog).getByText("Medium")).toBeTruthy();
    expect(within(dialog).queryByText(/^Agent$/i)).toBeNull();
    expect(within(dialog).queryByText("Codex")).toBeNull();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Provider, model, and reasoning" })).toBeNull(),
    );
    expect(runsCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Permission mode|Supervised/i }));
    fireEvent.click(screen.getByRole("button", { name: /Full access/i }));

    expect(useSettingsStore.getState().permissionMode).toBe("full_access");
    expect(runsSetPermissionMode).toHaveBeenCalledWith("th", "full_access");
  });

  it("renders unified ProviderModelPicker trigger with provider logo, model name, and gray reasoning text", () => {
    const modelOption: SessionConfigOption = {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "claude-sonnet-4",
      options: [
        { value: "claude-sonnet-4", name: "Sonnet 4" },
        { value: "claude-opus-4", name: "Opus 4" },
      ],
    };
    const thinkingOption: SessionConfigOption = {
      type: "select",
      id: "thinking_level",
      name: "Thinking",
      category: "thought_level",
      currentValue: "high",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    };
    const boolReasoningOption: SessionConfigOption = {
      type: "boolean",
      id: "reasoning",
      name: "Reasoning",
      category: "reasoning",
      currentValue: false,
    };
    const webSearchOption: SessionConfigOption = {
      type: "boolean",
      id: "web_search",
      name: "Web search",
      category: "other",
      currentValue: false,
    };

    expect(isReasoningOption(thinkingOption)).toBe(true);
    expect(isReasoningOption(boolReasoningOption)).toBe(true);
    expect(isReasoningOption(modelOption)).toBe(false);
    expect(isReasoningOption(webSearchOption)).toBe(false);

    const claude = makeInstance({
      id: "claude",
      displayName: "Claude Code",
      driver: "claude",
      command: "claude",
      configOptions: [modelOption, thinkingOption],
    });
    useUiStore.setState({ selectedInstanceId: "claude", instances: [claude] });

    render(<ProviderModelPicker threadId="th" />);
    const trigger = screen.getByRole("button", { name: /Claude Code/i });
    const ariaLabel = trigger.getAttribute("aria-label") ?? "";
    expect(ariaLabel).toContain("Claude Code");
    expect(ariaLabel).toContain("Sonnet 4");
    expect(ariaLabel).toContain("High");

    expect(trigger.querySelector('[data-provider-logo="claude"]')).toBeTruthy();
    expect(within(trigger).getByText("Sonnet 4")).toBeTruthy();
    const reasoningSpan = within(trigger).getByText("High");
    expect(reasoningSpan.className).toContain("text-text-tertiary");

    cleanup();
    const { container } = render(
      <>
        <ProviderLogo
          instance={makeInstance({
            id: "claude",
            displayName: "Claude Code",
            driver: "claude",
            command: "claude",
          })}
        />
        <ProviderLogo
          instance={makeInstance({
            id: "codex",
            displayName: "Codex",
            driver: "codex",
            command: "codex",
          })}
        />
        <ProviderLogo
          instance={makeInstance({
            id: "gemini",
            displayName: "Gemini",
            driver: "gemini",
            command: "gemini",
          })}
        />
        <ProviderLogo
          instance={makeInstance({
            id: "opencode",
            displayName: "OpenCode",
            driver: "opencode",
            command: "opencode",
          })}
        />
      </>,
    );
    expect(container.querySelector('[data-provider-logo="claude"]')).toBeTruthy();
    expect(container.querySelector('[data-provider-logo="codex"]')).toBeTruthy();
    expect(container.querySelector('[data-provider-logo="gemini"]')).toBeTruthy();
    expect(container.querySelector('[data-provider-logo="opencode"]')).toBeTruthy();
  });

  it("handles boolean reasoning option with Off/On trigger text and radiogroup toggle", () => {
    useRunsStore.setState({ runsByThread: {} });
    useUiStore.setState({
      selectedInstanceId: "claude",
      instances: [
        makeInstance({
          id: "claude",
          displayName: "Claude Code",
          driver: "claude",
          command: "claude",
          configOptions: [
            {
              type: "select",
              id: "model",
              name: "Model",
              category: "model",
              currentValue: "claude-sonnet-4",
              options: [{ value: "claude-sonnet-4", name: "Sonnet 4" }],
            },
            {
              type: "boolean",
              id: "reasoning",
              name: "Reasoning",
              category: "reasoning",
              currentValue: false,
            },
          ],
        }),
      ],
    });

    render(<ProviderModelPicker threadId="th" />);
    const trigger = screen.getByRole("button", { name: /Claude Code/i });
    const offSpan = within(trigger).getByText("Off");
    expect(offSpan.className).toContain("text-text-tertiary");

    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Provider, model, and reasoning" });
    const onRadio = within(dialog).getByRole("radio", { name: "On" });
    fireEvent.click(onRadio);

    expect(runsSetConfigOption).toHaveBeenCalledWith("th", "reasoning", true);
    const onSpan = within(trigger).getByText("On");
    expect(onSpan.className).toContain("text-text-tertiary");
    expect(within(trigger).queryByText("Off")).toBeNull();
  });

  it("does not push a pick into another provider's live run", () => {
    // beforeEach leaves a running "mock" run on "th"; the picker now shows "claude".
    useUiStore.setState({
      selectedInstanceId: "claude",
      instances: [
        makeInstance({
          id: "claude",
          displayName: "Claude Code",
          driver: "claude",
          command: "claude",
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
              ],
            },
          ],
        }),
      ],
    });

    render(<ProviderModelPicker threadId="th" />);
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/i }));
    const dialog = screen.getByRole("dialog", { name: "Provider, model, and reasoning" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Opus 4/ }));

    expect(runsSetConfigOption).not.toHaveBeenCalled();
    expect(useRunsStore.getState().desiredConfigByThread["th"]?.model).toBe("claude-opus-4");
  });

  it("opens one dialog with Provider, Model, and Reasoning sections, updates trigger immediately, and stays open on provider click", async () => {
    useRunsStore.setState({ runsByThread: {} });
    useUiStore.setState({
      selectedInstanceId: "claude",
      instances: [
        makeInstance({
          id: "claude",
          displayName: "Claude Code",
          driver: "claude",
          command: "claude",
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
              ],
            },
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
        }),
        makeInstance({
          id: "codex",
          displayName: "Codex",
          driver: "codex",
          command: "codex",
          configOptions: [
            {
              type: "select",
              id: "model",
              name: "Model",
              category: "model",
              currentValue: "gpt-5",
              options: [{ value: "gpt-5", name: "GPT-5" }],
            },
          ],
        }),
      ],
    });

    render(<ProviderModelPicker threadId="th" />);
    const trigger = screen.getByRole("button", { name: /Claude Code/i });
    fireEvent.click(trigger);

    const dialogs = screen.getAllByRole("dialog");
    expect(dialogs).toHaveLength(1);
    const dialog = screen.getByRole("dialog", { name: "Provider, model, and reasoning" });
    expect(within(dialog).getByText("Provider")).toBeTruthy();
    expect(within(dialog).getByText("Model")).toBeTruthy();
    expect(within(dialog).getByText("Reasoning")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: /Opus 4/ }));
    expect(runsSetConfigOption).toHaveBeenCalledWith("th", "model", "claude-opus-4");
    expect(within(trigger).getByText("Opus 4")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("radio", { name: "Low" }));
    expect(runsSetConfigOption).toHaveBeenCalledWith("th", "thinking_level", "low");
    expect(within(trigger).getByText("Low")).toBeTruthy();

    // UX ruling: clicking a Provider row MUST keep the one popover open.
    fireEvent.click(within(dialog).getByRole("button", { name: /Codex/ }));
    expect(screen.getByRole("dialog", { name: "Provider, model, and reasoning" })).toBeTruthy();

    // Outside click closes it
    fireEvent.mouseDown(document.body);
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Provider, model, and reasoning" })).toBeNull(),
    );

    // Escape closes it without cancelling active run
    fireEvent.click(screen.getByRole("button", { name: /Codex/i }));
    expect(screen.getByRole("dialog", { name: "Provider, model, and reasoning" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Provider, model, and reasoning" })).toBeNull(),
    );
    expect(runsCancel).not.toHaveBeenCalled();

    // Manage providers closes it and navigates
    fireEvent.click(screen.getByRole("button", { name: /Codex/i }));
    const reopened = screen.getByRole("dialog", { name: "Provider, model, and reasoning" });
    fireEvent.click(within(reopened).getByRole("button", { name: /Manage providers/i }));
    expect(screen.queryByRole("dialog", { name: "Provider, model, and reasoning" })).toBeNull();
    expect(navigate).toHaveBeenCalledWith({ to: "/settings/providers" });
  });

  it("prunes stale thinking_level/effort/model when switching provider and never dispatches stale keys", async () => {
    useRunsStore.setState({
      runsByThread: {},
      desiredConfigByThread: {
        th: { model: "claude-sonnet-4", thinking_level: "high", effort: "max" },
      },
    });
    useUiStore.setState({
      selectedInstanceId: "claude",
      instances: [
        makeInstance({
          id: "claude",
          displayName: "Claude Code",
          driver: "claude",
          command: "claude",
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
              ],
            },
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
        }),
        makeInstance({
          id: "codex",
          displayName: "Codex",
          driver: "codex",
          command: "codex",
          configOptions: [
            {
              type: "select",
              id: "model",
              name: "Model",
              category: "model",
              currentValue: "gpt-5",
              options: [
                { value: "gpt-5", name: "GPT-5" },
                { value: "o3", name: "o3" },
              ],
            },
            {
              type: "select",
              id: "reasoning_effort",
              name: "Reasoning",
              category: "reasoning",
              currentValue: "medium",
              options: [
                { value: "low", name: "Low" },
                { value: "medium", name: "Medium" },
              ],
            },
          ],
        }),
      ],
    });

    render(<Composer threadId="th" />);

    fireEvent.click(screen.getByRole("button", { name: /Claude Code/i }));
    const dialog = screen.getByRole("dialog", { name: "Provider, model, and reasoning" });
    fireEvent.click(within(dialog).getByRole("button", { name: /Codex/ }));

    // Popover stays open and shows Codex models & reasoning
    expect(screen.getByRole("dialog", { name: "Provider, model, and reasoning" })).toBeTruthy();
    expect(within(dialog).getByText("GPT-5")).toBeTruthy();
    expect(within(dialog).getByText("o3")).toBeTruthy();
    expect(within(dialog).getByText("Low")).toBeTruthy();
    expect(within(dialog).getByText("Medium")).toBeTruthy();

    const desiredAfterSwitch = useRunsStore.getState().desiredConfigByThread["th"];
    expect(desiredAfterSwitch?.thinking_level).toBeUndefined();
    expect(desiredAfterSwitch?.effort).toBeUndefined();
    expect(desiredAfterSwitch?.model).not.toBe("claude-sonnet-4");

    fireEvent.keyDown(window, { key: "Escape" });
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Run on Codex" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });

    await waitFor(() => expect(runsDispatch).toHaveBeenCalledTimes(1));
    const [threadArg, textArg, instanceArg, , , configArg] = runsDispatch.mock.calls[0] as [
      string,
      string,
      string,
      unknown[],
      string | null,
      Record<string, unknown> | null,
    ];
    expect(threadArg).toBe("th");
    expect(textArg).toBe("Run on Codex");
    expect(instanceArg).toBe("codex");
    if (configArg !== null) {
      expect(configArg).not.toHaveProperty("thinking_level");
      expect(configArg).not.toHaveProperty("effort");
      expect(configArg.model).not.toBe("claude-sonnet-4");
    }
  });

  it("opens dialog for optionless instance with displayName trigger and provider-managed model message", () => {
    useUiStore.setState({
      selectedInstanceId: "custom",
      instances: [
        makeInstance({
          id: "custom",
          displayName: "Custom CLI",
          driver: "custom",
          command: "custom-cli",
          configOptions: [],
        }),
      ],
    });

    render(<ProviderModelPicker threadId="th" />);
    const trigger = screen.getByRole("button", { name: /Custom CLI/i });
    expect(within(trigger).getByText("Custom CLI")).toBeTruthy();

    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Provider, model, and reasoning" });
    expect(within(dialog).getByText("Provider")).toBeTruthy();
    expect(within(dialog).getByText("Default model (provider-managed)")).toBeTruthy();
  });

  it("sends on Enter, keeps newline on Shift+Enter, and keeps slash and @ popups working", async () => {
    useRunsStore.setState({ runsByThread: {} });
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [makeInstance()],
    });

    render(<Composer threadId="th" />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Hello thread" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    await waitFor(() =>
      expect(runsDispatch).toHaveBeenCalledWith("th", "Hello thread", "mock", [], null, null),
    );

    cleanup();
    runsDispatch.mockClear();
    threadsCreate.mockResolvedValue({
      id: "th-new",
      projectId: null,
      title: "Create thread",
      status: "working",
      pinned: false,
      createdAt: 0,
      updatedAt: 0,
    });

    render(<Composer />);
    const chatTextarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(chatTextarea, { target: { value: "Create thread" } });
    fireEvent.keyDown(chatTextarea, { key: "Enter", shiftKey: false });
    await waitFor(() => expect(threadsCreate).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(runsDispatch).toHaveBeenCalledWith("th-new", "Create thread", "mock", [], null, null),
    );

    cleanup();
    runsDispatch.mockClear();
    threadsCreate.mockClear();

    render(<Composer threadId="th" />);
    const multilineTextarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(multilineTextarea, { target: { value: "line 1" } });
    const notPrevented = fireEvent.keyDown(multilineTextarea, { key: "Enter", shiftKey: true });
    expect(notPrevented).toBe(true);
    fireEvent.change(multilineTextarea, { target: { value: "line 1\nline 2" } });
    expect(multilineTextarea.value).toBe("line 1\nline 2");
    expect(runsDispatch).not.toHaveBeenCalled();
    expect(threadsCreate).not.toHaveBeenCalled();

    fireEvent.change(multilineTextarea, { target: { value: "/" } });
    expect(screen.getByRole("listbox", { name: "Agent commands" })).toBeTruthy();

    workspaceFiles.mockResolvedValue(["src/App.tsx"]);
    fireEvent.change(multilineTextarea, { target: { value: "inspect @App" } });
    expect(await screen.findByRole("listbox", { name: "Workspace files" })).toBeTruthy();
  });

  it("omits workspace and branch status line while keeping attach, provider picker, overflow, and send", () => {
    useRunsStore.setState({ runsByThread: {} });
    useProjectsStore.setState({ projects: [], selectedProjectId: null });
    useThreadsStore.setState({ threads: [], activeThreadId: null });
    useGitStore.setState({ byThread: {} });
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [makeInstance({ displayName: "Claude Code", promptImage: true })],
    });

    const { unmount } = render(<Composer />);
    expect(screen.queryByText("No workspace selected")).toBeNull();
    unmount();

    useProjectsStore.setState({
      projects: [
        {
          id: "p1",
          name: "Alpha",
          rootPath: "C:\\work\\alpha",
          color: "#346bf1",
          worktreeStrategy: "root",
          pinned: false,
          createdAt: 0,
        },
      ],
      selectedProjectId: "p1",
    });
    useThreadsStore.setState({
      threads: [
        {
          id: "th",
          projectId: "p1",
          title: "Alpha thread",
          workspace: "C:\\work\\alpha",
          status: "draft",
          pinned: false,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      activeThreadId: "th",
    });
    useGitStore.setState({
      byThread: {
        th: {
          status: {
            repoRoot: "C:\\work\\alpha",
            branch: "feat/no-status",
            upstream: null,
            ahead: 0,
            behind: 0,
            entries: [],
          },
          diff: null,
          filePatches: {},
          notRepo: false,
          loading: false,
          error: null,
          commitMessage: "",
          busy: null,
          lastCommit: null,
          lastCommitMessage: null,
          pushedSha: null,
          prUrl: null,
          reviewed: {},
          checkpoints: [],
          activeCheckpoint: null,
          restoringCheckpoint: null,
          restoreBackupId: null,
        },
      },
    });

    const { container } = render(<Composer threadId="th" />);
    expect(screen.queryByText("No workspace selected")).toBeNull();
    expect(screen.queryByText(/C:\\work\\alpha/i)).toBeNull();
    expect(container.textContent).not.toContain("C:\\work\\alpha");
    expect(container.textContent).not.toContain("No workspace selected");

    expect(screen.getByLabelText("Attach files")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Claude Code/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Composer options" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
  });

  it("shows Queue message when a running run has typed text and Stop run when empty", async () => {
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [makeInstance()],
    });

    render(<Composer threadId="th" />);

    expect(screen.getByRole("button", { name: "Stop run" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Queue message" })).toBeNull();

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "queued prompt" } });

    expect(screen.queryByRole("button", { name: "Stop run" })).toBeNull();
    const queueBtn = screen.getByRole("button", { name: "Queue message" });
    fireEvent.click(queueBtn);

    await waitFor(() =>
      expect(runsDispatch).toHaveBeenCalledWith("th", "queued prompt", "mock", [], null, null),
    );
  });

  it("renders queue rows with Steer, Move-to-front, Edit and Remove actions", async () => {
    useRunsStore.setState({
      queueByThread: {
        th: [
          {
            id: "q1",
            threadId: "th",
            instanceId: "mock",
            text: "first queued",
            images: [],
            mode: null,
            configOptions: {},
            createdAt: 1,
          },
          {
            id: "q2",
            threadId: "th",
            instanceId: "mock",
            text: "second queued",
            images: [],
            mode: null,
            configOptions: {},
            createdAt: 2,
          },
        ],
      },
    });
    render(<Composer threadId="th" />);

    // The head of the queue already runs next; without live steer it is not a
    // steer target, while a later row can move up without cancelling the turn.
    const steer = screen.getAllByRole("button", { name: "Steer queued message" });
    expect(steer).toHaveLength(1);
    expect(steer[0]).toBeDisabled();
    expect(screen.getAllByRole("button", { name: "Edit queued message" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Remove queued message" })).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Move to front of queue" }));
    await waitFor(() => expect(runsQueueReorder).toHaveBeenCalledWith("th", ["q2", "q1"]));

    fireEvent.click(screen.getAllByRole("button", { name: "Edit queued message" })[0]);
    expect(screen.getByRole("textbox")).toHaveValue("first queued");
    expect(screen.getByText("Editing queued message")).toBeVisible();
  });

  it("enables live steer only when the provider advertises steering", async () => {
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [makeInstance({ steeringSupported: true })],
    });
    useRunsStore.setState({
      queueByThread: {
        th: [
          {
            id: "q1",
            threadId: "th",
            instanceId: "mock",
            text: "queued",
            images: [],
            mode: null,
            configOptions: {},
            createdAt: 1,
          },
        ],
      },
    });
    render(<Composer threadId="th" />);

    const steer = screen.getByRole("button", { name: "Steer queued message" });
    expect(steer).toBeEnabled();
    fireEvent.click(steer);
    await waitFor(() => expect(runsQueueSteer).toHaveBeenCalledWith("th", "q1"));
  });

  it("drags a queued message when the grip handle is grabbed", () => {
    useRunsStore.setState({
      queueByThread: {
        th: ["q1", "q2"].map((id, i) => ({
          id,
          threadId: "th",
          instanceId: "mock",
          text: `${id} text`,
          images: [],
          mode: null,
          configOptions: {},
          createdAt: i,
        })),
      },
    });
    render(<Composer threadId="th" />);

    const grip = screen.getAllByRole("button", { name: "Reorder queued message" })[1]!;
    const row = grip.parentElement!;
    fireEvent.pointerDown(grip, { clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(row, { clientY: 60, pointerId: 1 });
    fireEvent.pointerUp(row, { pointerId: 1 });

    expect(runsQueueReorder).toHaveBeenCalledWith("th", ["q2", "q1"]);
  });

  it.skip("keeps one glass card mixing var(--composer-tint) above the contrast floor", () => {
    render(<Composer threadId="th" />);
    const card = screen.getByRole("textbox").parentElement?.parentElement as HTMLElement;
    expect(card).not.toBeNull();
    expect(card).toHaveClass("bg-card");
    expect(card.style.getPropertyValue("--card")).toContain("color-mix");
    expect(card.style.getPropertyValue("--card")).toContain("var(--composer-tint)");
    // 100% of the slider is a solid card, and the floor is 96%: the card has to
    // stay visible on the canvas (1.54:1 in dark), so it can no longer smoke
    // down to 52%.
    expect(card.style.getPropertyValue("--card")).toContain("100%");

    cleanup();
    useSettingsStore.setState({ glassOpacity: 40 });
    render(<Composer threadId="th" />);
    const cardAt40 = screen.getByRole("textbox").parentElement?.parentElement as HTMLElement;
    expect(cardAt40).toHaveClass("bg-card");
    expect(cardAt40.style.getPropertyValue("--card")).toContain("color-mix");
    expect(cardAt40.style.getPropertyValue("--card")).toContain("var(--composer-tint)");
    expect(cardAt40.style.getPropertyValue("--card")).toContain("98%");
  });

  it("ModePill shows scope descriptions and Stop button switches to Force stop while cancelling", () => {
    render(<Composer threadId="th" />);

    fireEvent.click(screen.getByRole("button", { name: /Permission mode/i }));
    expect(screen.getByText(/Asks before every tool action/i)).toBeInTheDocument();
    expect(
      screen.getByText(/Files inside the workspace are edited without asking/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Reads and non-destructive tools run/i)).toBeInTheDocument();
    expect(screen.getByText(/Never asks/i)).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.getByRole("button", { name: "Stop run" })).toBeInTheDocument();

    act(() => {
      useRunsStore.getState().markCancelling("r1");
    });

    expect(screen.queryByRole("button", { name: "Stop run" })).toBeNull();
    const forceStopBtn = screen.getByRole("button", { name: "Force stop" });
    fireEvent.click(forceStopBtn);
    expect(runsCancel).toHaveBeenCalledWith("r1", true);
  });

  it("restores the draft height before the first keystroke", () => {
    useDraftsStore.setState({
      byThread: { "th-restore": "line one\nline two\nline three" },
      heightByThread: { "th-restore": 180 },
    });
    const { container } = render(<Composer threadId="th-restore" />);
    expect(container.querySelector("textarea")?.style.height).toBe("180px");
  });
});
