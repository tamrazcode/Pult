import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";

const {
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
import { useSettingsStore } from "../src/stores/settings";
import { useTerminalsStore } from "../src/stores/terminals";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

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
}

describe("RightPanel surfaces", () => {
  beforeEach(() => {
    settingsGet.mockReset().mockResolvedValue(null);
    settingsSet.mockReset().mockResolvedValue(undefined);
    terminalPtyList.mockReset().mockResolvedValue([]);

    useUiStore.setState({
      rightPanelOpen: true,
      rightPanelTab: "diff",
      instances: [],
      selectedInstanceId: null,
    });
    useProjectsStore.setState({ projects: [], selectedProjectId: null, loaded: true });
    useThreadsStore.setState({ threads: [], activeThreadId: null, unreadIds: [], loaded: true });
    useGitStore.setState({ byThread: {}, viewMode: "unified", ghAvailable: false, prHistory: [] });
    useTerminalsStore.setState({ byThread: {}, activeByThread: {} });
    useSettingsStore.setState({ preferredEditor: "zed" });
  });

  it("renders centered surface list with Browser, Terminal, Files, Diff, keeps Pull request disabled, and switches to Terminal", () => {
    seedAlphaProjectWithThread();
    useUiStore.setState({ rightPanelOpen: true, rightPanelTab: "none" });

    render(<RightPanel width={360} />);

    expect(screen.getByText("Open a surface")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Browser/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Terminal/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Files/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Diff/i })).toBeInTheDocument();

    const pullRequestItem = screen.getByRole("button", { name: /^Pull request/i });
    expect(pullRequestItem).toBeDisabled();
    fireEvent.click(pullRequestItem);
    expect(useUiStore.getState().rightPanelTab).toBe("none");

    fireEvent.click(screen.getByRole("button", { name: /^Terminal/i }));
    expect(useUiStore.getState().rightPanelTab).toBe("terminal");
  });
});
