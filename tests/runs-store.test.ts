import { beforeEach, describe, expect, it } from "vitest";
import { activeRunForThread, useRunsStore } from "../src/stores/runs";
import type { AppEvent, Run } from "../src/lib/types";

const run = (id: string, threadId: string, status: Run["status"], idx = 0): Run => ({
  id,
  threadId,
  idx,
  status,
  instanceId: "mock",
  startedAt: 0,
});

describe("runs store", () => {
  beforeEach(() => {
    useRunsStore.setState({
      runsByThread: {},
      viewsByRun: {},
      appliedEvents: {},
      commandsByThread: {},
      queueByThread: {},
    });
  });

  it("keeps runs per thread sorted by idx and seeds streaming views", () => {
    useRunsStore.getState().registerRun(run("r2", "th", "running", 1));
    useRunsStore.getState().registerRun(run("r1", "th", "finished", 0));
    const runs = useRunsStore.getState().runsByThread["th"];
    expect(runs.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(useRunsStore.getState().viewsByRun["r2"].streaming).toBe(true);
    expect(useRunsStore.getState().viewsByRun["r1"].streaming).toBe(false);
  });

  it("keeps a view that already received events instead of reseeding it", () => {
    // run:event may land before runs_dispatch resolves: the view is seeded
    // by receiveRunEvent, and registerRun must not wipe it.
    useRunsStore.getState().receiveRunEvent("r1", {
      id: "r1-0",
      runId: "r1",
      seq: 0,
      ts: 0,
      kind: "agent_message_delta",
      payload: { delta: "hi" },
    });
    useRunsStore.getState().registerRun(run("r1", "th", "running", 0));
    const view = useRunsStore.getState().viewsByRun["r1"];
    expect(view.items).toHaveLength(1);
    expect(view.streaming).toBe(true);
  });

  it("keeps a run the backend reports as active streaming", () => {
    useRunsStore.getState().hydrateThread("th", [run("r1", "th", "running")], [], [], "r1");
    expect(useRunsStore.getState().runsByThread["th"][0].status).toBe("running");
    expect(useRunsStore.getState().viewsByRun["r1"].streaming).toBe(true);
  });

  it("still marks a DB-running run with no live runtime as failed", () => {
    useRunsStore.getState().hydrateThread("th", [run("r1", "th", "running")], [], [], null);
    const failed = useRunsStore.getState().runsByThread["th"][0];
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/restarted/);
  });

  it("does not replay already-applied events on re-hydration", () => {
    const event: AppEvent = {
      id: "r1-0",
      runId: "r1",
      seq: 0,
      ts: 0,
      kind: "agent_message_delta",
      payload: { delta: "hi" },
    };
    useRunsStore.getState().receiveRunEvent("r1", event);
    useRunsStore.getState().registerRun(run("r1", "th", "running"));
    useRunsStore.getState().hydrateThread("th", [run("r1", "th", "running")], [event], [], "r1");
    expect(useRunsStore.getState().viewsByRun["r1"].items).toHaveLength(1);
  });

  it("does not replay an event that arrives again after hydration", () => {
    const event: AppEvent = {
      id: "r1-9",
      runId: "r1",
      seq: 9,
      ts: 0,
      kind: "agent_message_delta",
      payload: { delta: "once" },
    };
    useRunsStore.getState().hydrateThread("th", [run("r1", "th", "running")], [event], [], "r1");
    useRunsStore.getState().receiveRunEvent("r1", event);
    expect(useRunsStore.getState().viewsByRun["r1"].items).toHaveLength(1);
  });

  it("stores the latest config options in the run view", () => {
    useRunsStore.getState().hydrateThread(
      "th",
      [run("r1", "th", "running")],
      [
        {
          id: "r1-5",
          runId: "r1",
          seq: 5,
          ts: 0,
          kind: "config_options",
          payload: {
            options: [
              {
                type: "select",
                id: "model",
                name: "Model",
                currentValue: "mock-fast",
                options: [{ value: "mock-fast", name: "Mock Fast" }],
              },
            ],
          },
        },
      ],
      [],
      "r1",
    );
    expect(useRunsStore.getState().viewsByRun["r1"].configOptions?.[0].id).toBe("model");
  });

  it("keeps desired config per thread and drops it with the thread", () => {
    useRunsStore.getState().setDesiredConfig("th", "model", "mock-pro");
    expect(useRunsStore.getState().desiredConfigByThread["th"]).toEqual({
      model: "mock-pro",
    });
    useRunsStore
      .getState()
      .hydrateThread("th", [], [], [], null, null, { thought_level: "high" });
    expect(useRunsStore.getState().desiredConfigByThread["th"]).toEqual({
      thought_level: "high",
    });
    useRunsStore.getState().dropThreadState("th");
    expect(useRunsStore.getState().desiredConfigByThread["th"]).toBeUndefined();
  });

  it("stores the backend queue per thread and replaces it on queue:update", () => {
    useRunsStore.getState().setQueue("th", [
      {
        id: "q1",
        threadId: "th",
        instanceId: "mock",
        text: "follow-up",
        images: [],
        createdAt: 1,
      },
    ]);
    expect(useRunsStore.getState().queueByThread["th"]).toHaveLength(1);
    useRunsStore.getState().setQueue("th", []);
    expect(useRunsStore.getState().queueByThread["th"]).toEqual([]);
  });

  it("selects the latest active run for the timeline", () => {
    useRunsStore.getState().registerRun(run("r1", "th", "finished", 0));
    useRunsStore.getState().registerRun(run("r2", "th", "running", 1));
    useRunsStore.getState().registerRun(run("r3", "th", "queued", 2));
    const runs = useRunsStore.getState().runsByThread["th"];
    expect(activeRunForThread(runs)?.id).toBe("r3");
  });

  it("falls back to the last run when none is active", () => {
    useRunsStore.getState().registerRun(run("r1", "th", "cancelled", 0));
    useRunsStore.getState().registerRun(run("r2", "th", "finished", 1));
    const runs = useRunsStore.getState().runsByThread["th"];
    expect(activeRunForThread(runs)?.id).toBe("r2");
    expect(activeRunForThread(undefined)).toBeUndefined();
  });

  it("rebuilds views from the threads_get transcript", () => {
    useRunsStore.getState().hydrateThread(
      "th",
      [run("r1", "th", "finished", 0)],
      [
        {
          id: "r1-0",
          runId: "r1",
          seq: 0,
          ts: 0,
          kind: "user_message",
          payload: { text: "go", images: [] },
        },
        {
          id: "r1-1",
          runId: "r1",
          seq: 1,
          ts: 0,
          kind: "agent_message_delta",
          payload: { delta: "do" },
        },
        {
          id: "r1-2",
          runId: "r1",
          seq: 2,
          ts: 0,
          kind: "agent_thought_delta",
          payload: { delta: "ing" },
        },
        {
          id: "r1-3",
          runId: "r1",
          seq: 3,
          ts: 0,
          kind: "run_finished",
          payload: { stopReason: "end_turn" },
        },
      ],
      [],
    );
    const view = useRunsStore.getState().viewsByRun["r1"];
    expect(view.items.map((i) => i.type)).toEqual(["user", "assistant", "thought"]);
    expect(view.streaming).toBe(false);
    expect(view.stopReason).toBe("end_turn");
  });

  it("keeps locally dispatched runs that a stale threads_get snapshot lacks", () => {
    // dispatch resolved first: the run is streaming locally
    useRunsStore.getState().registerRun(run("r-live", "th", "running", 1));
    useRunsStore.getState().receiveRunEvent("r-live", {
      id: "r-live-0",
      runId: "r-live",
      seq: 0,
      ts: 0,
      kind: "agent_message_delta",
      payload: { delta: "streaming" },
    });
    // stale threads_get snapshot lands afterwards: only knows r0
    // The live runtime still holds r-live, so the snapshot names it active.
    useRunsStore.getState().hydrateThread("th", [run("r0", "th", "finished", 0)], [], [], "r-live");
    const runs = useRunsStore.getState().runsByThread["th"];
    expect(runs.map((r) => r.id)).toEqual(["r0", "r-live"]);
    const liveView = useRunsStore.getState().viewsByRun["r-live"];
    expect(liveView.streaming).toBe(true);
    expect(liveView.items).toHaveLength(1);
  });

  it("derives a missing stopReason from the run record when hydrating terminal runs", () => {
    // Terminal run records always carry stop_reason (set by the Rust core).
    useRunsStore
      .getState()
      .hydrateThread(
        "th",
        [{ ...run("r1", "th", "cancelled", 0), stopReason: "cancelled" }],
        [],
        [],
      );
    const view = useRunsStore.getState().viewsByRun["r1"];
    expect(view.stopReason).toBe("cancelled");
    expect(view.streaming).toBe(false);
  });
});
