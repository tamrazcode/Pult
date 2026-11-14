import { threadsGet } from "./ipc";
import { useRunsStore } from "../stores/runs";
import { useThreadsStore } from "../stores/threads";

/**
 * Loads one thread's transcript on route open and hydrates the run views.
 * `activeRunId` must travel with it: without it a live run looks like a
 * zombie from a previous app session and gets marked failed.
 */
export async function loadThread(threadId: string): Promise<void> {
  const detail = await threadsGet(threadId);
  useThreadsStore.getState().upsertThread(detail.thread);
  useRunsStore
    .getState()
    .hydrateThread(threadId, detail.runs, detail.events, detail.queue, detail.activeRunId);
}
