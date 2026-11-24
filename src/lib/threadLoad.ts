import { threadsGet } from "./ipc";
import { useRunsStore } from "../stores/runs";
import { useThreadsStore } from "../stores/threads";

/**
 * Loads one thread's transcript on route open and hydrates the run views.
 * `activeRunId` must travel with it: without it a live run looks like a
 * zombie from a previous app session and gets marked failed.
 */
export async function loadThread(
  threadId: string,
  isCancelled: () => boolean = () => false,
): Promise<void> {
  // Capture the live queue generation before the request: a queue:update that
  // lands while it is in flight must win over the older snapshot.
  const queueEpoch = useRunsStore.getState().queueEpochByThread[threadId] ?? 0;
  const detail = await threadsGet(threadId);
  if (isCancelled()) return;
  useThreadsStore.getState().upsertThread(detail.thread);
  useRunsStore
    .getState()
    .hydrateThread(
      threadId,
      detail.runs,
      detail.events,
      detail.queue,
      detail.activeRunId,
      detail.desiredMode,
      detail.desiredConfig,
      queueEpoch,
    );
}
