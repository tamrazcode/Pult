import { beforeEach, describe, expect, it } from "vitest";
import { useRunsStore } from "../src/stores/runs";
import type { AppEvent, Run } from "../src/lib/types";

const run: Run = {
  id: "r1",
  threadId: "th",
  idx: 0,
  status: "running",
  instanceId: "mock",
  startedAt: 0,
};

const delta = (seq: number, text: string): AppEvent => ({
  id: `e-${seq}`,
  runId: "r1",
  seq,
  ts: seq,
  kind: "agent_message_delta",
  payload: { delta: text },
});

const finished = (seq: number): AppEvent => ({
  id: `e-${seq}`,
  runId: "r1",
  seq,
  ts: seq,
  kind: "run_finished",
  payload: { stopReason: "end_turn" },
});

beforeEach(() => {
  useRunsStore.setState({
    runsByThread: {},
    viewsByRun: {},
    appliedEvents: {},
    commandsByThread: {},
    queueByThread: {},
  });
});

describe("RunView suggestedCommit", () => {
  it("stays undefined while streaming and populates on run_finished", () => {
    const store = useRunsStore.getState();
    store.registerRun(run);

    store.receiveRunEvent(
      "r1",
      delta(0, "Summary of changes.\nSuggested commit message: fix: thing"),
    );
    expect(useRunsStore.getState().viewsByRun["r1"]?.suggestedCommit).toBeUndefined();

    store.receiveRunEvent("r1", delta(1, "\nDone."));
    expect(useRunsStore.getState().viewsByRun["r1"]?.suggestedCommit).toBeUndefined();

    store.receiveRunEvent("r1", finished(2));
    expect(useRunsStore.getState().viewsByRun["r1"]?.suggestedCommit).toBe("fix: thing");
  });
});
