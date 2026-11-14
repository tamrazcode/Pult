import { create } from "zustand";
import {
  gitCommit,
  gitDiff,
  gitGhAvailable,
  gitPrCreate,
  gitPush,
  gitStatus,
  ipcErrorMessage,
  isIpcError,
} from "../lib/ipc";
import { diffHash } from "../lib/diffSplit";
import type { CommitOutcome, GitDiff, GitStatus } from "../lib/types";

export type DiffViewMode = "unified" | "split";

export interface PrRecord {
  threadId: string;
  threadTitle: string;
  title: string;
  url: string;
  createdAt: number;
}

export interface GitThreadState {
  status: GitStatus | null;
  diff: GitDiff | null;
  /** True when the thread's workspace is not a git repo. */
  notRepo: boolean;
  loading: boolean;
  error: string | null;
  commitMessage: string;
  busy: "commit" | "push" | "pr" | null;
  lastCommit: CommitOutcome | null;
  lastCommitMessage: string | null;
  /** The commit sha known to be on the remote (gates the PR button). */
  pushedSha: string | null;
  prUrl: string | null;
  /** path → hash of the diff text the user reviewed. */
  reviewed: Record<string, string>;
}

interface GitStore {
  byThread: Record<string, GitThreadState>;
  viewMode: DiffViewMode;
  ghAvailable: boolean;
  prHistory: PrRecord[];
  refresh: (threadId: string) => Promise<void>;
  commit: (threadId: string) => Promise<boolean>;
  push: (threadId: string) => Promise<boolean>;
  createPr: (threadId: string, threadTitle: string) => Promise<boolean>;
  setCommitMessage: (threadId: string, message: string) => void;
  toggleReviewed: (threadId: string, path: string, raw: string) => void;
  setViewMode: (mode: DiffViewMode) => void;
  loadGhAvailability: () => Promise<void>;
}

function emptyState(): GitThreadState {
  return {
    status: null,
    diff: null,
    notRepo: false,
    loading: false,
    error: null,
    commitMessage: "",
    busy: null,
    lastCommit: null,
    lastCommitMessage: null,
    pushedSha: null,
    prUrl: null,
    reviewed: {},
  };
}

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Debounced refresh — file_changed events arrive per write mid-turn. */
export function scheduleGitRefresh(threadId: string, delayMs = 600): void {
  const existing = debounceTimers.get(threadId);
  if (existing) clearTimeout(existing);
  debounceTimers.set(
    threadId,
    setTimeout(() => {
      debounceTimers.delete(threadId);
      void useGitStore.getState().refresh(threadId);
    }, delayMs),
  );
}

