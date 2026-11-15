import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";

const { openInEditor, gitCommit, gitPush } = vi.hoisted(() => ({
  openInEditor: vi.fn(async () => undefined),
  gitCommit: vi.fn(async () => ({ sha: "abc1234", summary: "feat: wip" })),
  gitPush: vi.fn(async () => ({ remote: "origin", branch: "feat/ui" })),
}));

vi.mock("../src/lib/tauri", () => ({
  isTauri: () => true,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(async () => undefined),
    toggleMaximize: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    isMaximized: vi.fn(async () => false),
    onResized: vi.fn(async () => () => {}),
  }),
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    navigate: vi.fn(async () => undefined),
  }),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    openInEditor,
    gitCommit,
    gitPush,
    workspaceFiles: vi.fn(async () => []),
    onThreadUpdate: vi.fn(async () => () => {}),
    onAgentProcess: vi.fn(async () => () => {}),
  };
});

import { ChatColumn } from "../src/components/chat/ChatColumn";
import { useGitStore } from "../src/stores/git";
import { useProjectsStore } from "../src/stores/projects";
import { useRunsStore } from "../src/stores/runs";
import { useSettingsStore } from "../src/stores/settings";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

function seedThreadWithChanges() {
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
        title: "Widget thread",
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
          entries: [{ path: "src/App.tsx", indexStatus: " ", worktreeStatus: "M" }],
        },
        diff: {
          repoRoot: "C:\\work\\alpha",
          base: "HEAD",
          totalAdded: 14,
          totalRemoved: 3,
          files: [
            {
              path: "src/App.tsx",
              status: "modified",
              added: 14,
              removed: 3,
              binary: false,
              patchHash: "h1",
            },
          ],
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
}

describe("Floating ProjectInfoWidget", () => {
  beforeEach(() => {
    openInEditor.mockClear();
    gitCommit.mockClear();
    gitPush.mockClear();

    useUiStore.setState({
      sidebarOpen: true,
      rightPanelOpen: false,
      rightPanelTab: "diff",
      instances: [],
      selectedInstanceId: null,
      ...(useUiStore.getState() as unknown as Record<string, unknown>),
    });
    if ("setProjectWidgetOpen" in useUiStore.getState()) {
      (
        useUiStore.getState() as unknown as { setProjectWidgetOpen: (open: boolean) => void }
      ).setProjectWidgetOpen(true);
    }
    useSettingsStore.setState({ preferredEditor: "zed" });
    useRunsStore.setState({
      runsByThread: {},
      viewsByRun: {},
      appliedEvents: {},
      commandsByThread: {},
      queueByThread: {},
      filesByThread: {},
      activeElicitation: null,
    });
    seedThreadWithChanges();
  });

  it("renders floating widget by default in ChatColumn with project info and no diff viewer", () => {
    expect(
      (useUiStore.getState() as unknown as { projectWidgetOpen?: boolean }).projectWidgetOpen,
    ).toBe(true);

    render(<ChatColumn title="Widget thread" threadId="th" />);

    expect(screen.getByRole("button", { name: /Open in Zed/i })).toBeInTheDocument();
    expect(screen.getByText("feat/ui")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Commit & push/i })).toBeInTheDocument();

    const changesBtn = screen.getByRole("button", { name: /Changes/i });
    expect(changesBtn).toHaveTextContent("+14");
    expect(changesBtn).toHaveTextContent("-3");

    // No embedded diff viewer inside the floating widget
    expect(screen.queryByText("src/App.tsx")).toBeNull();
    expect(screen.queryByRole("button", { name: /Unified/i })).toBeNull();
  });

  it("opens right panel diff and hides widget when Changes is clicked, and restores widget when right panel closes", () => {
    render(<ChatColumn title="Widget thread" threadId="th" />);

    fireEvent.click(screen.getByRole("button", { name: /Changes/i }));
    expect(useUiStore.getState().rightPanelOpen).toBe(true);
    expect(useUiStore.getState().rightPanelTab).toBe("diff");
    expect(screen.queryByRole("button", { name: /Commit & push/i })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Toggle right panel" }));
    expect(useUiStore.getState().rightPanelOpen).toBe(false);
    expect(screen.getByRole("button", { name: /Commit & push/i })).toBeInTheDocument();
  });

  it("toggles widget independently via header Toggle project info button without changing rightPanelOpen", () => {
    render(<ChatColumn title="Widget thread" threadId="th" />);

    const toggleBtn = screen.getByRole("button", { name: "Toggle project info" });
    expect(useUiStore.getState().rightPanelOpen).toBe(false);

    fireEvent.click(toggleBtn);
    expect(
      (useUiStore.getState() as unknown as { projectWidgetOpen?: boolean }).projectWidgetOpen,
    ).toBe(false);
    expect(useUiStore.getState().rightPanelOpen).toBe(false);
    expect(screen.queryByRole("button", { name: /Commit & push/i })).toBeNull();

    fireEvent.click(toggleBtn);
    expect(
      (useUiStore.getState() as unknown as { projectWidgetOpen?: boolean }).projectWidgetOpen,
    ).toBe(true);
    expect(useUiStore.getState().rightPanelOpen).toBe(false);
    expect(screen.getByRole("button", { name: /Commit & push/i })).toBeInTheDocument();
  });

  it("does not clip the editor dropdown with overflow-hidden on the widget root aside", () => {
    render(<ChatColumn title="Widget thread" threadId="th" />);

    const aside = screen.getByRole("complementary", { name: "Project info" });
    expect(aside).not.toHaveClass("overflow-hidden");

    fireEvent.click(screen.getByRole("button", { name: "Choose editor" }));
    expect(screen.getByRole("menu", { name: "Editor" })).toBeInTheDocument();
  });
});
