import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";
import type { InstanceInfo, Run, SessionConfigOption } from "../src/lib/types";

const {
  navigate,
  runsCancel,
  runsDispatch,
  runsRespondPermission,
  runsQueueRemove,
  workspaceFiles,
  runsSetMode,
  runsSetConfigOption,
  runsSetPermissionMode,
  threadsCreate,
  settingsSet,
  providersInstancesList,
  gitStatus,
  gitDiff,
} = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
  runsCancel: vi.fn(),
  runsDispatch: vi.fn(),
  runsRespondPermission: vi.fn(),
  runsQueueRemove: vi.fn(),
  workspaceFiles: vi.fn(),
  runsSetMode: vi.fn(),
  runsSetConfigOption: vi.fn(),
  runsSetPermissionMode: vi.fn(),
  threadsCreate: vi.fn(),
  settingsSet: vi.fn(),
  providersInstancesList: vi.fn(),
  gitStatus: vi.fn(),
  gitDiff: vi.fn(),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    runsCancel,
    runsDispatch,
    runsRespondPermission,
    runsQueueRemove,
    workspaceFiles,
    runsSetMode,
    runsSetConfigOption,
    runsSetPermissionMode,
    threadsCreate,
    settingsSet,
    providersInstancesList,
    gitStatus,
    gitDiff,
    onThreadUpdate: vi.fn(async () => () => {}),
    onAgentProcess: vi.fn(async () => () => {}),
  };
});

vi.mock("../src/lib/tauri", () => ({
  isTauri: () => true,
}));

vi.mock("@tanstack/react-router", () => ({
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
  pickerConfigValue,
  pickerModeId,
} from "../src/components/chat/ComposerControls";
import { useProjectsStore } from "../src/stores/projects";
import { useRunsStore } from "../src/stores/runs";
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
    useRunsStore.getState().registerRun(runningRun);
    useUiStore.setState({ selectedInstanceId: "mock", paletteOpen: false, instances: [] });
    useSettingsStore.setState({ permissionMode: "supervised" });
    useThreadsStore.setState({ threads: [], activeThreadId: null });
    useProjectsStore.setState({ projects: [], selectedProjectId: null });
  });

  it("inserts the leading slash for a picked command", () => {
    expect(formatSlashInsertion({ name: "commit", description: "" })).toBe("/commit ");
  });

  it("cancels the active run on Escape", () => {
    render(<Composer threadId="th" />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(runsCancel).toHaveBeenCalledWith("r1");
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

  it("picks a slash command with the leading slash in the textarea", () => {
    render(<Composer threadId="th" />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "/com" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("/commit ");
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

    const attach = screen.getByLabelText("Attach images");
    expect(attach.querySelector("svg.lucide-paperclip")).toBeTruthy();
    expect(attach.querySelector("svg.lucide-plus")).toBeNull();

    expect(screen.getByRole("button", { name: /Claude Code/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Composer options" })).toBeTruthy();

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

  it("hides permission and mode pills from the bar and deduplicates mode configOption inside overflow", () => {
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

    expect(screen.queryByText(/^(Full access|Supervised|Auto edit|Auto)$/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Permission mode/i })).toBeNull();
    expect(screen.queryByText("Architect")).toBeNull();
    expect(screen.queryByText("Web search")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Mode:/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Pro/ })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Composer options" }));

    expect(screen.getAllByText(/^(Full access|Supervised|Auto edit|Auto)$/)).toHaveLength(1);
    expect(screen.getAllByText("Architect")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /^Mode:/i })).toBeNull();
    expect(screen.getByText("Web search")).toBeTruthy();
    expect(screen.getByText(/High/)).toBeTruthy();
  });

  it("opens overflow with Effort, Session mode, Permission mode, Agent switcher, closes on Escape, and updates permission", async () => {
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
          ],
        }),
        makeInstance({ id: "codex", displayName: "Codex" }),
      ],
    });

    render(<Composer threadId="th" />);

    fireEvent.click(screen.getByRole("button", { name: "Composer options" }));
    expect(screen.getByText(/Effort/i)).toBeTruthy();
    expect(screen.getByText(/Session mode/i)).toBeTruthy();
    expect(screen.getByText(/Permission/i)).toBeTruthy();
    expect(screen.getByText(/Agent/i)).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByText(/Permission/i)).toBeNull());
    expect(runsCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Composer options" }));
    if (!screen.queryByRole("button", { name: /Full access/i })) {
      fireEvent.click(screen.getByRole("button", { name: /Permission mode|Supervised/i }));
    }
    fireEvent.click(screen.getByRole("button", { name: /Full access/i }));

    expect(useSettingsStore.getState().permissionMode).toBe("full_access");
    expect(runsSetPermissionMode).toHaveBeenCalledWith("th", "full_access");
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
});
