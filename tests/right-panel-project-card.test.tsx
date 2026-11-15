import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";
import type { InstanceInfo } from "../src/lib/types";

const {
  openInEditor,
  gitStatus,
  gitDiffSummary,
  gitDiff,
  gitDiffFile,
  gitGhAvailable,
  settingsGet,
  settingsSet,
  terminalPtyCreate,
  terminalPtyList,
} = vi.hoisted(() => ({
  openInEditor: vi.fn(async () => undefined),
  gitStatus: vi.fn(async () => ({
    repoRoot: "C:\\work\\alpha",
    branch: "feat/ui",
    upstream: null,
    ahead: 0,
    behind: 0,
    entries: [],
  })),
  gitDiffSummary: vi.fn(async () => ({
    repoRoot: "C:\\work\\alpha",
    base: "HEAD",
    totalAdded: 14,
    totalRemoved: 3,
    files: [],
  })),
  gitDiff: vi.fn(async () => ({ repoRoot: "C:\\work\\alpha", base: "HEAD", raw: "", files: [] })),
  gitDiffFile: vi.fn(),
  gitGhAvailable: vi.fn(async () => false),
  settingsGet: vi.fn(async () => null),
  settingsSet: vi.fn(async () => undefined),
  terminalPtyCreate: vi.fn(),
  terminalPtyList: vi.fn(async () => []),
}));

vi.mock("../src/lib/tauri", () => ({
  isTauri: () => true,
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    openInEditor,
    gitStatus,
    gitDiffSummary,
    gitDiff,
    gitDiffFile,
    gitGhAvailable,
    settingsGet,
    settingsSet,
    terminalPtyCreate,
    terminalPtyList,
  };
});

import { RightPanel } from "../src/components/layout/RightPanel";
import { useGitStore } from "../src/stores/git";
import { useProjectsStore } from "../src/stores/projects";
import { useRunsStore } from "../src/stores/runs";
import { useTerminalsStore } from "../src/stores/terminals";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

function makeInstance(id: string, displayName: string): InstanceInfo {
  return {
    id,
    displayName,
    enabled: true,
    driver: id,
    command: id,
    args: [],
    env: {},
    status: "running",
    promptImage: false,
    loadSession: true,
    modes: [],
    configOptions: [],
    authMethods: [],
  };
}

function seedAlphaProjectWithThread() {
  useProjectsStore.setState({
    projects: [
      {
        id: "p1",
        name: "Alpha",
        rootPath: "C:\\work\\alpha",
        color: "#346bf1",
        worktreeStrategy: "root",
        pinned: false,
        createdAt: 100,
      },
    ],
    selectedProjectId: "p1",
    loaded: true,
  });

  useThreadsStore.setState({
    threads: [
      {
        id: "th",
        projectId: "p1",
        title: "UI parity",
        workspace: "C:\\work\\alpha",
        status: "working",
        pinned: false,
        createdAt: 100,
        updatedAt: 200,
      },
    ],
    activeThreadId: "th",
    unreadIds: [],
    loaded: true,
  });

  useGitStore.setState({
    byThread: {
      th: {
        status: {
          repoRoot: "C:\\work\\alpha",
          branch: "feat/ui",
          upstream: null,
          ahead: 0,
          behind: 0,
          entries: [],
        },
        diff: {
          repoRoot: "C:\\work\\alpha",
          base: "HEAD",
          totalAdded: 14,
          totalRemoved: 3,
          files: [],
        },
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
      },
    },
  });

  useRunsStore.setState({
    runsByThread: {
      th: [
        {
          id: "r1",
          threadId: "th",
          idx: 0,
          status: "finished",
          instanceId: "claude-code",
          startedAt: 10,
        },
        {
          id: "r2",
          threadId: "th",
          idx: 1,
          status: "failed",
          instanceId: "codex",
          startedAt: 20,
        },
      ],
    },
  });
}

