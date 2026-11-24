import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ElicitationRequestPayload } from "../src/lib/ipc";
import type * as IpcModule from "../src/lib/ipc";
import type {
  AuthMethod,
  InstanceInfo,
  PtyExitPayload,
  PtyOutputPayload,
  QueueErrorPayload,
  QueueUpdatedPayload,
  Run,
  RunEventPayload,
  RunEventsPayload,
  SessionConfigOption,
  SessionMode,
} from "../src/lib/types";

interface AgentCapsPayload {
  instanceId: string;
  promptImage: boolean;
  loadSession: boolean;
  modes: SessionMode[];
  configOptions: SessionConfigOption[];
  authMethods: AuthMethod[];
  authHint: string | null;
}

const ipcMocks = vi.hoisted(() => {
  const handlers: {
    onRunEvent?: (payload: RunEventPayload) => void;
    onRunEvents?: (payload: RunEventsPayload) => void;
    onRunStarted?: (run: Run) => void;
    onRunCancelling?: (runId: string) => void;
    onQueueUpdate?: (payload: QueueUpdatedPayload) => void;
    onQueueError?: (payload: QueueErrorPayload) => void;
    onElicitationRequest?: (payload: ElicitationRequestPayload) => void;
    onPtyOutput?: (payload: PtyOutputPayload) => void;
    onPtyExit?: (payload: PtyExitPayload) => void;
    onAgentCaps?: (payload: AgentCapsPayload) => void;
  } = {};
  const providersInstancesList = vi.fn(async (): Promise<InstanceInfo[]> => []);
  const runsPendingElicitations = vi.fn(async (): Promise<ElicitationRequestPayload[]> => []);
  const notifyRunFinished = vi.fn();
  const settingsSet = vi.fn(async () => undefined);
  return {
    handlers,
    providersInstancesList,
    runsPendingElicitations,
    notifyRunFinished,
    settingsSet,
  };
});

vi.mock("../src/lib/notifications", () => ({
  notifyRunFinished: ipcMocks.notifyRunFinished,
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    providersInstancesList: ipcMocks.providersInstancesList,
    runsPendingElicitations: ipcMocks.runsPendingElicitations,
    settingsSet: ipcMocks.settingsSet,
    onAgentProcess: vi.fn(async () => () => {}),
    onThreadUpdate: vi.fn(async () => () => {}),
    onRunEvent: vi.fn(async (handler: (payload: RunEventPayload) => void) => {
      ipcMocks.handlers.onRunEvent = handler;
      return () => {};
    }),
    onRunEvents: vi.fn(async (handler: (payload: RunEventsPayload) => void) => {
      ipcMocks.handlers.onRunEvents = handler;
      return () => {};
    }),
    onRunStarted: vi.fn(async (handler: (run: Run) => void) => {
      ipcMocks.handlers.onRunStarted = handler;
      return () => {};
    }),
    onRunCancelling: vi.fn(async (handler: (runId: string) => void) => {
      ipcMocks.handlers.onRunCancelling = handler;
      return () => {};
    }),
    onQueueUpdate: vi.fn(async (handler: (payload: QueueUpdatedPayload) => void) => {
      ipcMocks.handlers.onQueueUpdate = handler;
      return () => {};
    }),
    onQueueError: vi.fn(async (handler: (payload: QueueErrorPayload) => void) => {
      ipcMocks.handlers.onQueueError = handler;
      return () => {};
    }),
    onElicitationRequest: vi.fn(async (handler: (payload: ElicitationRequestPayload) => void) => {
      ipcMocks.handlers.onElicitationRequest = handler;
      return () => {};
    }),
    onPtyOutput: vi.fn(async (handler: (payload: PtyOutputPayload) => void) => {
      ipcMocks.handlers.onPtyOutput = handler;
      return () => {};
    }),
    onPtyExit: vi.fn(async (handler: (payload: PtyExitPayload) => void) => {
      ipcMocks.handlers.onPtyExit = handler;
      return () => {};
    }),
    onAgentCaps: vi.fn(async (handler: (payload: AgentCapsPayload) => void) => {
      ipcMocks.handlers.onAgentCaps = handler;
      return () => {};
    }),
    onSubagentSpawned: vi.fn(async () => () => {}),
    onSubagentFinished: vi.fn(async () => () => {}),
    onSubagentUpdated: vi.fn(async () => () => {}),
  };
});

