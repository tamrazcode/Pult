import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";
import type { WorkspaceTree } from "../src/lib/ipc";

const { openInEditor, workspaceTree, workspaceReadText, readImageDataUrl } = vi.hoisted(() => ({
  openInEditor: vi.fn(async () => undefined),
  workspaceTree: vi.fn(),
  workspaceReadText: vi.fn(async () => "const x = 1;"),
  readImageDataUrl: vi.fn(async () => ""),
}));

vi.mock("../src/lib/tauri", () => ({ isTauri: () => true }));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return { ...actual, openInEditor, workspaceTree, workspaceReadText, readImageDataUrl };
});

import { FilesPanel } from "../src/components/files/FilesPanel";
import { buildFileGitStatusMap, classifyGitEntry } from "../src/lib/fileGitStatus";
import { useGitStore } from "../src/stores/git";
import { useProjectsStore } from "../src/stores/projects";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

const baseEntries = [
  { path: "src", name: "src", isDir: true, size: 0 },
  { path: "src/app.ts", name: "app.ts", isDir: false, size: 10 },
];

function tree(entries = baseEntries, truncated = false): WorkspaceTree {
  return { entries, truncated };
}

function seedStores() {
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
  useUiStore.setState({ filePreview: null });
}

function seedGit(entries: Array<{ path: string; indexStatus: string; worktreeStatus: string }>) {
  useGitStore.setState({
    byThread: {
      th: {
        status: {
          repoRoot: "C:\\work\\alpha",
          branch: "main",
          upstream: null,
          ahead: 0,
          behind: 0,
          entries,
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
      },
    },
  });
}

describe("file git status", () => {
  it("classifies M/A/D/R/U/? entries and propagates highest priority to folders", () => {
    const code = (indexStatus: string, worktreeStatus: string) =>
      classifyGitEntry({ path: "x", indexStatus, worktreeStatus });

    expect(code(" ", "M")).toBe("M");
    expect(code("A", " ")).toBe("A");
    expect(code("C", " ")).toBe("A");
    expect(code("D", " ")).toBe("D");
    expect(code("R", " ")).toBe("R");
    expect(code("U", "U")).toBe("U");
    expect(code("A", "U")).toBe("U");
    expect(code("?", "?")).toBe("?");
    expect(code(" ", " ")).toBeNull();

    const map = buildFileGitStatusMap({
      repoRoot: "C:\\work\\alpha",
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      entries: [
        { path: "src/a.ts", indexStatus: " ", worktreeStatus: "M" },
        { path: "src/sub/b.ts", indexStatus: "?", worktreeStatus: "?" },
        { path: "src/sub/c.ts", indexStatus: "U", worktreeStatus: "U" },
        { path: "docs/gone.md", indexStatus: "D", worktreeStatus: " " },
      ],
    });

    expect(map.get("src/a.ts")?.code).toBe("M");
    expect(map.get("src/sub")?.code).toBe("U");
    expect(map.get("src")?.code).toBe("U");
    expect(map.get("docs")?.code).toBe("D");
  });
});

describe("FilesPanel polish", () => {
  beforeEach(() => {
    openInEditor.mockClear();
    workspaceTree.mockReset();
    workspaceTree.mockResolvedValue(tree());
    workspaceReadText.mockClear();
    readImageDataUrl.mockClear();
    seedStores();
    useGitStore.setState({ byThread: {} });
  });

  it("renders git status badges on file and folder rows from useGitStore", async () => {
    workspaceTree.mockResolvedValue(
      tree([
        { path: "src", name: "src", isDir: true, size: 0 },
        { path: "src/a.ts", name: "a.ts", isDir: false, size: 1 },
        { path: "src/new.ts", name: "new.ts", isDir: false, size: 1 },
        { path: "src/old.ts", name: "old.ts", isDir: false, size: 1 },
        { path: "src/loose.ts", name: "loose.ts", isDir: false, size: 1 },
        { path: "src/sub", name: "sub", isDir: true, size: 0 },
        { path: "src/sub/conflict.ts", name: "conflict.ts", isDir: false, size: 1 },
        { path: "docs", name: "docs", isDir: true, size: 0 },
        { path: "docs/gone.md", name: "gone.md", isDir: false, size: 1 },
      ]),
    );
    seedGit([
      { path: "src/a.ts", indexStatus: " ", worktreeStatus: "M" },
      { path: "src/new.ts", indexStatus: "A", worktreeStatus: " " },
      { path: "src/old.ts", indexStatus: "R", worktreeStatus: " " },
      { path: "src/loose.ts", indexStatus: "?", worktreeStatus: "?" },
      { path: "src/sub/conflict.ts", indexStatus: "U", worktreeStatus: "U" },
      { path: "docs/gone.md", indexStatus: "D", worktreeStatus: " " },
    ]);

    const { container } = render(<FilesPanel threadId="th" />);
    await screen.findByText("a.ts");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh files" })).not.toBeDisabled(),
    );

    const badgeFor = (path: string) =>
      container
        .querySelector(`button[title="${path}"] [data-git-status]`)
        ?.getAttribute("data-git-status");

    expect(badgeFor("src/a.ts")).toBe("M");
    expect(badgeFor("src/new.ts")).toBe("A");
    expect(badgeFor("src/old.ts")).toBe("R");
    expect(badgeFor("src/loose.ts")).toBe("?");
    expect(badgeFor("src/sub/conflict.ts")).toBe("U");
    expect(badgeFor("src/sub")).toBe("U");
    expect(badgeFor("src")).toBe("U");
    expect(badgeFor("docs/gone.md")).toBe("D");
    expect(badgeFor("docs")).toBe("D");
    expect(workspaceReadText).not.toHaveBeenCalled();
  });

  it("refreshes workspaceTree on button click without remounting or clearing preview", async () => {
    useUiStore.setState({ filePreview: "src/app.ts" });
    render(<FilesPanel threadId="th" />);
    await screen.findByText("const x = 1;");
    await screen.findByText("app.ts");
    const button = screen.getByRole("button", { name: "Refresh files" });
    await waitFor(() => expect(button).not.toBeDisabled());

    let resolveSecond!: (value: WorkspaceTree) => void;
    const second = new Promise<WorkspaceTree>((resolve) => {
      resolveSecond = resolve;
    });
    workspaceTree.mockReturnValueOnce(second);

    fireEvent.click(button);

    expect(button).toBeDisabled();
    expect(button.querySelector("svg")?.getAttribute("class")).toContain("animate-spin");
    expect(screen.getByText("const x = 1;")).toBeInTheDocument();

    resolveSecond(
      tree([...baseEntries, { path: "src/added.ts", name: "added.ts", isDir: false, size: 1 }]),
    );

    await screen.findByText("added.ts");
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(workspaceTree).toHaveBeenCalledTimes(2);
    expect(workspaceReadText).toHaveBeenCalledTimes(1);
    expect(screen.getByText("const x = 1;")).toBeInTheDocument();
    expect(useUiStore.getState().filePreview).toBe("src/app.ts");
  });

  it("shows a one-line notice only when workspaceTree reports truncated: true", async () => {
    workspaceTree.mockResolvedValue(tree(baseEntries, true));
    const firstRender = render(<FilesPanel threadId="th" />);
    const notice = await screen.findByRole("status");
    expect(notice).toHaveAttribute("data-truncated-notice");
    expect(notice).toHaveTextContent("Showing first 2,000 entries (depth 6)");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh files" })).not.toBeDisabled(),
    );
    firstRender.unmount();

    workspaceTree.mockResolvedValue(tree(baseEntries, false));
    const secondRender = render(<FilesPanel threadId="th" />);
    await screen.findByText("app.ts");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Refresh files" })).not.toBeDisabled(),
    );
    expect(secondRender.container.querySelector("[data-truncated-notice]")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(workspaceReadText).not.toHaveBeenCalled();
  });
});
