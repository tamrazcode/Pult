import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Run, ThreadDetail } from "../src/lib/types";

const threadsGet = vi.fn();

vi.mock("../src/lib/ipc", () => ({ threadsGet: (...args: unknown[]) => threadsGet(...args) }));

import { loadThread } from "../src/lib/threadLoad";
import { useRunsStore } from "../src/stores/runs";
import { useThreadsStore } from "../src/stores/threads";

const run = (id: string, threadId: string, status: Run["status"]): Run => ({
  id,
  threadId,
  idx: 0,
  status,
  instanceId: "mock",
  startedAt: 0,
});

describe("loadThread", () => {
  beforeEach(() => {
    useRunsStore.setState({
      runsByThread: {},
      viewsByRun: {},
      appliedEvents: {},
      commandsByThread: {},
      queueByThread: {},
    });
    useThreadsStore.setState({ threads: [] });
  });

  it("passes activeRunId through so a live run keeps streaming", async () => {
    const detail: ThreadDetail = {
      thread: {
        id: "th",
        projectId: null,
        title: "live",
        status: "working",
        pinned: false,
        createdAt: 0,
        updatedAt: 0,
      },
      runs: [run("r1", "th", "running")],
      events: [],
      queue: [],
      activeRunId: "r1",
    };
    threadsGet.mockResolvedValue(detail);

    await loadThread("th");

    expect(useRunsStore.getState().runsByThread["th"][0].status).toBe("running");
    expect(useRunsStore.getState().viewsByRun["r1"].streaming).toBe(true);
  });
});
