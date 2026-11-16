import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as IpcModule from "../src/lib/ipc";
import type { Run, RunEventPayload } from "../src/lib/types";

const ipcMocks = vi.hoisted(() => {
  const handlers: {
    onRunEvent?: (payload: RunEventPayload) => void;
  } = {};
  return {
    handlers,
    appNotify: vi.fn(async () => undefined),
    playNotificationSound: vi.fn(),
  };
});

vi.mock("../src/lib/tauri", () => ({
  isTauri: () => true,
}));

vi.mock("../src/lib/sound", () => ({
  playNotificationSound: ipcMocks.playNotificationSound,
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    appNotify: ipcMocks.appNotify,
    settingsSet: vi.fn(async () => undefined),
    onAgentProcess: vi.fn(async () => () => {}),
    onThreadUpdate: vi.fn(async () => () => {}),
    onRunEvent: vi.fn(async (handler: (payload: RunEventPayload) => void) => {
      ipcMocks.handlers.onRunEvent = handler;
      return () => {};
    }),
    onRunEvents: vi.fn(async () => () => {}),
    onRunStarted: vi.fn(async () => () => {}),
    onRunCancelling: vi.fn(async () => () => {}),
    onQueueUpdate: vi.fn(async () => () => {}),
    onElicitationRequest: vi.fn(async () => () => {}),
    onPtyOutput: vi.fn(async () => () => {}),
    onPtyExit: vi.fn(async () => () => {}),
    onAgentCaps: vi.fn(async () => () => {}),
  };
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("run notifications", () => {
  let hidden = true;
  let focused = false;

  beforeEach(() => {
    vi.resetModules();
    hidden = true;
    focused = false;
    ipcMocks.appNotify.mockReset().mockResolvedValue(undefined);
    ipcMocks.playNotificationSound.mockReset();
    delete ipcMocks.handlers.onRunEvent;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => hidden,
    });
    vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("notifyRunFinished does nothing when notifications are disabled or window is focused", async () => {
    const { notifyRunFinished } = await import("../src/lib/notifications");
    const { useSettingsStore } = await import("../src/stores/settings");

    useSettingsStore.setState({ notificationsEnabled: false, notificationSound: true });
    hidden = true;
    focused = false;
    notifyRunFinished("done", "Agent finished", "Thread is ready");
    expect(ipcMocks.playNotificationSound).not.toHaveBeenCalled();
    expect(ipcMocks.appNotify).not.toHaveBeenCalled();

    useSettingsStore.setState({ notificationsEnabled: true, notificationSound: true });
    hidden = false;
    focused = true;
    notifyRunFinished("done", "Agent finished", "Thread is ready");
    expect(ipcMocks.playNotificationSound).not.toHaveBeenCalled();
    expect(ipcMocks.appNotify).not.toHaveBeenCalled();
  });

  it("notifyRunFinished plays sound and calls appNotify when backgrounded", async () => {
    const { notifyRunFinished } = await import("../src/lib/notifications");
    const { useSettingsStore } = await import("../src/stores/settings");

    useSettingsStore.setState({ notificationsEnabled: true, notificationSound: true });
    hidden = true;
    focused = false;
    notifyRunFinished("done", "Agent finished", "Task is ready for you.");
    expect(ipcMocks.playNotificationSound).toHaveBeenCalledWith("done");
    expect(ipcMocks.appNotify).toHaveBeenCalledWith("Agent finished", "Task is ready for you.");

    ipcMocks.playNotificationSound.mockClear();
    ipcMocks.appNotify.mockClear();
    useSettingsStore.setState({ notificationsEnabled: true, notificationSound: false });
    notifyRunFinished("cancelled", "Run cancelled", "Task was stopped.");
    expect(ipcMocks.playNotificationSound).not.toHaveBeenCalled();
    expect(ipcMocks.appNotify).toHaveBeenCalledWith("Run cancelled", "Task was stopped.");
  });

  it("runEvents maps stopReason to notification titles and sounds, including error stopReason", async () => {
    const { ensureRunEventSubscriptions } = await import("../src/lib/runEvents");
    const { useSettingsStore } = await import("../src/stores/settings");
    const { useRunsStore } = await import("../src/stores/runs");
    const { useThreadsStore } = await import("../src/stores/threads");

    useSettingsStore.setState({ notificationsEnabled: true, notificationSound: true });
    useThreadsStore.setState({
      threads: [
        {
          id: "t1",
          projectId: null,
          title: "Deploy app",
          status: "working",
          pinned: false,
          createdAt: 100,
          updatedAt: 100,
        },
      ],
      activeThreadId: null,
      unreadIds: [],
      loaded: true,
    } as never);

    const run1: Run = {
      id: "r1",
      threadId: "t1",
      idx: 0,
      status: "running",
      instanceId: "mock",
      startedAt: 100,
    };
    const run2: Run = {
      id: "r2",
      threadId: "t1",
      idx: 1,
      status: "running",
      instanceId: "mock",
      startedAt: 200,
    };
    useRunsStore.getState().registerRun(run1);
    useRunsStore.getState().registerRun(run2);

    await ensureRunEventSubscriptions();

    ipcMocks.handlers.onRunEvent!({
      runId: "r1",
      event: {
        id: "e1",
        runId: "r1",
        seq: 1,
        ts: 101,
        kind: "run_finished",
        payload: { stopReason: "end_turn" },
      },
    });
    await flushMicrotasks();

    expect(ipcMocks.playNotificationSound).toHaveBeenCalledWith("done");
    expect(ipcMocks.appNotify).toHaveBeenCalledWith(
      "Agent finished",
      "Deploy app is ready for you.",
    );

    ipcMocks.handlers.onRunEvent!({
      runId: "r2",
      event: {
        id: "e2",
        runId: "r2",
        seq: 1,
        ts: 201,
        kind: "run_finished",
        payload: { stopReason: "failed" },
      },
    });
    await flushMicrotasks();

    expect(ipcMocks.playNotificationSound).toHaveBeenCalledWith("error");
    expect(ipcMocks.appNotify).toHaveBeenCalledWith(
      "Agent needs attention",
      "Deploy app stopped with an error.",
    );
  });
});
