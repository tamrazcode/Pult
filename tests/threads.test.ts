import { beforeEach, describe, expect, it } from "vitest";
import { threadsInShelf, useThreadsStore } from "../src/stores/threads";
import type { ShelfName, Thread } from "../src/stores/threads";

const t = (id: string, status: Thread["status"], pinned = false, updatedAt = 0): Thread => ({
  id,
  projectId: null,
  title: id,
  status,
  pinned,
  createdAt: 0,
  updatedAt,
});

describe("threadsInShelf", () => {
  it("routes threads into shelves by status", () => {
    const threads = [t("a", "draft"), t("b", "working"), t("c", "waiting"), t("d", "settled")];
    expect(threadsInShelf(threads, "drafts").map((x) => x.id)).toEqual(["a"]);
    expect(threadsInShelf(threads, "working").map((x) => x.id)).toEqual(["b", "c"]);
    expect(threadsInShelf(threads, "settled").map((x) => x.id)).toEqual(["d"]);
    expect(threadsInShelf(threads, "pinned")).toEqual([]);
  });

  it("pinned threads leave their status shelf and appear only under pinned", () => {
    const threads = [t("a", "draft", true)];
    expect(threadsInShelf(threads, "drafts")).toEqual([]);
    expect(threadsInShelf(threads, "pinned").map((x) => x.id)).toEqual(["a"]);
  });

  it("keeps snoozed and waiting threads out of the other shelves", () => {
    const threads = [t("s", "snoozed"), t("w", "waiting"), t("g", "working")];
    const shelfIds = (shelf: ShelfName) => threadsInShelf(threads, shelf).map((x) => x.id);
    expect(shelfIds("snoozed")).toEqual(["s"]);
    expect(shelfIds("working")).toEqual(["w", "g"]);
    expect(shelfIds("drafts")).toEqual([]);
    expect(shelfIds("settled")).toEqual([]);
  });
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

  it("routes working/waiting threads into the working shelf after upsert", () => {
    useThreadsStore.getState().upsertThread(t("w", "working"));
    useThreadsStore.getState().upsertThread(t("q", "waiting"));
    const threads = useThreadsStore.getState().threads;
    expect(threadsInShelf(threads, "working").map((x) => x.id)).toEqual(["q", "w"]);
    expect(threadsInShelf(threads, "drafts")).toEqual([]);
  });

  it("removeThread drops the thread from the store", () => {
    useThreadsStore.getState().upsertThread(t("a", "draft"));
    useThreadsStore.getState().removeThread("a");
    expect(useThreadsStore.getState().threads).toEqual([]);
  });
});
