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

import { buildSidebarGroups, useThreadsStore } from "../src/stores/threads";
import type { SidebarFilter, Thread } from "../src/stores/threads";
import { useDraftsStore } from "../src/stores/drafts";
import { useGitStore } from "../src/stores/git";
import { useSubagentsStore } from "../src/stores/subagents";
import { useTerminalsStore } from "../src/stores/terminals";
import { useUiStore } from "../src/stores/ui";
import type { Project } from "../src/lib/types";

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

  it("removeThread clears drafts, subagents, git, terminals and ui for that thread only", () => {
    const delegated = (taskId: string, parentThreadId: string) => ({
      taskId,
      parentThreadId,
      parentRunId: "run-1",
      childThreadId: `child-${taskId}`,
      title: taskId,
      promptSummary: "",
      targetInstanceId: "inst",
      isolation: "shared",
      permissionMode: "default",
      status: "running",
      startedAt: 0,
    });

    useThreadsStore.setState({
      threads: [t("a", "draft"), t("b", "draft")],
      activeThreadId: "a",
    });
    useDraftsStore.getState().setDraft("a", "unsent");
    useDraftsStore.getState().setDraft("b", "keep me");
    useSubagentsStore.setState({
      tasks: {
        "task-a": delegated("task-a", "a"),
        "task-b": delegated("task-b", "b"),
      },
      order: ["task-a", "task-b"],
    });
    useGitStore.getState().setCommitMessage("a", "msg-a");
    useGitStore.getState().setCommitMessage("b", "msg-b");
    useTerminalsStore.setState({
      byThread: {
        a: [{ terminalId: "ta", title: "shell a", exit: null }],
        b: [{ terminalId: "tb", title: "shell b", exit: null }],
      },
      activeByThread: { a: "ta", b: "tb" },
      backfill: { ta: ["leftover"], tb: ["keep"] },
    });
    useUiStore.setState({ instanceByThread: { a: "inst-a", b: "inst-b" } });

    useThreadsStore.getState().removeThread("a");

    expect(useDraftsStore.getState().byThread["a"]).toBeUndefined();
    expect(useDraftsStore.getState().byThread["b"]).toBe("keep me");
    expect(useSubagentsStore.getState().order).toEqual(["task-b"]);
    expect(useSubagentsStore.getState().tasks["task-a"]).toBeUndefined();
    expect(useSubagentsStore.getState().tasks["task-b"]).toBeDefined();
    expect(useGitStore.getState().byThread["a"]).toBeUndefined();
    expect(useGitStore.getState().byThread["b"].commitMessage).toBe("msg-b");
    expect(useTerminalsStore.getState().byThread["a"]).toBeUndefined();
    expect(useTerminalsStore.getState().byThread["b"]).toHaveLength(1);
    expect(useTerminalsStore.getState().activeByThread["a"]).toBeUndefined();
    expect(useTerminalsStore.getState().activeByThread["b"]).toBe("tb");
    expect(useTerminalsStore.getState().backfill["ta"]).toBeUndefined();
    expect(useTerminalsStore.getState().backfill["tb"]).toEqual(["keep"]);
    expect(useUiStore.getState().instanceByThread).toEqual({ b: "inst-b" });
    expect(useThreadsStore.getState().activeThreadId).toBeNull();
    expect(useThreadsStore.getState().threads.map((x) => x.id)).toEqual(["b"]);
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

describe("buildSidebarGroups child thread filtering", () => {
  const project: Project = {
    id: "proj-1",
    name: "Alpha",
    rootPath: "C:\\work\\alpha",
    color: "#346bf1",
    worktreeStrategy: "root",
    pinned: false,
    createdAt: 0,
  };

  const childInProject = (status: Thread["status"]): Thread => ({
    id: `child-proj-${status}`,
    projectId: "proj-1",
    title: "Child in project",
    status,
    pinned: true,
    createdAt: 0,
    updatedAt: 50,
    parentThreadId: "root-proj",
    depth: 1,
  });

  const childOrphan = (status: Thread["status"]): Thread => ({
    id: `child-orphan-${status}`,
    projectId: null,
    title: "Child orphan",
    status,
    pinned: true,
    createdAt: 0,
    updatedAt: 50,
    parentThreadId: "root-orphan",
    depth: 1,
  });

  it.each<SidebarFilter>(["all", "unread", "pinned", "working", "archived"])(
    "hides child threads in projects and No project under '%s' filter",
    (filter) => {
      const rootProj: Thread = {
        ...t("root-proj", filter === "archived" ? "archived" : "working", true, 40),
        projectId: "proj-1",
        title: "Root in project",
      };
      const rootOrphan: Thread = {
        ...t("root-orphan", filter === "archived" ? "archived" : "working", true, 30),
        projectId: null,
        title: "Root orphan",
      };
      const allThreads: Thread[] = [
        rootProj,
        rootOrphan,
        childInProject("working"),
        childInProject("waiting"),
        childInProject("archived"),
        childOrphan("working"),
        childOrphan("waiting"),
        childOrphan("archived"),
      ];
      const unreadIds = new Set(allThreads.map((item) => item.id));

      for (const query of ["", "child", "alpha"]) {
        const groups = buildSidebarGroups([project], allThreads, { query, filter, unreadIds });
        const renderedIds = groups.flatMap((g) => g.threads.map((item) => item.id));
        expect(renderedIds).not.toContain("child-proj-working");
        expect(renderedIds).not.toContain("child-proj-waiting");
        expect(renderedIds).not.toContain("child-proj-archived");
        expect(renderedIds).not.toContain("child-orphan-working");
        expect(renderedIds).not.toContain("child-orphan-waiting");
        expect(renderedIds).not.toContain("child-orphan-archived");
      }
    },
  );

  it("omits the No project group when only child threads have projectId === null", () => {
    const groups = buildSidebarGroups([project], [childOrphan("working"), childOrphan("draft")], {
      query: "",
      filter: "all",
      unreadIds: new Set(["child-orphan-working"]),
    });
    expect(groups.find((g) => g.project === null)).toBeUndefined();
  });
});
