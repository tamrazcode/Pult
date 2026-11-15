import { beforeEach, describe, expect, it } from "vitest";
import { activeRunForThread, threadTimelineItems, useRunsStore } from "../src/stores/runs";
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

  it("keeps desired config when a stale hydrate reports an empty map", () => {
    useRunsStore.getState().setDesiredConfig("th", "model", "mock-pro");
    useRunsStore.getState().hydrateThread("th", [], [], [], null, null, {});
    expect(useRunsStore.getState().desiredConfigByThread["th"]).toEqual({ model: "mock-pro" });
  });

  it("keeps desired config per thread and drops it with the thread", () => {
    useRunsStore.getState().setDesiredConfig("th", "model", "mock-pro");
    expect(useRunsStore.getState().desiredConfigByThread["th"]).toEqual({
      model: "mock-pro",
    });
    useRunsStore.getState().hydrateThread("th", [], [], [], null, null, { thought_level: "high" });
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

  it("merges every run of a thread into one ordered timeline", () => {
    useRunsStore.setState({
      runsByThread: {
        th: [run("r2", "th", "running", 1), run("r1", "th", "finished", 0)],
      },
      viewsByRun: {
        r1: {
          items: [
            { type: "user", text: "first", images: [] },
            { type: "assistant", text: "answer", streaming: false },
          ],
          streaming: false,
        },
        r2: {
          items: [
            { type: "user", text: "second", images: [] },
            { type: "assistant", text: "stream", streaming: true },
          ],
          streaming: true,
        },
      },
    });
    const { runsByThread, viewsByRun } = useRunsStore.getState();
    const items = threadTimelineItems(runsByThread["th"], viewsByRun);
    expect(
      items.map(({ item }) =>
        item.type === "user" || item.type === "assistant" ? item.text : item.type,
      ),
    ).toEqual(["first", "answer", "second", "stream"]);
    expect(items.map(({ runId }) => runId)).toEqual(["r1", "r1", "r2", "r2"]);
    expect(items.map(({ showCaret }) => showCaret)).toEqual([false, false, false, true]);
    expect(items.map(({ key }) => key)).toEqual(["r1:i-0", "r1:i-1", "r2:i-0", "r2:i-1"]);
    expect(new Set(items.map(({ key }) => key)).size).toBe(4);
  });

  it("scopes tool/compaction keys per run and hides caret when inactive", () => {
    const items = threadTimelineItems(
      [run("r1", "th", "finished", 0), run("r2", "th", "finished", 1)],
      {
        r1: {
          items: [
            {
              type: "tool",
              toolCallId: "t-1",
              title: "Read",
              kind: "read",
              status: "completed",
              locations: [],
            },
            { type: "compaction", compactionId: "c-1", status: "completed", summary: "s1" },
          ],
          streaming: false,
        },
        r2: {
          items: [
            {
              type: "tool",
              toolCallId: "t-1",
              title: "Read",
              kind: "read",
              status: "completed",
              locations: [],
            },
            { type: "compaction", compactionId: "c-1", status: "completed", summary: "s2" },
          ],
          streaming: false,
        },
      },
    );
    expect(items.map(({ key }) => key)).toEqual([
      "r1:tool-t-1",
      "r1:comp-c-1",
      "r2:tool-t-1",
      "r2:comp-c-1",
    ]);
    expect(new Set(items.map(({ key }) => key)).size).toBe(4);
    expect(items.every(({ showCaret }) => !showCaret)).toBe(true);
    expect(threadTimelineItems(undefined, {})).toEqual([]);
  });

  it("does not put a streaming caret on a previous run item when the active run has no items yet", () => {
    const items = threadTimelineItems(
      [run("r1", "th", "finished", 0), run("r2", "th", "running", 1)],
      {
        r1: {
          items: [{ type: "assistant", text: "partial before crash", streaming: true }],
          streaming: false,
        },
        r2: {
          items: [],
          streaming: true,
        },
      },
    );
    expect(items).toHaveLength(1);
    expect(items[0].runId).toBe("r1");
    expect(items[0].showCaret).toBe(false);
  });

  it("folds receiveRunEventsBatch identically to receiveRunEvent with a single subscriber notification", () => {
    const events: AppEvent[] = [
      {
        id: "r1-0",
        runId: "r1",
        seq: 0,
        ts: 100,
        kind: "user_message",
        payload: { text: "hello", images: [] },
      },
      {
        id: "r1-1",
        runId: "r1",
        seq: 1,
        ts: 110,
        kind: "agent_thought_delta",
        payload: { delta: "pondering" },
      },
      {
        id: "r1-2",
        runId: "r1",
        seq: 2,
        ts: 120,
        kind: "agent_message_delta",
        payload: { delta: "part 1 " },
      },
      {
        id: "r1-3",
        runId: "r1",
        seq: 3,
        ts: 130,
        kind: "agent_message_delta",
        payload: { delta: "part 2" },
      },
      {
        id: "r1-4",
        runId: "r1",
        seq: 4,
        ts: 140,
        kind: "tool_call",
        payload: {
          toolCallId: "tc-1",
          title: "Read",
          kind: "read",
          status: "in_progress",
          locations: ["src/main.rs"],
        },
      },
      {
        id: "r1-5",
        runId: "r1",
        seq: 5,
        ts: 150,
        kind: "tool_call_update",
        payload: { toolCallId: "tc-1", status: "completed" },
      },
      {
        id: "r1-6",
        runId: "r1",
        seq: 6,
        ts: 160,
        kind: "run_finished",
        payload: { stopReason: "end_turn" },
      },
    ];

    useRunsStore.getState().registerRun(run("r1", "th", "running", 0));
    for (const ev of events) {
      useRunsStore.getState().receiveRunEvent("r1", ev);
    }
    const expectedView = structuredClone(useRunsStore.getState().viewsByRun["r1"]);
    const expectedRun = structuredClone(useRunsStore.getState().runsByThread["th"][0]);

    useRunsStore.setState({
      runsByThread: {},
      viewsByRun: {},
      appliedEvents: {},
      commandsByThread: {},
      queueByThread: {},
    });
    useRunsStore.getState().registerRun(run("r1", "th", "running", 0));

    let notifications = 0;
    const unsubscribe = useRunsStore.subscribe(() => {
      notifications += 1;
    });
    try {
      (
        useRunsStore.getState() as unknown as {
          receiveRunEventsBatch: (runId: string, events: AppEvent[]) => void;
        }
      ).receiveRunEventsBatch("r1", events);
    } finally {
      unsubscribe();
    }

    expect(notifications).toBe(1);
    expect(useRunsStore.getState().viewsByRun["r1"]).toEqual(expectedView);
    expect(useRunsStore.getState().runsByThread["th"][0]).toEqual(expectedRun);
    expect(useRunsStore.getState().runsByThread["th"][0].status).toBe("finished");
  });

  it("closes streaming assistant items when hydrating a terminal run without run_finished", () => {
    useRunsStore.getState().hydrateThread(
      "th",
      [{ ...run("r1", "th", "failed", 0), stopReason: "failed" }],
      [
        {
          id: "r1-0",
          runId: "r1",
          seq: 0,
          ts: 0,
          kind: "agent_message_delta",
          payload: { delta: "partial output" },
        },
      ],
      [],
      null,
    );
    const view = useRunsStore.getState().viewsByRun["r1"];
    expect(view.streaming).toBe(false);
    expect(view.items).toHaveLength(1);
    const item = view.items[0];
    expect(item.type).toBe("assistant");
    if (item.type === "assistant") {
      expect(item.streaming).toBe(false);
    }
  });

  it("computes suggestedCommit independently per finished run", () => {
    const store = useRunsStore.getState();
    store.registerRun(run("r1", "th", "running", 0));
    store.receiveRunEvent("r1", {
      id: "r1-0",
      runId: "r1",
      seq: 0,
      ts: 1,
      kind: "agent_message_delta",
      payload: { delta: "Done.\nSuggested commit message: fix: one" },
    });
    store.receiveRunEvent("r1", {
      id: "r1-1",
      runId: "r1",
      seq: 1,
      ts: 2,
      kind: "run_finished",
      payload: { stopReason: "end_turn" },
    });

    store.registerRun(run("r2", "th", "running", 1));
    store.receiveRunEvent("r2", {
      id: "r2-0",
      runId: "r2",
      seq: 0,
      ts: 3,
      kind: "agent_message_delta",
      payload: { delta: "Follow-up without a commit suggestion." },
    });
    store.receiveRunEvent("r2", {
      id: "r2-1",
      runId: "r2",
      seq: 1,
      ts: 4,
      kind: "run_finished",
      payload: { stopReason: "end_turn" },
    });

    const views = useRunsStore.getState().viewsByRun;
    expect(views["r1"].suggestedCommit).toBe("fix: one");
    expect(views["r2"].suggestedCommit).toBeUndefined();
  });

  it("prunes incompatible desired config keys and values on provider switch", () => {
    useRunsStore.setState({
      desiredConfigByThread: {
        th: {
          model: "claude-sonnet-4",
          thinking_level: "high",
          effort: "max",
          web_search: true,
        },
      },
    });

    useRunsStore.getState().pruneDesiredConfigForInstance("th", [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: "gpt-5",
        options: [
          { value: "gpt-5", name: "GPT-5" },
          { value: "o3", name: "o3" },
        ],
      },
      {
        type: "select",
        id: "reasoning_effort",
        name: "Reasoning",
        category: "reasoning",
        currentValue: "medium",
        options: [
          { value: "low", name: "Low" },
          { value: "medium", name: "Medium" },
        ],
      },
      {
        type: "boolean",
        id: "web_search",
        name: "Web search",
        category: "other",
        currentValue: false,
      },
    ]);

    expect(useRunsStore.getState().desiredConfigByThread["th"]).toEqual({
      web_search: true,
    });

    useRunsStore.getState().pruneDesiredConfigForInstance("th", []);
    const afterEmpty = useRunsStore.getState().desiredConfigByThread["th"];
    expect(afterEmpty === undefined || Object.keys(afterEmpty).length === 0).toBe(true);
  });
});
