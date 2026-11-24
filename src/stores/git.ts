import { create } from "zustand";
import {
  gitCheckpointDiff,
  gitCheckpointDiffFile,
  gitCheckpointRestore,
  gitCheckpointsList,
  gitCommit,
  gitDiffFile,
  gitDiffSummary,
  gitGhAvailable,
  gitPrCreate,
  gitPush,
  gitStatus,
  ipcErrorMessage,
  isIpcError,
} from "../lib/ipc";
import type { CommitOutcome, DiffFile, GitDiffSummary, GitStatus } from "../lib/types";

export type DiffViewMode = "unified" | "split";

export interface PrRecord {
  threadId: string;
  threadTitle: string;
  title: string;
  url: string;
  createdAt: number;
}

export interface FilePatchState {
  loading: boolean;
  file?: DiffFile;
  patchHash?: string;
  error?: string;
}

/** One checkpoint turn opened in the diff panel, diffed against its parent. */
export interface ActiveCheckpointState {
  runId: string;
  diff: GitDiffSummary;
  filePatches: Record<string, FilePatchState>;
  loading: boolean;
  error: string | null;
}

export interface GitThreadState {
  status: GitStatus | null;
  diff: GitDiffSummary | null;
  /** Patch bodies, fetched lazily when a file row expands. */
  filePatches: Record<string, FilePatchState>;
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
  /** path → patch hash of the diff text the user reviewed. */
  reviewed: Record<string, string>;
  /** Hidden checkpoint run ids, oldest first. */
  checkpoints: string[];
  /** Historical turn diff currently inspected; null shows the worktree. */
  activeCheckpoint: ActiveCheckpointState | null;
  /** Checkpoint run id whose worktree restore is in flight. */
  restoringCheckpoint: string | null;
  /** Safety checkpoint of the files the last rollback replaced; undo pointer. */
  restoreBackupId?: string | null;
}

interface GitStore {
  byThread: Record<string, GitThreadState>;
  viewMode: DiffViewMode;
  ghAvailable: boolean;
  ghLoaded: boolean;
  prHistory: PrRecord[];
  refresh: (threadId: string) => Promise<void>;
  commit: (threadId: string) => Promise<boolean>;
  push: (threadId: string) => Promise<boolean>;
  createPr: (threadId: string, threadTitle: string) => Promise<boolean>;
  setCommitMessage: (threadId: string, message: string) => void;
  toggleReviewed: (threadId: string, path: string, patchHash: string) => void;
  loadFileDiff: (threadId: string, path: string) => Promise<void>;
  loadCheckpoints: (threadId: string) => Promise<void>;
  viewCheckpointDiff: (threadId: string, runId: string) => Promise<void>;
  loadCheckpointFileDiff: (threadId: string, runId: string, path: string) => Promise<void>;
  clearCheckpointView: (threadId: string) => void;
  /** Rolls back files; `restoreBackupId` keeps the safety checkpoint for undo. */
  restoreCheckpoint: (threadId: string, runId: string) => Promise<boolean>;
  /** Puts the files replaced by the last rollback back in place. */
  undoRestore: (threadId: string) => Promise<boolean>;
  setViewMode: (mode: DiffViewMode) => void;
  loadGhAvailability: () => Promise<void>;
  /** Drops a deleted thread's git state and any refresh it still has queued. */
  clearThread: (threadId: string) => void;
}

function emptyState(): GitThreadState {
  return {
    status: null,
    diff: null,
    filePatches: {},
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
    checkpoints: [],
    activeCheckpoint: null,
    restoringCheckpoint: null,
    /** Safety checkpoint of the files replaced by the last rollback. */
    restoreBackupId: null,
  };
}

/** The checkpoint's parent run, or null for the first one (parent commit). */
function baseRunIdFor(checkpoints: string[], runId: string): string | null {
  const idx = checkpoints.indexOf(runId);
  return idx > 0 ? checkpoints[idx - 1] : null;
}

const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** One gh probe per session wave; parallel panel mounts share the result. */
let ghInFlight: Promise<void> | null = null;

