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
  load: (threadId: string) => Promise<void>;
  upsert: (task: DelegatedTask) => void;
  applySpawned: (payload: SubagentSpawnedPayload) => void;
  applyFinished: (payload: SubagentFinishedPayload) => void;
  applyUpdated: (payload: SubagentFinishedPayload) => void;
  /** Removes the tasks delegated from a deleted thread. */
  clearThread: (threadId: string) => void;
}

/** App-owned subagents, keyed by task id. Child runs are invisible here:
 *  a card is the only surface a parent thread shows. */
export const useSubagentsStore = create<SubagentsState>()((set, get) => ({
  tasks: {},
  order: [],
  load: async (threadId) => {
    if (!isTauri()) return;
    const tasks = await orchestratorTasksList(threadId).catch(() => []);
    set((state) => {
      const next = { ...state.tasks };
      const order = [...state.order];
      for (const task of tasks) {
        next[task.taskId] = task;
        if (!order.includes(task.taskId)) order.push(task.taskId);
      }
      return { tasks: next, order };
    });
  },
  upsert: (task) => {
    set((state) => ({
      tasks: { ...state.tasks, [task.taskId]: task },
      order: state.order.includes(task.taskId) ? state.order : [...state.order, task.taskId],
    }));
  },
  applySpawned: ({ task }) => get().upsert(task),
  applyFinished: ({ taskId, status, summary, error }) => {
    const current = get().tasks[taskId];
    if (!current) return;
    get().upsert({
      ...current,
      status,
      summary: summary ?? current.summary,
      error: error ?? current.error,
      finishedAt: Date.now(),
    });
  },
  applyUpdated: ({ taskId, status }) => {
    const current = get().tasks[taskId];
    if (!current) return;
    const active = isTaskActive(status);
    get().upsert({
      ...current,
      status,
      summary: active ? undefined : current.summary,
      error: active ? undefined : current.error,
      finishedAt: active ? null : current.finishedAt,
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
  return !["completed", "failed", "cancelled", "orphaned", "interrupted"].includes(status);
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