vi.mock("../src/lib/tauri", () => ({
  isTauri: () => true,
}));

const makeInstance = (): InstanceInfo => ({
  id: "mock",
  displayName: "Mock Agent",
  enabled: true,
  driver: "acp",
  command: "mock-agent",
  args: [],
  env: {},
  status: "running",
  promptImage: false,
  loadSession: false,
  modes: [],
  configOptions: [],
  authMethods: [],
  authHint: null,
});

const makeRun = (): Run => ({
  id: "run-1",
  threadId: "thread-1",
  idx: 0,
  status: "running",
  instanceId: "mock",
  startedAt: 1000,
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("runEvents subscriptions", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    ipcMocks.providersInstancesList.mockClear();
    ipcMocks.providersInstancesList.mockResolvedValue([makeInstance()]);
    ipcMocks.runsPendingElicitations.mockReset();
    ipcMocks.runsPendingElicitations.mockResolvedValue([]);
    ipcMocks.notifyRunFinished.mockClear();
    ipcMocks.settingsSet.mockClear();
    for (const key of Object.keys(ipcMocks.handlers) as Array<keyof typeof ipcMocks.handlers>) {
      delete ipcMocks.handlers[key];
    }
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  async function setup() {
    const { ensureRunEventSubscriptions } = await import("../src/lib/runEvents");
    const { useUiStore } = await import("../src/stores/ui");
    const { useRunsStore } = await import("../src/stores/runs");
    const { useThreadsStore } = await import("../src/stores/threads");

    useUiStore.setState({
      instances: [makeInstance()],
      selectedInstanceId: "mock",
    });
    useRunsStore.getState().registerRun(makeRun());

    await ensureRunEventSubscriptions();

    return { useUiStore, useRunsStore, useThreadsStore };
  }

  it("patches instance configOptions in memory on config_options without calling providersInstancesList", async () => {
    const { useUiStore } = await setup();
    const nextOptions: SessionConfigOption[] = [
      {
        type: "select",
        id: "model",
        name: "Model",
        currentValue: "claude-sonnet-4",
        options: [{ value: "claude-sonnet-4", name: "Claude Sonnet 4" }],
      },
    ];

    expect(ipcMocks.handlers.onRunEvent).toBeTypeOf("function");
    ipcMocks.handlers.onRunEvent!({
      runId: "run-1",
      event: {
        id: "evt-1",
        runId: "run-1",
        seq: 1,
        ts: 1001,
        kind: "config_options",
        payload: { options: nextOptions },
      },
    });
    await flushMicrotasks();

    expect(useUiStore.getState().instances[0].configOptions).toEqual(nextOptions);
    expect(ipcMocks.providersInstancesList).toHaveBeenCalledTimes(0);
  });

  it("patches instance configOptions in memory on batched config_options without calling providersInstancesList", async () => {
    const { useUiStore } = await setup();
    const nextOptions: SessionConfigOption[] = [
      {
        type: "select",
        id: "model",
        name: "Model",
        currentValue: "claude-sonnet-4",
        options: [{ value: "claude-sonnet-4", name: "Claude Sonnet 4" }],
      },
    ];

    expect(ipcMocks.handlers.onRunEvents).toBeTypeOf("function");
    ipcMocks.handlers.onRunEvents!({
      runId: "run-1",
      events: [
        {
          id: "evt-1",
          runId: "run-1",
          seq: 1,
          ts: 1001,
          kind: "config_options",
          payload: { options: nextOptions },
        },
      ],
    });
    await flushMicrotasks();

    expect(useUiStore.getState().instances[0].configOptions).toEqual(nextOptions);
    expect(ipcMocks.providersInstancesList).toHaveBeenCalledTimes(0);
  });

  it("updates run record status on run_finished without calling providersInstancesList", async () => {
    const { useRunsStore } = await setup();

    expect(ipcMocks.handlers.onRunEvent).toBeTypeOf("function");
    ipcMocks.handlers.onRunEvent!({
      runId: "run-1",
      event: {
        id: "evt-2",
        runId: "run-1",
        seq: 2,
        ts: 1002,
        kind: "run_finished",
        payload: { stopReason: "end_turn" },
      },
    });
    await flushMicrotasks();

    expect(useRunsStore.getState().runsByThread["thread-1"][0].status).toBe("finished");
    expect(ipcMocks.providersInstancesList).toHaveBeenCalledTimes(0);
  });

  it("patches matching instance in memory on agent:caps without calling providersInstancesList", async () => {
    const { useUiStore } = await setup();
    const caps: AgentCapsPayload = {
      instanceId: "mock",
      promptImage: true,
      loadSession: true,
      modes: [],
      configOptions: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: "x",
          options: [],
        },
      ],
      authMethods: [],
      authHint: null,
    };

    expect(ipcMocks.handlers.onAgentCaps).toBeTypeOf("function");
    ipcMocks.handlers.onAgentCaps!(caps);
    await flushMicrotasks();

    expect(useUiStore.getState().instances[0]).toMatchObject({
      id: "mock",
      promptImage: true,
      loadSession: true,
      modes: [],
      configOptions: caps.configOptions,
      authMethods: [],
      authHint: null,
    });
    expect(ipcMocks.providersInstancesList).toHaveBeenCalledTimes(0);
  });

  it("does not mark unread or send notification when run_finished arrives for a child thread", async () => {
    const { useRunsStore, useThreadsStore } = await setup();

    useThreadsStore.setState({
      threads: [
        {
          id: "thread-child",
          projectId: null,
          title: "Subagent work",
          status: "working",
          pinned: false,
          createdAt: 100,
          updatedAt: 100,
          parentThreadId: "thread-parent",
          depth: 1,
        },
      ],
      activeThreadId: null,
      unreadIds: [],
      loaded: true,
    });
    useRunsStore.getState().registerRun({
      id: "run-child",
      threadId: "thread-child",
      idx: 0,
      status: "running",
      instanceId: "mock",
      startedAt: 1000,
    });

    ipcMocks.handlers.onRunEvent!({
      runId: "run-child",
      event: {
        id: "evt-child",
        runId: "run-child",
        seq: 1,
        ts: 1005,
        kind: "run_finished",
        payload: { stopReason: "end_turn" },
      },
    });
    await flushMicrotasks();

    expect(useThreadsStore.getState().unreadIds).toEqual([]);
    expect(ipcMocks.notifyRunFinished).not.toHaveBeenCalled();
  });

  it("marks unread and sends notification when run_finished arrives for a regular thread", async () => {
    const { useThreadsStore } = await setup();

    useThreadsStore.setState({
      threads: [
        {
          id: "thread-1",
          projectId: null,
          title: "Regular work",
          status: "working",
          pinned: false,
          createdAt: 100,
          updatedAt: 100,
        },
      ],
      activeThreadId: null,
      unreadIds: [],
      loaded: true,
    });

    ipcMocks.handlers.onRunEvent!({
      runId: "run-1",
      event: {
        id: "evt-reg",
        runId: "run-1",
        seq: 1,
        ts: 1005,
        kind: "run_finished",
        payload: { stopReason: "end_turn" },
      },
    });
    await flushMicrotasks();

    expect(useThreadsStore.getState().unreadIds).toEqual(["thread-1"]);
    expect(ipcMocks.notifyRunFinished).toHaveBeenCalledWith(
      "done",
      "Agent finished",
      "Regular work is ready for you.",
    );
  });

  it("surfaces the reason when a queued message could not start", async () => {
    const { useUiStore } = await setup();

    expect(ipcMocks.handlers.onQueueError).toBeTypeOf("function");
    ipcMocks.handlers.onQueueError!({
      threadId: "thread-1",
      queueId: "q-1",
      message: "unknown instance mock",
    });
    await flushMicrotasks();

    const error = useUiStore.getState().globalError;
    expect(error?.kind).toBe("protocol");
    expect(error?.message).toContain("unknown instance mock");
    expect(error?.message).toContain("could not start");
  });

  it("restores a pending elicitation when the fan-in reattaches", async () => {
    const { resyncLiveState } = await import("../src/lib/runEvents");
    const { useRunsStore } = await import("../src/stores/runs");
    ipcMocks.runsPendingElicitations.mockResolvedValue([
      {
        runId: "run-1",
        requestId: "req-pending",
        message: "Pick a color",
        detail: { mode: "form" },
      },
    ]);

    await resyncLiveState();

    const active = useRunsStore.getState().activeElicitation;
    expect(active?.requestId).toBe("req-pending");
    expect(active?.message).toBe("Pick a color");
    expect(active?.detail).toEqual({ mode: "form" });
  });
});