/** Guards a checkpoint view against a clear/switch while its diff loads. */
const viewSeqByThread = new Map<string, number>();

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
  ghLoaded: false,
  prHistory: [],

  refresh: async (threadId) => {
    set((s) => ({
      byThread: {
        ...s.byThread,
        [threadId]: { ...(s.byThread[threadId] ?? emptyState()), loading: true },
      },
    }));
    try {
      const [status, diff] = await Promise.all([gitStatus(threadId), gitDiffSummary(threadId)]);
      set((s) => {
        const prev = s.byThread[threadId] ?? emptyState();
        const hashes = new Map(diff.files.map((file) => [file.path, file.patchHash]));
        // Reviewed flags and cached patches reset when a file's patch changed.
        const reviewed: Record<string, string> = {};
        for (const [path, hash] of Object.entries(prev.reviewed)) {
          if (hashes.get(path) === hash) reviewed[path] = hash;
        }
        const filePatches: Record<string, FilePatchState> = {};
        for (const [path, patch] of Object.entries(prev.filePatches)) {
          if (patch.patchHash && hashes.get(path) === patch.patchHash) filePatches[path] = patch;
        }
        return {
          byThread: {
            ...s.byThread,
            [threadId]: {
              ...prev,
              status,
              diff,
              filePatches,
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

  loadFileDiff: async (threadId, path) => {
    const state = get().byThread[threadId];
    if (!state) return;
    const existing = state.filePatches[path];
    if (existing?.loading || existing?.file) return;
    const summary = state.diff?.files.find((file) => file.path === path);
    if (!summary) return;

    set((s) => {
      const prev = s.byThread[threadId] ?? emptyState();
      return {
        byThread: {
          ...s.byThread,
          [threadId]: {
            ...prev,
            filePatches: { ...prev.filePatches, [path]: { loading: true } },
          },
        },
      };
    });

    try {
      const file = await gitDiffFile(threadId, path, state.diff?.base ?? null);
      set((s) => {
        const prev = s.byThread[threadId];
        if (!prev) return s;
        return {
          byThread: {
            ...s.byThread,
            [threadId]: {
              ...prev,
              filePatches: {
                ...prev.filePatches,
                [path]: { loading: false, file, patchHash: summary.patchHash },
              },
            },
          },
        };
      });
    } catch (err) {
      set((s) => {
        const prev = s.byThread[threadId];
        if (!prev) return s;
        return {
          byThread: {
            ...s.byThread,
            [threadId]: {
              ...prev,
              filePatches: {
                ...prev.filePatches,
                [path]: { loading: false, error: ipcErrorMessage(err) },
              },
            },
          },
        };
      });
    }
  },

  loadCheckpoints: async (threadId) => {
    try {
      const checkpoints = await gitCheckpointsList(threadId);
      set((s) => ({
        byThread: {
          ...s.byThread,
          [threadId]: {
            ...(s.byThread[threadId] ?? emptyState()),
            checkpoints: Array.isArray(checkpoints) ? checkpoints : [],
          },
        },
      }));
    } catch (err) {
      // Not a repo / transient failure: keep whatever list we had.
      console.error("git_checkpoints_list failed", err);
    }
  },

  viewCheckpointDiff: async (threadId, runId) => {
    const seq = (viewSeqByThread.get(threadId) ?? 0) + 1;
    viewSeqByThread.set(threadId, seq);
    // The parent run comes from the ordered list; a cold panel has none yet.
    if ((get().byThread[threadId]?.checkpoints.length ?? 0) === 0) {
      await get().loadCheckpoints(threadId);
    }
    // The reader closed the checkpoint or opened another one while loading.
    if (viewSeqByThread.get(threadId) !== seq) return;
    const baseRunId = baseRunIdFor(get().byThread[threadId]?.checkpoints ?? [], runId);
    set((s) => ({
      byThread: {
        ...s.byThread,
        [threadId]: {
          ...(s.byThread[threadId] ?? emptyState()),
          activeCheckpoint: {
            runId,
            diff: { repoRoot: "", base: runId, totalAdded: 0, totalRemoved: 0, files: [] },
            filePatches: {},
            loading: true,
            error: null,
          },
        },
      },
    }));
    try {
      const diff = await gitCheckpointDiff(threadId, runId, baseRunId);
      set((s) => {
        const prev = s.byThread[threadId];
        if (!prev?.activeCheckpoint || prev.activeCheckpoint.runId !== runId) return s;
        return {
          byThread: {
            ...s.byThread,
            [threadId]: {
              ...prev,
              activeCheckpoint: { ...prev.activeCheckpoint, diff, loading: false },
            },
          },
        };
      });
    } catch (err) {
      set((s) => {
        const prev = s.byThread[threadId];
        if (!prev?.activeCheckpoint || prev.activeCheckpoint.runId !== runId) return s;
        return {
          byThread: {
            ...s.byThread,
            [threadId]: {
              ...prev,
              activeCheckpoint: {
                ...prev.activeCheckpoint,
                loading: false,
                error: ipcErrorMessage(err),
              },
            },
          },
        };
      });
    }
  },

  loadCheckpointFileDiff: async (threadId, runId, path) => {
    const prev = get().byThread[threadId];
    const active = prev?.activeCheckpoint;
    if (!active || active.runId !== runId) return;
    const existing = active.filePatches[path];
    if (existing?.loading || existing?.file) return;
    const baseRunId = baseRunIdFor(prev.checkpoints, runId);

    set((s) => {
      const state = s.byThread[threadId];
      if (!state?.activeCheckpoint || state.activeCheckpoint.runId !== runId) return s;
      return {
        byThread: {
          ...s.byThread,
          [threadId]: {
            ...state,
            activeCheckpoint: {
              ...state.activeCheckpoint,
              filePatches: { ...state.activeCheckpoint.filePatches, [path]: { loading: true } },
            },
          },
        },
      };
    });

    try {
      const file = await gitCheckpointDiffFile(threadId, runId, path, baseRunId);
      set((s) => {
        const state = s.byThread[threadId];
        if (!state?.activeCheckpoint || state.activeCheckpoint.runId !== runId) return s;
        return {
          byThread: {
            ...s.byThread,
            [threadId]: {
              ...state,
              activeCheckpoint: {
                ...state.activeCheckpoint,
                filePatches: {
                  ...state.activeCheckpoint.filePatches,
                  [path]: { loading: false, file },
                },
              },
            },
          },
        };
      });
    } catch (err) {
      set((s) => {
        const state = s.byThread[threadId];
        if (!state?.activeCheckpoint || state.activeCheckpoint.runId !== runId) return s;
        return {
          byThread: {
            ...s.byThread,
            [threadId]: {
              ...state,
              activeCheckpoint: {
                ...state.activeCheckpoint,
                filePatches: {
                  ...state.activeCheckpoint.filePatches,
                  [path]: { loading: false, error: ipcErrorMessage(err) },
                },
              },
            },
          },
        };
      });
    }
  },

  clearCheckpointView: (threadId) => {
    viewSeqByThread.set(threadId, (viewSeqByThread.get(threadId) ?? 0) + 1);
    set((s) => {
      const prev = s.byThread[threadId];
      if (!prev) return s;
      return { byThread: { ...s.byThread, [threadId]: { ...prev, activeCheckpoint: null } } };
    });
  },

  restoreCheckpoint: async (threadId, runId) => {
    if (get().byThread[threadId]?.restoringCheckpoint) return false;
    set((s) => ({
      byThread: {
        ...s.byThread,
        [threadId]: {
          ...(s.byThread[threadId] ?? emptyState()),
          restoringCheckpoint: runId,
          error: null,
        },
      },
    }));
    try {
      const backupId = await gitCheckpointRestore(threadId, runId);
      set((s) => {
        const prev = s.byThread[threadId] ?? emptyState();
        return {
          byThread: {
            ...s.byThread,
            [threadId]: {
              ...prev,
              restoringCheckpoint: null,
              activeCheckpoint: null,
              restoreBackupId: backupId ?? null,
            },
          },
        };
      });
      await Promise.all([get().refresh(threadId), get().loadCheckpoints(threadId)]);
      return true;
    } catch (err) {
      set((s) => ({
        byThread: {
          ...s.byThread,
          [threadId]: {
            ...(s.byThread[threadId] ?? emptyState()),
            restoringCheckpoint: null,
            error: ipcErrorMessage(err),
          },
        },
      }));
      return false;
    }
  },

  undoRestore: async (threadId) => {
    const backupId = get().byThread[threadId]?.restoreBackupId;
    if (!backupId || get().byThread[threadId]?.restoringCheckpoint) return false;
    set((s) => ({
      byThread: {
        ...s.byThread,
        [threadId]: { ...(s.byThread[threadId] ?? emptyState()), restoringCheckpoint: backupId },
      },
    }));
    try {
      await gitCheckpointRestore(threadId, backupId);
      set((s) => {
        const prev = s.byThread[threadId] ?? emptyState();
        return {
          byThread: {
            ...s.byThread,
            [threadId]: { ...prev, restoringCheckpoint: null, restoreBackupId: null },
          },
        };
      });
      await Promise.all([get().refresh(threadId), get().loadCheckpoints(threadId)]);
      return true;
    } catch (err) {
      set((s) => ({
        byThread: {
          ...s.byThread,
          [threadId]: {
            ...(s.byThread[threadId] ?? emptyState()),
            restoringCheckpoint: null,
            error: ipcErrorMessage(err),
          },
        },
      }));
      return false;
    }
  },

  toggleReviewed: (threadId, path, patchHash) =>
    set((s) => {
      const prev = s.byThread[threadId] ?? emptyState();
      const reviewed = { ...prev.reviewed };
      if (reviewed[path] === patchHash) {
        delete reviewed[path];
      } else {
        reviewed[path] = patchHash;
      }
      return {
        byThread: {
          ...s.byThread,
          [threadId]: { ...prev, reviewed },
        },
      };
    }),

  setViewMode: (mode) => set({ viewMode: mode }),

  loadGhAvailability: () => {
    if (get().ghLoaded) return Promise.resolve();
    if (ghInFlight) return ghInFlight;
    ghInFlight = (async () => {
      try {
        const ghAvailable = await gitGhAvailable();
        set({ ghAvailable, ghLoaded: true });
      } catch (err) {
        // Leave ghLoaded false so the next mount retries instead of caching a
        // transient IPC failure as "no gh CLI".
        console.error("gh availability check failed", err);
        set({ ghAvailable: false, ghLoaded: false });
      } finally {
        ghInFlight = null;
      }
    })();
    return ghInFlight;
  },

  clearThread: (threadId) => {
    const timer = debounceTimers.get(threadId);
    if (timer !== undefined) {
      clearTimeout(timer);
      debounceTimers.delete(threadId);
    }
    set((s) => {
      if (!(threadId in s.byThread)) return s;
      const { [threadId]: _dropped, ...byThread } = s.byThread;
      void _dropped;
      return { byThread };
    });
  },
}));
