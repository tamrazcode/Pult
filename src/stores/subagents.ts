import { useMemo } from "react";
import { create } from "zustand";
import {
  orchestratorTasksList,
  type SubagentFinishedPayload,
  type SubagentSpawnedPayload,
} from "../lib/ipc";
import { isTauri } from "../lib/tauri";
import type { DelegatedTask } from "../lib/types";

interface SubagentsState {
  tasks: Record<string, DelegatedTask>;
  order: string[];
  /** Finishes seen before the task itself (spawn/load may arrive later). */
  finished: Record<string, SubagentFinishedPayload>;
  load: (threadId: string) => Promise<void>;
  upsert: (task: DelegatedTask) => void;
  applySpawned: (payload: SubagentSpawnedPayload) => void;
  applyFinished: (payload: SubagentFinishedPayload) => void;
  applyUpdated: (payload: SubagentFinishedPayload) => void;
  /** Removes the tasks delegated from a deleted thread. */
  clearThread: (threadId: string) => void;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "orphaned", "interrupted"]);

/** A stale snapshot or update must not resurrect a finished card, but an
 *  explicit retry (new childRunId) is a genuine new attempt. */
function mergeStatus(current: DelegatedTask | undefined, incoming: DelegatedTask): DelegatedTask {
  if (current && !isTaskActive(current.status) && isTaskActive(incoming.status)) {
    const sameAttempt = !incoming.childRunId || incoming.childRunId === current.childRunId;
    if (sameAttempt) return current;
  }
  return incoming;
}

/** Apply a finish that outran its spawn/load event. */
function withPendingFinish(
  task: DelegatedTask,
  pending: SubagentFinishedPayload | undefined,
): DelegatedTask {
  if (!pending || !isTaskActive(task.status)) return task;
  return {
    ...task,
    status: pending.status,
    summary: pending.summary ?? task.summary,
    error: pending.error ?? task.error,
    finishedAt: task.finishedAt ?? Date.now(),
  };
}

/** App-owned subagents, keyed by task id. Child runs are invisible here:
 *  a card is the only surface a parent thread shows. */
export const useSubagentsStore = create<SubagentsState>()((set, get) => ({
  tasks: {},
  order: [],
  finished: {},
  load: async (threadId) => {
    if (!isTauri()) return;
    const tasks = await orchestratorTasksList(threadId).catch(() => []);
    set((state) => {
      const next = { ...state.tasks };
      const order = [...state.order];
      for (const task of tasks) {
        next[task.taskId] = withPendingFinish(
          mergeStatus(state.tasks[task.taskId], task),
          state.finished[task.taskId],
        );
        if (!order.includes(task.taskId)) order.push(task.taskId);
      }
      return { tasks: next, order };
    });
  },
  upsert: (task) => {
    set((state) => {
      const finished = { ...state.finished };
      delete finished[task.taskId];
      return {
        tasks: {
          ...state.tasks,
          [task.taskId]: withPendingFinish(
            mergeStatus(state.tasks[task.taskId], task),
            state.finished[task.taskId],
          ),
        },
        order: state.order.includes(task.taskId) ? state.order : [...state.order, task.taskId],
        finished,
      };
    });
  },
  applySpawned: ({ task }) => get().upsert(task),
  applyFinished: ({ taskId, status, summary, error }) => {
    const current = get().tasks[taskId];
    if (!current) {
      set((state) => ({
        finished: { ...state.finished, [taskId]: { taskId, status, summary, error } },
      }));
      return;
    }
    get().upsert({
      ...current,
      status,
      summary: summary ?? current.summary,
      error: error ?? current.error,
      finishedAt: current.finishedAt ?? Date.now(),
    });
  },
  applyUpdated: ({ taskId, status, summary, error }) => {
    const current = get().tasks[taskId];
    if (!current) {
      if (!isTaskActive(status)) {
        set((state) => ({
          finished: { ...state.finished, [taskId]: { taskId, status, summary, error } },
        }));
      }
      return;
    }
    if (!isTaskActive(current.status) && isTaskActive(status)) return;
    const active = isTaskActive(status);
    get().upsert({
      ...current,
      status,
      summary: active ? undefined : (summary ?? current.summary),
      error: active ? undefined : (error ?? current.error),
      finishedAt: active ? null : (current.finishedAt ?? Date.now()),
    });
  },
  clearThread: (threadId) =>
    set((state) => {
      const dropped = new Set(
        Object.values(state.tasks)
          .filter((task) => task.parentThreadId === threadId)
          .map((task) => task.taskId),
      );
      if (dropped.size === 0) return state;
      return {
        tasks: Object.fromEntries(
          Object.entries(state.tasks).filter(([taskId]) => !dropped.has(taskId)),
        ),
        order: state.order.filter((taskId) => !dropped.has(taskId)),
      };
    }),
}));

export function isTaskActive(status: string): boolean {
  return !TERMINAL_STATUSES.has(status);
}

/** Tasks delegated from one thread, oldest first. */
export function useThreadSubagents(threadId: string | undefined): DelegatedTask[] {
  const tasks = useSubagentsStore((state) => state.tasks);
  const order = useSubagentsStore((state) => state.order);
  return useMemo(() => {
    if (!threadId) return [];
    const seen = new Set<string>();
    return order
      .map((id) => tasks[id])
      .filter((task): task is DelegatedTask => {
        if (!task || task.parentThreadId !== threadId) return false;
        if (seen.has(task.taskId) || seen.has(task.childThreadId)) return false;
        seen.add(task.taskId);
        seen.add(task.childThreadId);
        return true;
      });
  }, [tasks, order, threadId]);
}
