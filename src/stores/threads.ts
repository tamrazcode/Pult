import { create } from "zustand";
import {
  ipcErrorMessage,
  onThreadUpdate,
  threadsCreate,
  threadsDelete,
  threadsList,
  threadsRename,
  threadsSetPinned,
  threadsSetStatus,
} from "../lib/ipc";
import { isTauri } from "../lib/tauri";
import { useUiStore } from "../stores/ui";
import type { Thread } from "../lib/types";

// Mirrors the data model (§4.2). Persistence lives in the Rust core; this is the UI projection.
export type { Thread };
export type ThreadStatus = Thread["status"];

export type ShelfName = "drafts" | "working" | "snoozed" | "settled" | "pinned";

const SHELF_FILTER: Record<ShelfName, (t: Thread) => boolean> = {
  drafts: (t) => t.status === "draft" && !t.pinned,
  working: (t) => t.status === "working" || t.status === "waiting",
  snoozed: (t) => t.status === "snoozed" && !t.pinned,
  settled: (t) => t.status === "settled" && !t.pinned,
  pinned: (t) => t.pinned,
};

export function threadsInShelf(threads: Thread[], shelf: ShelfName): Thread[] {
  return threads.filter(SHELF_FILTER[shelf]);
}

function sortThreads(threads: Thread[]): Thread[] {
  return [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
}

function upsertSorted(threads: Thread[], thread: Thread): Thread[] {
  return sortThreads([thread, ...threads.filter((t) => t.id !== thread.id)]);
}

interface ThreadsState {
  threads: Thread[];
  activeThreadId: string | null;
  /** True once threads_list ran (stores stay empty in a plain browser). */
  loaded: boolean;
  setActiveThread: (id: string | null) => void;
  /** Upserts one thread (local echo + "thread:update" events). */
  upsertThread: (thread: Thread) => void;
  /** Patches the title locally; for renames the backend already persisted. */
  renameThreadLocal: (threadId: string, title: string) => void;
  removeThread: (threadId: string) => void;
  loadThreads: () => Promise<void>;
  createThread: (
    projectId: string | null,
    title: string,
    options?: { workspace?: string | null; worktree?: boolean },
  ) => Promise<Thread>;
  renameThread: (threadId: string, title: string) => Promise<void>;
  deleteThread: (threadId: string) => Promise<void>;
  setThreadStatus: (threadId: string, status: ThreadStatus) => Promise<void>;
  setThreadPinned: (threadId: string, pinned: boolean) => Promise<void>;
}

let unlistenThreadUpdates: (() => void) | null = null;

/** Subscribes "thread:update" once per session; no-op outside Tauri. */
export async function ensureThreadUpdateSubscription(): Promise<void> {
  if (!isTauri() || unlistenThreadUpdates) return;
  unlistenThreadUpdates = await onThreadUpdate((thread) => {
    useThreadsStore.getState().upsertThread(thread);
  });
}

export const useThreadsStore = create<ThreadsState>((set, get) => ({
  threads: [],
  activeThreadId: null,
  loaded: false,
  setActiveThread: (activeThreadId) => set({ activeThreadId }),
  upsertThread: (thread) => set((s) => ({ threads: upsertSorted(s.threads, thread) })),
  renameThreadLocal: (threadId, title) =>
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId ? { ...t, title, updatedAt: Date.now() } : t,
      ),
    })),
  removeThread: (threadId) => set((s) => ({ threads: s.threads.filter((t) => t.id !== threadId) })),

  loadThreads: async () => {
    await ensureThreadUpdateSubscription();
    try {
      const threads = await threadsList(); // [] outside Tauri
      set({ threads: sortThreads(threads), loaded: true });
    } catch (err) {
      console.error("threads_list failed", err);
      // Storage failures get a designed banner (§8 M7), not a silent list.
      useUiStore.getState().setGlobalError({ kind: "storage", message: ipcErrorMessage(err) });
      set({ loaded: true });
    }
  },

  createThread: async (projectId, title, options) => {
    const thread = await threadsCreate(
      projectId,
      title,
      options?.workspace ?? undefined,
      options?.worktree ?? false,
    );
    get().upsertThread(thread);
    return thread;
  },

  renameThread: async (threadId, title) => {
    await threadsRename(threadId, title);
    set((s) => ({
      threads: s.threads.map((t) => (t.id === threadId ? { ...t, title } : t)),
    }));
  },

  deleteThread: async (threadId) => {
    await threadsDelete(threadId);
    get().removeThread(threadId);
  },

  setThreadStatus: async (threadId, status) => {
    await threadsSetStatus(threadId, status);
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId ? { ...t, status, pinned: status === "draft" ? false : t.pinned } : t,
      ),
    }));
  },

  setThreadPinned: async (threadId, pinned) => {
    await threadsSetPinned(threadId, pinned);
    set((s) => ({
      threads: s.threads.map((t) => (t.id === threadId ? { ...t, pinned } : t)),
    }));
  },
}));
