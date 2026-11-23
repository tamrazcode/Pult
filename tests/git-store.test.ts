import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as IpcModule from "../src/lib/ipc";

const { gitGhAvailable, gitStatus, gitDiffSummary } = vi.hoisted(() => ({
  gitGhAvailable: vi.fn(async (): Promise<boolean> => true),
  gitStatus: vi.fn(async (): Promise<unknown> => ({})),
  gitDiffSummary: vi.fn(async (): Promise<unknown> => ({ base: null, files: [] })),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return { ...actual, gitGhAvailable, gitStatus, gitDiffSummary };
});

import { scheduleGitRefresh, useGitStore } from "../src/stores/git";
import { useThreadsStore } from "../src/stores/threads";

describe("git store gh availability", () => {
  beforeEach(() => {
    gitGhAvailable.mockReset().mockResolvedValue(true);
    useGitStore.setState({ ghAvailable: false, ghLoaded: false });
  });

  it("retries after a failed probe and caches the eventual success", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      gitGhAvailable.mockRejectedValueOnce(new Error("ipc down"));

      await useGitStore.getState().loadGhAvailability();
      expect(useGitStore.getState().ghLoaded).toBe(false);
      expect(useGitStore.getState().ghAvailable).toBe(false);

      await useGitStore.getState().loadGhAvailability();
      expect(gitGhAvailable).toHaveBeenCalledTimes(2);
      expect(useGitStore.getState().ghLoaded).toBe(true);
      expect(useGitStore.getState().ghAvailable).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("shares one in-flight probe between parallel callers", async () => {
    let resolveProbe: (available: boolean) => void = () => {};
    gitGhAvailable.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        resolveProbe = resolve;
      }),
    );

    const first = useGitStore.getState().loadGhAvailability();
    const second = useGitStore.getState().loadGhAvailability();
    expect(gitGhAvailable).toHaveBeenCalledTimes(1);

    resolveProbe(true);
    await Promise.all([first, second]);
    expect(useGitStore.getState().ghLoaded).toBe(true);
    expect(useGitStore.getState().ghAvailable).toBe(true);
  });
});

describe("git store thread cleanup", () => {
  beforeEach(() => {
    gitStatus.mockReset().mockResolvedValue({});
    gitDiffSummary.mockReset().mockResolvedValue({ base: null, files: [] });
    useGitStore.setState({ byThread: {} });
  });

  it("clearThread cancels that thread's queued refresh and leaves others queued", async () => {
    vi.useFakeTimers();
    try {
      scheduleGitRefresh("a", 100);
      scheduleGitRefresh("b", 100);

      useGitStore.getState().clearThread("a");
      await vi.advanceTimersByTimeAsync(200);

      expect(gitStatus).not.toHaveBeenCalledWith("a");
      expect(gitStatus).toHaveBeenCalledWith("b");
    } finally {
      vi.useRealTimers();
    }
  });

  it("removeThread cancels the deleted thread's pending refresh", async () => {
    vi.useFakeTimers();
    try {
      scheduleGitRefresh("a", 100);
      useThreadsStore.setState({ threads: [], activeThreadId: null, loaded: true });

      useThreadsStore.getState().removeThread("a");
      await vi.advanceTimersByTimeAsync(200);

      expect(gitStatus).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
