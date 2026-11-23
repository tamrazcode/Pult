import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";
import type { GitThreadState } from "../src/stores/git";

const {
  gitCheckpointsList,
  gitCheckpointDiff,
  gitCheckpointDiffFile,
  gitCheckpointRestore,
  gitStatus,
  gitDiffSummary,
  gitGhAvailable,
} = vi.hoisted(() => ({
  gitCheckpointsList: vi.fn(async (): Promise<string[]> => []),
  gitCheckpointDiff: vi.fn(async () => ({
    repoRoot: "/repo",
    base: "r1",
    totalAdded: 3,
    totalRemoved: 1,
    files: [],
  })),
  gitCheckpointDiffFile: vi.fn(async () => ({
    path: "src/a.ts",
    raw: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
    added: 1,
    removed: 1,
    binary: false,
    status: "modified",
  })),
  gitCheckpointRestore: vi.fn(async (): Promise<void> => undefined),
  gitStatus: vi.fn(async () => ({
    repoRoot: "/repo",
    branch: "main",
    upstream: null,
    ahead: 0,
    behind: 0,
    entries: [],
  })),
  gitDiffSummary: vi.fn(async () => ({
    repoRoot: "/repo",
    base: "HEAD",
    totalAdded: 0,
    totalRemoved: 1,
    files: [
      {
        path: "src/a.ts",
        added: 0,
        removed: 1,
        binary: false,
        status: "modified",
        patchHash: "h1",
      },
    ],
  })),
  gitGhAvailable: vi.fn(async (): Promise<boolean> => false),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    gitCheckpointsList,
    gitCheckpointDiff,
    gitCheckpointDiffFile,
    gitCheckpointRestore,
    gitStatus,
    gitDiffSummary,
    gitGhAvailable,
  };
});

import { DiffPanel } from "../src/components/diff/DiffPanel";
import { useGitStore } from "../src/stores/git";

function worktreeState(over: Partial<GitThreadState> = {}): GitThreadState {
  return {
    status: {
      repoRoot: "/repo",
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      entries: [],
    },
    diff: { repoRoot: "/repo", base: "HEAD", totalAdded: 0, totalRemoved: 1, files: [] },
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
    ...over,
  };
}

const THREAD = "th";

