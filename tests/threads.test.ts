import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as IpcModule from "../src/lib/ipc";

const { settingsGet, settingsSet, threadsList } = vi.hoisted(() => ({
  settingsGet: vi.fn(async (): Promise<unknown> => null),
  settingsSet: vi.fn(async () => undefined),
  threadsList: vi.fn(async () => []),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    settingsGet,
    settingsSet,
    threadsList,
    onThreadUpdate: vi.fn(async () => () => {}),
  };
});

vi.mock("../src/lib/tauri", () => ({
  isTauri: () => true,
}));

import { useThreadsStore } from "../src/stores/threads";
import type { Thread } from "../src/stores/threads";

const t = (id: string, status: Thread["status"], pinned = false, updatedAt = 0): Thread => ({
  id,
  projectId: null,
  title: id,
  status,
  pinned,
  createdAt: 0,
  updatedAt,
});

describe("threads store", () => {
  beforeEach(() => {
    useThreadsStore.setState({ threads: [], activeThreadId: null, loaded: false });
  });

  it("upserts threads newest-first by updatedAt, replacing by id", () => {
    useThreadsStore.getState().upsertThread(t("a", "draft", false, 10));
    useThreadsStore.getState().upsertThread(t("b", "working", false, 20));
    expect(useThreadsStore.getState().threads.map((x) => x.id)).toEqual(["b", "a"]);
    useThreadsStore.getState().upsertThread(t("a", "working", false, 30));
    const threads = useThreadsStore.getState().threads;
    expect(threads.map((x) => x.id)).toEqual(["a", "b"]);
    expect(threads[0].status).toBe("working");
  });

  it("removeThread drops the thread from the store", () => {
    useThreadsStore.getState().upsertThread(t("a", "draft"));
    useThreadsStore.getState().removeThread("a");
    expect(useThreadsStore.getState().threads).toEqual([]);
  });
});

describe("unread threads", () => {
  beforeEach(() => {
    settingsGet.mockReset().mockResolvedValue(null);
    settingsSet.mockReset().mockResolvedValue(undefined);
    threadsList.mockReset().mockResolvedValue([]);
    useThreadsStore.setState({
      threads: [],
      activeThreadId: null,
      loaded: false,
      unreadIds: [],
    } as never);
  });

  it("markUnread toggles ids and persists via settingsSet('unread_threads', ...)", () => {
    const store = useThreadsStore.getState() as unknown as {
      unreadIds: string[];
      markUnread: (id: string, unread: boolean) => void;
    };

    store.markUnread("t1", true);
    expect((useThreadsStore.getState() as unknown as { unreadIds: string[] }).unreadIds).toEqual([
      "t1",
    ]);
    expect(settingsSet).toHaveBeenCalledWith("unread_threads", ["t1"]);

    store.markUnread("t2", true);
    expect((useThreadsStore.getState() as unknown as { unreadIds: string[] }).unreadIds).toEqual([
      "t1",
      "t2",
    ]);
    expect(settingsSet).toHaveBeenLastCalledWith("unread_threads", ["t1", "t2"]);

    store.markUnread("t1", false);
    expect((useThreadsStore.getState() as unknown as { unreadIds: string[] }).unreadIds).toEqual([
      "t2",
    ]);
    expect(settingsSet).toHaveBeenLastCalledWith("unread_threads", ["t2"]);
  });

  it("opening a thread clears its unread id", () => {
    useThreadsStore.setState({ unreadIds: ["t1", "t2"] } as never);

    useThreadsStore.getState().setActiveThread("t1");

    expect((useThreadsStore.getState() as unknown as { unreadIds: string[] }).unreadIds).toEqual([
      "t2",
    ]);
    expect(settingsSet).toHaveBeenCalledWith("unread_threads", ["t2"]);
  });

  it("hydration loads persisted unread ids from settingsGet", async () => {
    settingsGet.mockImplementation(async (key?: unknown) =>
      key === "unread_threads" ? ["t2", "t3"] : null,
    );

    await useThreadsStore.getState().loadThreads();

    expect(settingsGet).toHaveBeenCalledWith("unread_threads");
    expect((useThreadsStore.getState() as unknown as { unreadIds: string[] }).unreadIds).toEqual([
      "t2",
      "t3",
    ]);
  });
});
