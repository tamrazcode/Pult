import { beforeEach, describe, expect, it } from "vitest";
import { activeRunForThread, threadTimelineItems, useRunsStore } from "../src/stores/runs";
import { useThreadsStore } from "../src/stores/threads";
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
      filesByThread: {},
      activeElicitation: null,
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

  it("drops the pending user bubble and cancelling flags with the thread", () => {
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "th", "running")] },
      pendingUserByThread: { th: { type: "user", text: "hi", images: [], ts: 1 } },
      cancellingByRun: { r1: true, other: true },
    });

    useRunsStore.getState().dropThreadState("th");

    expect(useRunsStore.getState().pendingUserByThread["th"]).toBeUndefined();
    expect(useRunsStore.getState().cancellingByRun["r1"]).toBeUndefined();
    expect(useRunsStore.getState().cancellingByRun["other"]).toBe(true);
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

  it("hydrateThread groups 500 runs and 10000 events in a single pass", () => {
    const runCount = 500;
    const eventsPerRun = 20; // 1 user_message + 18 agent_message_delta + 1 run_finished = 10,000 events
    const runs: Run[] = Array.from({ length: runCount }, (_, i) => ({
      ...run(`r-${i}`, "th-perf", "finished", i),
      stopReason: "end_turn",
    }));

    const events: AppEvent[] = [];
    for (let seq = 0; seq < eventsPerRun; seq++) {
      for (let r = 0; r < runCount; r++) {
        const runId = `r-${r}`;
        if (seq === 0) {
          events.push({
            id: `${runId}-${seq}`,
            runId,
            seq,
            ts: seq,
            kind: "user_message",
            payload: { text: `prompt-${r}`, images: [] },
          });
        } else if (seq < eventsPerRun - 1) {
          events.push({
            id: `${runId}-${seq}`,
            runId,
            seq,
            ts: seq,
            kind: "agent_message_delta",
            payload: { delta: "x" },
          });
        } else {
          events.push({
            id: `${runId}-${seq}`,
            runId,
            seq,
            ts: seq,
            kind: "run_finished",
            payload: { stopReason: "end_turn" },
          });
        }
      }
    }

    const start = performance.now();
    useRunsStore.getState().hydrateThread("th-perf", runs, events, [], null);
    const elapsedMs = performance.now() - start;
    console.info(`hydrateThread(500 runs, 10000 events) took ${elapsedMs.toFixed(2)}ms`);

    const state = useRunsStore.getState();
    expect(state.runsByThread["th-perf"]).toHaveLength(runCount);
    for (let r = 0; r < runCount; r++) {
      const runId = `r-${r}`;
      const view = state.viewsByRun[runId];
      expect(view).toBeDefined();
      expect(view.streaming).toBe(false);
      expect(view.stopReason).toBe("end_turn");
      expect(view.items).toHaveLength(2);
      expect(view.items[0]).toMatchObject({ type: "user", text: `prompt-${r}` });
      expect(view.items[1]).toMatchObject({
        type: "assistant",
        text: "x".repeat(eventsPerRun - 2),
        streaming: false,
      });
      expect(state.appliedEvents[runId]?.size).toBe(eventsPerRun);
    }
  });

  it("marks run as cancelling on run:cancelling event and clears on finish", () => {
    useRunsStore.setState({ cancellingByRun: {} });
    useRunsStore.getState().registerRun(run("r-cancel", "th", "running", 0));

    useRunsStore.getState().markCancelling("r-cancel");
    expect(useRunsStore.getState().cancellingByRun["r-cancel"]).toBe(true);

    useRunsStore.getState().receiveRunEvent("r-cancel", {
      id: "r-cancel-0",
      runId: "r-cancel",
      seq: 0,
      ts: 1,
      kind: "run_finished",
      payload: { stopReason: "cancelled" },
    });

    expect(useRunsStore.getState().cancellingByRun["r-cancel"]).toBeUndefined();
    expect(useRunsStore.getState().runsByThread["th"][0].status).toBe("cancelled");
  });

  it("upserts file_changed into filesByThread from the live batch", () => {
    useRunsStore.getState().registerRun(run("r1", "th", "running", 0));
    useRunsStore.getState().receiveRunEventsBatch("r1", [
      {
        id: "r1-0",
        runId: "r1",
        seq: 0,
        ts: 1,
        kind: "file_changed",
        payload: { path: "src/a.ts", diff: "@@ one", added: 1, removed: 0 },
      },
    ]);
    expect(useRunsStore.getState().filesByThread["th"]).toEqual([
      { runId: "r1", path: "src/a.ts", diff: "@@ one", added: 1, removed: 0 },
    ]);

    // A second change to the same path replaces the row in place.
    useRunsStore.getState().receiveRunEventsBatch("r1", [
      {
        id: "r1-1",
        runId: "r1",
        seq: 1,
        ts: 2,
        kind: "file_changed",
        payload: { path: "src/a.ts", diff: "@@ two", added: 2, removed: 1 },
      },
      {
        id: "r1-2",
        runId: "r1",
        seq: 2,
        ts: 3,
        kind: "file_changed",
        payload: { path: "src/b.ts", diff: "@@ new", added: 4, removed: 0 },
      },
    ]);
    const files = useRunsStore.getState().filesByThread["th"];
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(files[0]).toMatchObject({ diff: "@@ two", added: 2, removed: 1 });

    // A replayed batch leaves the state object untouched (no re-render).
    const before = useRunsStore.getState().filesByThread;
    useRunsStore.getState().receiveRunEventsBatch("r1", [
      {
        id: "r1-2",
        runId: "r1",
        seq: 2,
        ts: 3,
        kind: "file_changed",
        payload: { path: "src/b.ts", diff: "@@ new", added: 4, removed: 0 },
      },
    ]);
    expect(useRunsStore.getState().filesByThread).toBe(before);
  });

  it("ignores session_info titles that are only the injected prompt preamble", () => {
    useThreadsStore.setState({
      threads: [
        {
          id: "th",
          projectId: null,
          title: "Keep this title",
          status: "draft",
          pinned: false,
          createdAt: 0,
          updatedAt: 0,
        },
      ],
      unreadIds: [],
      activeThreadId: null,
      loaded: true,
    });
    useRunsStore.getState().registerRun(run("r1", "th", "running", 0));

    useRunsStore.getState().receiveRunEventsBatch("r1", [
      {
        id: "r1-0",
        runId: "r1",
        seq: 0,
        ts: 1,
        kind: "session_info",
        payload: { title: "<pult_instructions>You are a subagent…" },
      },
    ]);
    expect(useThreadsStore.getState().threads[0]?.title).toBe("Keep this title");

    useRunsStore.getState().receiveRunEventsBatch("r1", [
      {
        id: "r1-1",
        runId: "r1",
        seq: 1,
        ts: 2,
        kind: "session_info",
        payload: { title: "Fix the login flow" },
      },
    ]);
    expect(useThreadsStore.getState().threads[0]?.title).toBe("Fix the login flow");
  });

  it("surfaces a batch elicitation_request once and never replaces the shown request", () => {
    useRunsStore.getState().registerRun(run("r1", "th", "running", 0));
    // The IPC event (which owns the requestId) already surfaced it.
    useRunsStore.getState().setElicitation({
      runId: "r1",
      requestId: "req-1",
      message: "Pick a color",
      detail: {},
    });
    // The persisted event has no requestId: it must not clobber the surface.
    useRunsStore.getState().receiveRunEventsBatch("r1", [
      {
        id: "r1-0",
        runId: "r1",
        seq: 0,
        ts: 1,
        kind: "elicitation_request",
        payload: { message: "Pick a color", detail: {} },
      },
    ]);
    expect(useRunsStore.getState().activeElicitation?.requestId).toBe("req-1");

    // When the id travels along, the surface is built from it.
    const withId = {
      id: "r1-1",
      runId: "r1",
      seq: 1,
      ts: 2,
      kind: "elicitation_request",
      payload: { message: "Choose a branch", detail: { mode: "form" }, requestId: "req-2" },
    } as unknown as AppEvent;
    useRunsStore.getState().receiveRunEventsBatch("r1", [withId]);
    expect(useRunsStore.getState().activeElicitation).toEqual({
      runId: "r1",
      requestId: "req-2",
      message: "Choose a branch",
      detail: { mode: "form" },
    });

    // Same request again: no new surface object.
    const shown = useRunsStore.getState().activeElicitation;
    useRunsStore
      .getState()
      .receiveRunEventsBatch("r1", [{ ...withId, id: "r1-2", seq: 2 } as AppEvent]);
    expect(useRunsStore.getState().activeElicitation).toBe(shown);
  });

  it("keeps live file_changed rows that a stale threads_get snapshot lacks", () => {
    useRunsStore.getState().registerRun(run("r1", "th", "running", 0));
    useRunsStore.getState().receiveRunEvent("r1", {
      id: "r1-9",
      runId: "r1",
      seq: 9,
      ts: 9,
      kind: "file_changed",
      payload: { path: "src/live.ts", diff: "@@ live", added: 3, removed: 0 },
    });

    // The snapshot was read before that event was persisted.
    useRunsStore.getState().hydrateThread(
      "th",
      [run("r1", "th", "running", 0)],
      [
        {
          id: "r1-0",
          runId: "r1",
          seq: 0,
          ts: 0,
          kind: "user_message",
          payload: { text: "go", images: [] },
        },
      ],
      [],
      "r1",
    );
    expect(useRunsStore.getState().filesByThread["th"]).toEqual([
      { runId: "r1", path: "src/live.ts", diff: "@@ live", added: 3, removed: 0 },
    ]);

    // A later run's change to the same path wins over the older live row.
    useRunsStore.getState().registerRun(run("r2", "th", "running", 1));
    useRunsStore.getState().receiveRunEvent("r2", {
      id: "r2-0",
      runId: "r2",
      seq: 0,
      ts: 10,
      kind: "file_changed",
      payload: { path: "src/live.ts", diff: "@@ live 2", added: 5, removed: 1 },
    });
    useRunsStore.getState().hydrateThread(
      "th",
      [run("r1", "th", "running", 0), run("r2", "th", "running", 1)],
      [
        {
          id: "r1-0",
          runId: "r1",
          seq: 0,
          ts: 0,
          kind: "user_message",
          payload: { text: "go", images: [] },
        },
      ],
      [],
      "r2",
    );
    expect(useRunsStore.getState().filesByThread["th"]).toEqual([
      { runId: "r2", path: "src/live.ts", diff: "@@ live 2", added: 5, removed: 1 },
    ]);
  });

  it("keeps a second elicitation until the first is answered", () => {
    const { setElicitation, clearElicitation } = useRunsStore.getState();
    setElicitation({ runId: "r1", requestId: "q1", message: "one", detail: {} });
    setElicitation({ runId: "r2", requestId: "q2", message: "two", detail: {} });

    expect(useRunsStore.getState().activeElicitation?.requestId).toBe("q1");
    expect(useRunsStore.getState().elicitationQueue.map((item) => item.requestId)).toEqual(["q2"]);

    clearElicitation("q1");
    expect(useRunsStore.getState().activeElicitation?.requestId).toBe("q2");
    expect(useRunsStore.getState().elicitationQueue).toEqual([]);
  });

  it("does not fail a run that started after the snapshot request", () => {
    useRunsStore.setState({
      runsByThread: { th: [run("r-new", "th", "running")] },
      viewsByRun: {},
    });

    useRunsStore.getState().hydrateThread("th", [], [], [], null);

    expect(useRunsStore.getState().runsByThread["th"][0]?.status).toBe("running");
  });

  it("keeps a live queue that changed during the snapshot request", () => {
    const item = (id: string) => ({
      id,
      threadId: "th",
      instanceId: "mock",
      text: id,
      images: [],
      createdAt: 0,
    });
    useRunsStore.getState().setQueue("th", [item("q2")]);

    useRunsStore.getState().hydrateThread("th", [], [], [item("q1")], null, null, undefined, 0);

    expect(useRunsStore.getState().queueByThread["th"]?.map((q) => q.id)).toEqual(["q2"]);
  });
});