describe("git checkpoint store", () => {
  beforeEach(() => {
    gitCheckpointsList.mockReset().mockResolvedValue(["r1", "r2"]);
    gitCheckpointDiff.mockReset().mockResolvedValue({
      repoRoot: "/repo",
      base: "r1",
      totalAdded: 3,
      totalRemoved: 1,
      files: [],
    });
    gitCheckpointDiffFile.mockReset();
    gitCheckpointRestore.mockReset().mockResolvedValue(undefined);
    gitStatus.mockReset().mockResolvedValue({
      repoRoot: "/repo",
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      entries: [],
    });
    gitDiffSummary.mockReset().mockResolvedValue({
      repoRoot: "/repo",
      base: "HEAD",
      totalAdded: 0,
      totalRemoved: 1,
      files: [],
    });
    useGitStore.setState({
      byThread: { [THREAD]: worktreeState({ checkpoints: ["r1", "r2"] }) },
      viewMode: "unified",
      ghAvailable: false,
      ghLoaded: true,
    });
  });

  it("loadCheckpoints stores the ordered run ids", async () => {
    useGitStore.setState({ byThread: { [THREAD]: worktreeState() } });

    await useGitStore.getState().loadCheckpoints(THREAD);

    expect(gitCheckpointsList).toHaveBeenCalledWith(THREAD);
    expect(useGitStore.getState().byThread[THREAD]?.checkpoints).toEqual(["r1", "r2"]);
  });

  it("keeps the list when the backend refuses (not a repo)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      gitCheckpointsList.mockRejectedValueOnce(new Error("git.not_a_repo"));
      await useGitStore.getState().loadCheckpoints(THREAD);
      expect(useGitStore.getState().byThread[THREAD]?.checkpoints).toEqual(["r1", "r2"]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("viewCheckpointDiff diffs against the parent run and clears loading", async () => {
    await useGitStore.getState().viewCheckpointDiff(THREAD, "r2");

    expect(gitCheckpointDiff).toHaveBeenCalledWith(THREAD, "r2", "r1");
    const active = useGitStore.getState().byThread[THREAD]?.activeCheckpoint;
    expect(active?.runId).toBe("r2");
    expect(active?.loading).toBe(false);
    expect(active?.diff.totalAdded).toBe(3);
  });

  it("the first checkpoint diffs against the parent commit", async () => {
    await useGitStore.getState().viewCheckpointDiff(THREAD, "r1");

    expect(gitCheckpointDiff).toHaveBeenCalledWith(THREAD, "r1", null);
  });

  it("viewCheckpointDiff reports a failure without dropping the view", async () => {
    gitCheckpointDiff.mockRejectedValueOnce(new Error("diff failed"));

    await useGitStore.getState().viewCheckpointDiff(THREAD, "r2");

    const active = useGitStore.getState().byThread[THREAD]?.activeCheckpoint;
    expect(active?.loading).toBe(false);
    expect(active?.error).toBe("diff failed");
  });

  it("loadCheckpointFileDiff caches a patch and skips a second load", async () => {
    await useGitStore.getState().viewCheckpointDiff(THREAD, "r2");

    await useGitStore.getState().loadCheckpointFileDiff(THREAD, "r2", "src/a.ts");
    await useGitStore.getState().loadCheckpointFileDiff(THREAD, "r2", "src/a.ts");

    expect(gitCheckpointDiffFile).toHaveBeenCalledTimes(1);
    expect(gitCheckpointDiffFile).toHaveBeenCalledWith(THREAD, "r2", "src/a.ts", "r1");
    const patch =
      useGitStore.getState().byThread[THREAD]?.activeCheckpoint?.filePatches["src/a.ts"];
    expect(patch?.file?.path).toBe("src/a.ts");
  });

  it("clearCheckpointView returns to the worktree diff", async () => {
    await useGitStore.getState().viewCheckpointDiff(THREAD, "r2");

    useGitStore.getState().clearCheckpointView(THREAD);

    expect(useGitStore.getState().byThread[THREAD]?.activeCheckpoint).toBeNull();
  });

  it("refresh preserves the checkpoint view and the restore marker", async () => {
    useGitStore.setState({
      byThread: {
        [THREAD]: worktreeState({
          checkpoints: ["r1", "r2"],
          restoringCheckpoint: "r2",
          activeCheckpoint: {
            runId: "r2",
            diff: { repoRoot: "/repo", base: "r1", totalAdded: 0, totalRemoved: 0, files: [] },
            filePatches: {},
            loading: false,
            error: null,
          },
        }),
      },
    });

    await useGitStore.getState().refresh(THREAD);

    const state = useGitStore.getState().byThread[THREAD];
    expect(state?.checkpoints).toEqual(["r1", "r2"]);
    expect(state?.activeCheckpoint?.runId).toBe("r2");
    expect(state?.restoringCheckpoint).toBe("r2");
  });

  it("restoreCheckpoint rolls back, refreshes and leaves the checkpoint view", async () => {
    await useGitStore.getState().viewCheckpointDiff(THREAD, "r2");

    const ok = await useGitStore.getState().restoreCheckpoint(THREAD, "r2");

    expect(ok).toBe(true);
    expect(gitCheckpointRestore).toHaveBeenCalledWith(THREAD, "r2");
    const state = useGitStore.getState().byThread[THREAD];
    expect(state?.restoringCheckpoint).toBeNull();
    expect(state?.activeCheckpoint).toBeNull();
    expect(gitStatus).toHaveBeenCalledWith(THREAD);
    expect(gitCheckpointsList).toHaveBeenCalledWith(THREAD);
  });

  it("restoreCheckpoint surfaces a failure and keeps the view", async () => {
    await useGitStore.getState().viewCheckpointDiff(THREAD, "r2");
    gitCheckpointRestore.mockRejectedValueOnce(new Error("restore failed"));

    const ok = await useGitStore.getState().restoreCheckpoint(THREAD, "r2");

    expect(ok).toBe(false);
    const state = useGitStore.getState().byThread[THREAD];
    expect(state?.restoringCheckpoint).toBeNull();
    expect(state?.error).toBe("restore failed");
    expect(state?.activeCheckpoint?.runId).toBe("r2");
  });
});

describe("DiffPanel checkpoint banner", () => {
  beforeEach(() => {
    useGitStore.setState({
      byThread: {
        [THREAD]: worktreeState({
          checkpoints: ["r1", "run-abcdefgh"],
          activeCheckpoint: {
            runId: "run-abcdefgh",
            diff: {
              repoRoot: "/repo",
              base: "r1",
              totalAdded: 2,
              totalRemoved: 1,
              files: [
                {
                  path: "src/a.ts",
                  added: 2,
                  removed: 1,
                  binary: false,
                  status: "modified",
                  patchHash: "h1",
                },
              ],
            },
            filePatches: {},
            loading: false,
            error: null,
          },
        }),
      },
      viewMode: "unified",
      ghAvailable: false,
      ghLoaded: true,
    });
  });

  it("shows the checkpoint banner instead of the commit bar", () => {
    render(createElement(DiffPanel, { threadId: THREAD }));

    expect(screen.getByText("Viewing turn checkpoint run-abcd")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Commit message…")).toBeNull();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
  });

  it("returns to the worktree diff from the banner", async () => {
    render(createElement(DiffPanel, { threadId: THREAD }));

    fireEvent.click(screen.getByRole("button", { name: "Back to working tree" }));

    await waitFor(() =>
      expect(useGitStore.getState().byThread[THREAD]?.activeCheckpoint).toBeNull(),
    );
    expect(screen.queryByText("Viewing turn checkpoint run-abcd")).toBeNull();
    expect(screen.getByPlaceholderText("Commit message…")).toBeTruthy();
  });

  it("loads checkpoint patches when a historical file expands", async () => {
    gitCheckpointDiffFile.mockResolvedValueOnce({
      path: "src/a.ts",
      raw: "diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      added: 1,
      removed: 1,
      binary: false,
      status: "modified",
    });
    render(createElement(DiffPanel, { threadId: THREAD }));

    fireEvent.click(screen.getByRole("button", { name: /src\/a\.ts/ }));

    await waitFor(() =>
      expect(gitCheckpointDiffFile).toHaveBeenCalledWith(THREAD, "run-abcdefgh", "src/a.ts", "r1"),
    );
    expect(await screen.findByText("new")).toBeTruthy();
  });
});