describe("RightPanel ProjectCard & surfaces", () => {
  beforeEach(() => {
    openInEditor.mockClear();
    settingsGet.mockReset().mockResolvedValue(null);
    settingsSet.mockReset().mockResolvedValue(undefined);
    terminalPtyList.mockReset().mockResolvedValue([]);

    useUiStore.setState({
      rightPanelOpen: true,
      rightPanelTab: "diff",
      instances: [makeInstance("claude-code", "Claude Code"), makeInstance("codex", "Codex")],
      selectedInstanceId: "claude-code",
    });
    useProjectsStore.setState({ projects: [], selectedProjectId: null, loaded: true });
    useThreadsStore.setState({ threads: [], activeThreadId: null, unreadIds: [], loaded: true });
    useRunsStore.setState({
      runsByThread: {},
      viewsByRun: {},
      appliedEvents: {},
      commandsByThread: {},
      queueByThread: {},
      filesByThread: {},
    });
    useGitStore.setState({ byThread: {}, viewMode: "unified", ghAvailable: false, prHistory: [] });
    useTerminalsStore.setState({ byThread: {}, activeByThread: {} });
  });

  it("renders project name, branch, uncommitted +N -N, and previous agents with failed count", () => {
    seedAlphaProjectWithThread();

    render(<RightPanel width={360} />);

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getAllByText("feat/ui").length).toBeGreaterThan(0);
    expect(screen.getByText(/Uncommitted/i)).toBeInTheDocument();
    expect(screen.getByText("+14")).toBeInTheDocument();
    expect(screen.getByText("-3")).toBeInTheDocument();

    const prevHeading = screen.getByText(/Previous agents/i);
    const prevArea =
      prevHeading.closest("section") ??
      prevHeading.parentElement?.parentElement ??
      prevHeading.parentElement!;
    expect(prevArea.textContent).toMatch(/Claude Code|claude-code/i);
    expect(prevArea.textContent).toMatch(/Codex/i);
    expect(prevArea.textContent).toMatch(/1\s*failed/i);
  });

  it("calls openInEditor with workspace path when Open in editor is clicked", () => {
    seedAlphaProjectWithThread();

    render(<RightPanel width={360} />);

    fireEvent.click(screen.getByRole("button", { name: /Open in editor/i }));
    expect(openInEditor).toHaveBeenCalledWith("C:\\work\\alpha");
  });

  it("opens '+' surface menu with Files, Diff, Terminal (no dead entries) and switches to Terminal", () => {
    seedAlphaProjectWithThread();
    useUiStore.setState({ rightPanelOpen: false, rightPanelTab: "diff" });

    render(<RightPanel width={360} />);

    const addBtn = screen.getByRole("button", { name: "Open a surface" });
    fireEvent.click(addBtn);

    const menu = screen.getByRole("menu");
    expect(within(menu).getByText("Files")).toBeInTheDocument();
    expect(within(menu).getByText("Diff")).toBeInTheDocument();
    expect(within(menu).getByText("Terminal")).toBeInTheDocument();
    expect(within(menu).queryByText(/Pull requests/i)).toBeNull();
    expect(within(menu).queryByText(/Browser/i)).toBeNull();
    expect(within(menu).queryByText(/Device/i)).toBeNull();

    fireEvent.click(within(menu).getByText("Terminal"));
    expect(useUiStore.getState().rightPanelTab).toBe("terminal");
    expect(useUiStore.getState().rightPanelOpen).toBe(true);
  });

  it("falls back to projectsStore.selectedProjectId when no thread is active on /chat", () => {
    useProjectsStore.setState({
      projects: [
        {
          id: "p1",
          name: "Alpha",
          rootPath: "C:\\work\\alpha",
          color: "#346bf1",
          worktreeStrategy: "root",
          pinned: false,
          createdAt: 100,
        },
      ],
      selectedProjectId: "p1",
      loaded: true,
    });
    useThreadsStore.setState({ threads: [], activeThreadId: null, loaded: true });

    render(<RightPanel width={360} />);

    expect(screen.getByText("Alpha")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Open in editor/i }));
    expect(openInEditor).toHaveBeenCalledWith("C:\\work\\alpha");
  });
});
