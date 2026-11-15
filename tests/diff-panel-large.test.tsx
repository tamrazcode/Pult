import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";
import type { DiffFileSummary } from "../src/lib/types";
import type { GitThreadState } from "../src/stores/git";

const { gitStatus, gitDiffSummary, gitDiffFile } = vi.hoisted(() => ({
  gitStatus: vi.fn(async () => ({
    repoRoot: "/repo",
    branch: "main",
    ahead: 0,
    behind: 0,
    entries: [],
  })),
  gitDiffSummary: vi.fn(),
  gitDiffFile: vi.fn(),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return { ...actual, gitStatus, gitDiffSummary, gitDiffFile };
});

import { DiffPanel } from "../src/components/diff/DiffPanel";
import { useGitStore } from "../src/stores/git";

function summaryFiles(count: number): DiffFileSummary[] {
  return Array.from({ length: count }, (_, index) => {
    const dir = `dir-${String(Math.floor(index / 20)).padStart(2, "0")}`;
    const file = `file-${String(index % 20).padStart(2, "0")}.ts`;
    return {
      path: `${dir}/${file}`,
      oldPath: `${dir}/${file}`,
      added: 1,
      removed: 1,
      binary: false,
      status: "modified",
      patchHash: `hash-${index}`,
    };
  });
}

function bigState(): GitThreadState {
  return {
    status: { repoRoot: "/repo", branch: "main", upstream: null, ahead: 0, behind: 0, entries: [] },
    diff: {
      repoRoot: "/repo",
      base: "HEAD",
      totalAdded: 4000,
      totalRemoved: 2000,
      files: summaryFiles(2000),
    },
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
    filePatches: {},
  };
}

describe("DiffPanel large diff virtualization", () => {
  beforeEach(() => {
    gitDiffFile.mockReset().mockResolvedValue({
      path: "dir-00/file-00.ts",
      raw: "diff --git a/a b/a\n@@ -1 +1 @@\n-old\n+new\n",
      added: 1,
      removed: 1,
      binary: false,
      status: "modified",
    });
    useGitStore.setState({ byThread: { "th-big": bigState() }, viewMode: "unified" });
  });

  it("mounts only visible rows and loads one patch on expand", async () => {
    const { container } = render(<DiffPanel threadId="th-big" />);

    expect(screen.getByText("0/2000 reviewed")).toBeTruthy();
    expect(
      container.querySelectorAll("[data-diff-file-row],[data-diff-dir-row]").length,
    ).toBeLessThan(100);

    fireEvent.click(screen.getByText("dir-00"));
    fireEvent.click(await screen.findByRole("button", { name: /dir-00\/file-00\.ts/ }));

    await waitFor(() =>
      expect(gitDiffFile).toHaveBeenCalledWith("th-big", "dir-00/file-00.ts", "HEAD"),
    );
    expect(await screen.findByText("new")).toBeTruthy();
    expect(gitDiffFile).toHaveBeenCalledTimes(1);
  });
});
