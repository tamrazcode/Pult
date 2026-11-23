import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";
import type { InstanceInfo, Project, SendOutcome, Thread } from "../src/lib/types";

const {
  navigate,
  threadsCreate,
  runsDispatch,
  providersInstancesList,
  runsCancel,
  workspaceFiles,
} = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
  threadsCreate: vi.fn(),
  runsDispatch: vi.fn(),
  providersInstancesList: vi.fn(),
  runsCancel: vi.fn(async () => undefined),
  workspaceFiles: vi.fn(async () => []),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    threadsCreate,
    runsDispatch,
    providersInstancesList,
    runsCancel,
    workspaceFiles,
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

import { ChatHeader } from "../src/components/chat/ChatHeader";
import { Composer } from "../src/components/chat/Composer";
import { NewChatEmptyState } from "../src/components/chat/NewChatEmptyState";
import { useProjectsStore } from "../src/stores/projects";
import { useRunsStore } from "../src/stores/runs";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

const alpha: Project = {
  id: "alpha",
  name: "Alpha",
  rootPath: "C:\\work\\alpha",
  color: "#346bf1",
  worktreeStrategy: "root",
  pinned: false,
  createdAt: 0,
};

const mockInstance: InstanceInfo = {
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
  configOptions: [],
  authMethods: [],
};

const emptyOutcome: SendOutcome = {
  run: null,
  queued: false,
  queueId: null,
};

describe("ChatHeader", () => {
  beforeEach(() => {
    navigate.mockReset().mockResolvedValue(undefined);
    threadsCreate.mockReset();
    runsDispatch.mockReset().mockResolvedValue(emptyOutcome);
    providersInstancesList.mockReset().mockResolvedValue([mockInstance]);
    useProjectsStore.setState({ projects: [], selectedProjectId: null, loaded: true });
    useThreadsStore.setState({ threads: [], activeThreadId: null, unreadIds: [], loaded: true });
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
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [mockInstance],
      paletteOpen: false,
    });
  });

  it("renders project badge, project name, thread title, and worktree badge for a project thread", () => {
    const thread: Thread = {
      id: "th-1",
      projectId: "alpha",
      title: "Fix parser",
      status: "draft",
      pinned: false,
      createdAt: 0,
      updatedAt: 0,
      workspace: "C:\\work\\alpha",
      mainRepo: "C:\\work\\alpha",
      worktreeName: "wt-fix",
    };
    useProjectsStore.setState({ projects: [alpha], selectedProjectId: null, loaded: true });
    useThreadsStore.setState({ threads: [thread], activeThreadId: "th-1", loaded: true });

    render(<ChatHeader threadId="th-1" />);

    const alphaBadge = document.querySelector<HTMLElement>("[data-project-badge]");
    expect(alphaBadge).toBeTruthy();
    expect(alphaBadge!.style.color).toBe("rgb(52, 107, 241)");
    expect(alphaBadge!.style.backgroundColor).toContain("color-mix");
    expect(alphaBadge).toHaveClass("h-4", "w-4");
    expect(alphaBadge).not.toHaveClass("h-5", "w-5", "h-6", "w-6");
    expect(screen.getByText("Alpha")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Fix parser" })).toBeVisible();
    expect(screen.getByText(/worktree/i)).toBeVisible();
  });

  it("renders selected project badge and name with 'New thread' on /chat", () => {
    useProjectsStore.setState({ projects: [alpha], selectedProjectId: "alpha", loaded: true });

    render(<ChatHeader />);

    const alphaBadge = document.querySelector<HTMLElement>("[data-project-badge]");
    expect(alphaBadge).toBeTruthy();
    expect(alphaBadge!.style.color).toBe("rgb(52, 107, 241)");
    expect(alphaBadge!.style.backgroundColor).toContain("color-mix");
    expect(alphaBadge).toHaveClass("h-4", "w-4");
    expect(alphaBadge).not.toHaveClass("h-5", "w-5", "h-6", "w-6");
    expect(screen.getByText("Alpha")).toBeVisible();
    expect(screen.getByRole("heading", { name: "New thread" })).toBeVisible();
  });

  it("does not render workspace folder input or isolated worktree checkbox on /chat", () => {
    useProjectsStore.setState({ projects: [alpha], selectedProjectId: "alpha", loaded: true });

    render(<NewChatEmptyState />);

    expect(screen.queryByLabelText("Workspace folder for new threads")).toBeNull();
    expect(screen.queryByLabelText(/Isolated worktree/i)).toBeNull();
  });
});

describe("Composer /chat dispatch", () => {
  beforeEach(() => {
    navigate.mockReset().mockResolvedValue(undefined);
    threadsCreate.mockReset();
    runsDispatch.mockReset().mockResolvedValue(emptyOutcome);
    providersInstancesList.mockReset().mockResolvedValue([mockInstance]);
    useProjectsStore.setState({ projects: [], selectedProjectId: null, loaded: true });
    useThreadsStore.setState({ threads: [], activeThreadId: null, unreadIds: [], loaded: true });
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
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [mockInstance],
      paletteOpen: false,
    });
  });

  it("passes selected projectId, rootPath workspace, and non-worktree flag when strategy is 'root'", async () => {
    useProjectsStore.setState({ projects: [alpha], selectedProjectId: "alpha", loaded: true });
    threadsCreate.mockResolvedValue({
      id: "th-new",
      projectId: "alpha",
      title: "Hello Alpha",
      status: "draft",
      pinned: false,
      createdAt: 1,
      updatedAt: 1,
      workspace: "C:\\work\\alpha",
    });

    render(<Composer />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Hello Alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(threadsCreate).toHaveBeenCalledTimes(1));
    const [projectId, title, workspace, worktree] = threadsCreate.mock.calls[0];
    expect(projectId).toBe("alpha");
    expect(title).toBe("Hello Alpha");
    expect(workspace).toBe("C:\\work\\alpha");
    expect([false, null]).toContain(worktree);

    await waitFor(() =>
      expect(runsDispatch).toHaveBeenCalledWith("th-new", "Hello Alpha", "mock", [], null, null),
    );
  });

  it("passes worktree=true when selected project uses worktreeStrategy 'worktree'", async () => {
    useProjectsStore.setState({
      projects: [{ ...alpha, worktreeStrategy: "worktree" }],
      selectedProjectId: "alpha",
      loaded: true,
    });
    threadsCreate.mockResolvedValue({
      id: "th-wt",
      projectId: "alpha",
      title: "Start worktree run",
      status: "draft",
      pinned: false,
      createdAt: 1,
      updatedAt: 1,
      workspace: "C:\\work\\alpha",
    });

    render(<Composer />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Start worktree run" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(threadsCreate).toHaveBeenCalledTimes(1));
    const [projectId, title, workspace, worktree] = threadsCreate.mock.calls[0];
    expect(projectId).toBe("alpha");
    expect(title).toBe("Start worktree run");
    expect(workspace).toBe("C:\\work\\alpha");
    expect(worktree).toBe(true);

    await waitFor(() => expect(runsDispatch).toHaveBeenCalledTimes(1));
  });
});
