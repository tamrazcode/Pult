import { create } from "zustand";
import {
  ipcErrorMessage,
  onThreadUpdate,
  settingsGet,
  settingsSet,
  threadsCreate,
  threadsDelete,
  threadsList,
  threadsRename,
  threadsSetPinned,
  threadsSetStatus,
} from "../lib/ipc";
import { isTauri } from "../lib/tauri";
import { useUiStore } from "../stores/ui";
import type { Project, Thread } from "../lib/types";

// Mirrors the data model (§4.2). Persistence lives in the Rust core; this is the UI projection.
export type { Thread };
export type ThreadStatus = Thread["status"];

export type SidebarFilter = "all" | "unread" | "pinned" | "working" | "archived";

export interface SidebarGroup {
  project: Project | null; // null = "No project" (rendered last)
  threads: Thread[];
}

function sortThreads(threads: Thread[]): Thread[] {
  return [...threads].sort((a, b) => b.updatedAt - a.updatedAt);
}

function sortGroupThreads(threads: Thread[]): Thread[] {
  return [...threads].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt,
  );
}

/** Pure sidebar projection: projects, filters, search, unread, archive. */
export function buildSidebarGroups(
  projects: Project[],
  threads: Thread[],
  opts: { query: string; filter: SidebarFilter; unreadIds: Set<string> },
): SidebarGroup[] {
  const query = opts.query.trim().toLowerCase();
  const matches = (thread: Thread): boolean => {
    if (opts.filter === "archived") {
      if (thread.status !== "archived") return false;
    } else if (thread.status === "archived") {
      return false;
    }
    if (opts.filter === "unread" && !opts.unreadIds.has(thread.id)) return false;
    if (opts.filter === "pinned" && !thread.pinned) return false;
    if (opts.filter === "working" && thread.status !== "working" && thread.status !== "waiting") {
      return false;
    }
    return query === "" || thread.title.toLowerCase().includes(query);
  };

  const visible = threads.filter(matches);
  const orderedProjects = [...projects].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name),
  );
  const groups: SidebarGroup[] = orderedProjects.map((project) => ({
    project,
    threads: sortGroupThreads(visible.filter((thread) => thread.projectId === project.id)),
  }));
  const keepEmptyProjects = opts.filter === "all" && query === "";
  const shown = keepEmptyProjects ? groups : groups.filter((group) => group.threads.length > 0);
  const orphans = sortGroupThreads(visible.filter((thread) => thread.projectId === null));
  if (orphans.length > 0) shown.push({ project: null, threads: orphans });
  return shown;
}

function upsertSorted(threads: Thread[], thread: Thread): Thread[] {
  return sortThreads([thread, ...threads.filter((t) => t.id !== thread.id)]);
}

interface ThreadsState {
  threads: Thread[];
  activeThreadId: string | null;
  /** Threads with unseen agent output (persisted in settings). */
  unreadIds: string[];
  /** True once threads_list ran (stores stay empty in a plain browser). */
  loaded: boolean;
  setActiveThread: (id: string | null) => void;
  markUnread: (threadId: string, unread: boolean) => void;
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
  deleteThread: (
    threadId: string,
    worktreeMode?: "safe" | "keep" | "force_remove",
  ) => Promise<void>;
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
  unreadIds: [],
  loaded: false,
  setActiveThread: (activeThreadId) => {
    set({ activeThreadId });
    if (activeThreadId && get().unreadIds.includes(activeThreadId)) {
      get().markUnread(activeThreadId, false);
    }
  },
  markUnread: (threadId, unread) => {
    const ids = new Set(get().unreadIds);
    if (unread) ids.add(threadId);
    else ids.delete(threadId);
    const unreadIds = [...ids];
    set({ unreadIds });
    if (isTauri()) {
      void settingsSet("unread_threads", unreadIds).catch((err) =>
        console.error("unread_threads persist failed", err),
      );
    }
  },
  upsertThread: (thread) => set((s) => ({ threads: upsertSorted(s.threads, thread) })),
  renameThreadLocal: (threadId, title) =>
    set((s) => ({
      threads: s.threads.map((t) =>
        t.id === threadId ? { ...t, title, updatedAt: Date.now() } : t,
      ),
    })),
  removeThread: (threadId) =>
    set((s) => ({
      threads: s.threads.filter((t) => t.id !== threadId),
      unreadIds: s.unreadIds.filter((id) => id !== threadId),
    })),

  loadThreads: async () => {
    await ensureThreadUpdateSubscription();
    try {
      const [threads, savedUnread] = await Promise.all([
        threadsList(), // [] outside Tauri
        settingsGet("unread_threads"),
      ]);
      const savedIds = Array.isArray(savedUnread)
        ? savedUnread.filter((id): id is string => typeof id === "string")
        : [];
      // Merge with marks made while the snapshot was in flight; opening a
      // thread wins over a stale saved unread id.
      const merged = new Set([...savedIds, ...get().unreadIds]);
      const activeThreadId = get().activeThreadId;
      if (activeThreadId) merged.delete(activeThreadId);
      set({ threads: sortThreads(threads), unreadIds: [...merged], loaded: true });
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
      options?.worktree ?? null,
    );
    get().upsertThread(thread);
    return thread;
  },

  renameThread: async (threadId, title) => {
    try {
      await threadsRename(threadId, title);
      set((s) => ({
        threads: s.threads.map((t) => (t.id === threadId ? { ...t, title } : t)),
      }));
    } catch (err) {
      useUiStore.getState().setGlobalError({ kind: "protocol", message: ipcErrorMessage(err) });
    }
  },

  deleteThread: async (threadId, worktreeMode) => {
    try {
      await threadsDelete(threadId, worktreeMode);
      get().removeThread(threadId);
    } catch (err) {
      useUiStore.getState().setGlobalError({ kind: "protocol", message: ipcErrorMessage(err) });
      throw err;
    }
  },

  setThreadStatus: async (threadId, status) => {
    try {
      await threadsSetStatus(threadId, status);
      set((s) => ({
        threads: s.threads.map((t) =>
          t.id === threadId ? { ...t, status, pinned: status === "draft" ? false : t.pinned } : t,
        ),
      }));
    } catch (err) {
      useUiStore.getState().setGlobalError({ kind: "protocol", message: ipcErrorMessage(err) });
    }
  },

  setThreadPinned: async (threadId, pinned) => {
    try {
      await threadsSetPinned(threadId, pinned);
      set((s) => ({
        threads: s.threads.map((t) => (t.id === threadId ? { ...t, pinned } : t)),
      }));
    } catch (err) {
      useUiStore.getState().setGlobalError({ kind: "protocol", message: ipcErrorMessage(err) });
    }
  },
}));
