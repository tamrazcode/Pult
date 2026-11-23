import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";
import type { Project, Run, Thread, WorktreeDirtyStatus } from "../src/lib/types";

const {
  navigate,
  historyBack,
  historyForward,
  threadsList,
  threadsWorktreeStatus,
  threadsDelete,
  projectsList,
  providersInstancesList,
  settingsGet,
  runsCancel,
} = vi.hoisted(() => ({
  navigate: vi.fn(),
  historyBack: vi.fn(),
  historyForward: vi.fn(),
  threadsList: vi.fn(async (): Promise<Thread[]> => []),
  threadsWorktreeStatus: vi.fn(async (): Promise<WorktreeDirtyStatus | null> => ({
    dirty: true,
    modified: 0,
    untracked: 1,
    entries: ["draft.txt"],
  })),
  threadsDelete: vi.fn(async () => undefined),
  projectsList: vi.fn(async (): Promise<Project[]> => []),
  providersInstancesList: vi.fn(async () => []),
  settingsGet: vi.fn(async (): Promise<unknown> => null),
  runsCancel: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/tauri", () => ({
  isTauri: () => true,
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    threadsList,
    threadsWorktreeStatus,
    threadsDelete,
    projectsList,
    providersInstancesList,
    settingsGet,
    runsCancel,
    onThreadUpdate: vi.fn(async () => () => {}),
    onAgentProcess: vi.fn(async () => () => {}),
  };
});

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    navigate,
    history: {
      back: historyBack,
      forward: historyForward,
      canGoBack: () => false,
    },
  }),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/chat" } }),
}));

import { Sidebar } from "../src/components/layout/Sidebar";
import { useProjectsStore } from "../src/stores/projects";
import { useRunsStore } from "../src/stores/runs";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

const project: Project = {
  id: "p1",
  name: "Alpha",
  rootPath: "C:\\work\\alpha",
  color: "#346bf1",
  worktreeStrategy: "worktree",
  pinned: false,
  createdAt: 100,
};

const dirtyThread: Thread = {
  id: "t1",
  projectId: "p1",
  title: "Draft feature",
  status: "draft",
  pinned: false,
  createdAt: 100,
  updatedAt: 400,
  workspace: "C:\\work\\alpha\\.pult\\wt-1",
  mainRepo: "C:\\work\\alpha",
  worktreeName: "wt-1",
};

describe("Sidebar dirty worktree delete confirmation", () => {
  beforeEach(() => {
    navigate.mockReset().mockResolvedValue(undefined);
    historyBack.mockReset();
    historyForward.mockReset();
    projectsList.mockReset().mockResolvedValue([project]);
    threadsList.mockReset().mockResolvedValue([dirtyThread]);
    threadsWorktreeStatus.mockReset().mockResolvedValue({
      dirty: true,
      modified: 0,
      untracked: 1,
      entries: ["draft.txt"],
    });
    threadsDelete.mockReset().mockResolvedValue(undefined);
    providersInstancesList.mockReset().mockResolvedValue([]);
    settingsGet.mockReset().mockResolvedValue(null);
    runsCancel.mockReset().mockResolvedValue(undefined);

    useProjectsStore.setState({
      projects: [project],
      selectedProjectId: null,
      loaded: true,
    });
    useThreadsStore.setState({
      threads: [dirtyThread],
      activeThreadId: null,
      loaded: true,
      unreadIds: [],
    });
    useUiStore.setState({
      instances: [],
      selectedInstanceId: null,
      collapsedProjects: [],
      paletteOpen: false,
    });
    useRunsStore.setState({
      runsByThread: {},
      viewsByRun: {},
      appliedEvents: {},
      commandsByThread: {},
      queueByThread: {},
      activeElicitation: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops the thread's run state when the thread is removed", () => {
    const run: Run = {
      id: "r1",
      threadId: "t1",
      idx: 0,
      status: "finished",
      instanceId: "mock",
      startedAt: 0,
    };
    useRunsStore.getState().registerRun(run);
    expect(useRunsStore.getState().runsByThread["t1"]).toHaveLength(1);

    useThreadsStore.getState().removeThread("t1");

    expect(useRunsStore.getState().runsByThread["t1"]).toBeUndefined();
    expect(useRunsStore.getState().viewsByRun["r1"]).toBeUndefined();
  });

  it("shows workspace path and dirty entries, supports keep and force_remove, and cancels without deleting", async () => {
    render(<Sidebar width={288} />);

    fireEvent.contextMenu(screen.getByText("Draft feature"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog", { name: "Delete thread" });
    expect(within(dialog).getByText(dirtyThread.workspace!)).toBeInTheDocument();
    expect(within(dialog).getByText("draft.txt")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Delete thread" })).toBeNull();
    expect(threadsDelete).not.toHaveBeenCalled();

    fireEvent.contextMenu(screen.getByText("Draft feature"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    const keepDialog = await screen.findByRole("dialog", { name: "Delete thread" });
    fireEvent.click(
      within(keepDialog).getByRole("button", { name: "Delete thread & keep worktree files" }),
    );
    await waitFor(() => expect(threadsDelete).toHaveBeenCalledWith("t1", "keep"));

    useThreadsStore.setState({ threads: [dirtyThread] });
    fireEvent.contextMenu(await screen.findByText("Draft feature"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    const discardDialog = await screen.findByRole("dialog", { name: "Delete thread" });
    fireEvent.click(
      within(discardDialog).getByRole("button", { name: /Delete thread & discard/i }),
    );
    await waitFor(() => expect(threadsDelete).toHaveBeenCalledWith("t1", "force_remove"));
  });
});