export const useGitStore = create<GitStore>((set, get) => ({
  byThread: {},
  viewMode: "unified",
  ghAvailable: false,
  prHistory: [],

  refresh: async (threadId) => {
    set((s) => ({
      byThread: {
        ...s.byThread,
        [threadId]: { ...(s.byThread[threadId] ?? emptyState()), loading: true },
      },
    }));
    try {
      const [status, diff] = await Promise.all([gitStatus(threadId), gitDiff(threadId)]);
      set((s) => {
        const prev = s.byThread[threadId] ?? emptyState();
        // Reviewed flags reset when a file's diff changed.
        const reviewed: Record<string, string> = {};
        for (const [path, hash] of Object.entries(prev.reviewed)) {
          const file = diff.files.find((f) => f.path === path);
          if (file && diffHash(file.raw) === hash) reviewed[path] = hash;
        }
        return {
          byThread: {
            ...s.byThread,
            [threadId]: {
              ...prev,
              status,
              diff,
              notRepo: false,
              loading: false,
              error: null,
              reviewed,
            },
          },
        };
      });
    } catch (err) {
      const notRepo = isIpcError(err) && err.code === "git.not_a_repo";
      set((s) => ({
        byThread: {
          ...s.byThread,
          [threadId]: {
            ...(s.byThread[threadId] ?? emptyState()),
            notRepo,
            loading: false,
            error: notRepo ? null : ipcErrorMessage(err),
          },
        },
      }));
    }
  },

  commit: async (threadId) => {
    const state = get().byThread[threadId];
    if (!state || !state.commitMessage.trim()) return false;
    set((s) => ({
      byThread: {
        ...s.byThread,
        [threadId]: { ...(s.byThread[threadId] ?? emptyState()), busy: "commit" },
      },
    }));
    try {
      const outcome = await gitCommit(threadId, state.commitMessage.trim());
      set((s) => {
        const prev = s.byThread[threadId] ?? emptyState();
        return {
          byThread: {
            ...s.byThread,
            [threadId]: {
              ...prev,
              busy: null,
              lastCommit: outcome,
              lastCommitMessage: state.commitMessage.trim(),
              commitMessage: "",
            },
          },
        };
      });
      await get().refresh(threadId);
      return true;
    } catch (err) {
      set((s) => ({
        byThread: {
          ...s.byThread,
          [threadId]: {
            ...(s.byThread[threadId] ?? emptyState()),
            busy: null,
            error: ipcErrorMessage(err),
          },
        },
      }));
      return false;
    }
  },

  push: async (threadId) => {
    set((s) => ({
      byThread: {
        ...s.byThread,
        [threadId]: { ...(s.byThread[threadId] ?? emptyState()), busy: "push" },
      },
    }));
    try {
      await gitPush(threadId);
      set((s) => {
        const prev = s.byThread[threadId] ?? emptyState();
        // A successful push unblocks the PR button even without a tracked
        // lastCommit (e.g. after an app restart pushed an existing branch).
        return {
          byThread: {
            ...s.byThread,
            [threadId]: { ...prev, busy: null, pushedSha: prev.lastCommit?.sha ?? "pushed" },
          },
        };
      });
      await get().refresh(threadId);
      return true;
    } catch (err) {
      set((s) => ({
        byThread: {
          ...s.byThread,
          [threadId]: {
            ...(s.byThread[threadId] ?? emptyState()),
            busy: null,
            error: ipcErrorMessage(err),
          },
        },
      }));
      return false;
    }
  },

  createPr: async (threadId, threadTitle) => {
    set((s) => ({
      byThread: {
        ...s.byThread,
        [threadId]: { ...(s.byThread[threadId] ?? emptyState()), busy: "pr" },
      },
    }));
    try {
      const state = get().byThread[threadId];
      // The commit message is the natural PR title; fall back to the thread.
      const title = state?.lastCommitMessage?.trim() || threadTitle;
      const outcome = await gitPrCreate(
        threadId,
        title,
        `Opened from pult (thread ${threadTitle}).`,
      );
      set((s) => {
        const prev = s.byThread[threadId] ?? emptyState();
        return {
          byThread: {
            ...s.byThread,
            [threadId]: { ...prev, busy: null, prUrl: outcome.url },
          },
          prHistory: [
            ...s.prHistory.filter((p) => p.url !== outcome.url),
            {
              threadId,
              threadTitle,
              title,
              url: outcome.url,
              createdAt: Date.now(),
            },
          ],
        };
      });
      return true;
    } catch (err) {
      set((s) => ({
        byThread: {
          ...s.byThread,
          [threadId]: {
            ...(s.byThread[threadId] ?? emptyState()),
            busy: null,
            error: ipcErrorMessage(err),
          },
        },
      }));
      return false;
    }
  },

  setCommitMessage: (threadId, message) =>
    set((s) => ({
      byThread: {
        ...s.byThread,
        [threadId]: { ...(s.byThread[threadId] ?? emptyState()), commitMessage: message },
      },
    })),

  toggleReviewed: (threadId, path, raw) =>
    set((s) => {
      const prev = s.byThread[threadId] ?? emptyState();
      const hash = diffHash(raw);
      const reviewed = { ...prev.reviewed };
      if (reviewed[path] === hash) {
        delete reviewed[path];
      } else {
        reviewed[path] = hash;
      }
      return {
        byThread: {
          ...s.byThread,
          [threadId]: { ...prev, reviewed },
        },
      };
    }),

  setViewMode: (mode) => set({ viewMode: mode }),

  loadGhAvailability: async () => {
    set({ ghAvailable: await gitGhAvailable() });
  },
}));
