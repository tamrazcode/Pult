import {
  onElicitationRequest,
  onPtyExit,
  onPtyOutput,
  onQueueUpdate,
  onRunEvent,
  onRunEvents,
  onRunStarted,
} from "./ipc";
import { isTauri } from "./tauri";
import { scheduleGitRefresh } from "../stores/git";
import { useRunsStore } from "../stores/runs";
import type { ElicitationSurface } from "../stores/runs";
import { useTerminalsStore } from "../stores/terminals";
import { useUiStore } from "../stores/ui";
import type { AppEvent } from "./types";

let unlisten: (() => void)[] | null = null;

/** Post-fold side effects, shared by single and batched event deliveries. */
function afterRunEvents(runId: string, events: AppEvent[]): void {
  let refreshInstances = false;
  let refreshGit = false;
  for (const event of events) {
    if (event.kind === "run_finished" || event.kind === "config_options") {
      refreshInstances = true;
    }
    if (event.kind === "file_changed" || event.kind === "run_finished") {
      refreshGit = true;
    }
  }
  // The runtime caches agent capabilities during a run's handshake; refresh the
  // instance list when a run ends or its config options change so composer
  // gating and pickers stay current.
  if (refreshInstances) void useUiStore.getState().loadInstances();
  // Diff panel freshness: every write re-projects the git diff (debounced).
  if (refreshGit) {
    const threadId = useRunsStore.getState().runThreadId(runId);
    if (threadId) scheduleGitRefresh(threadId);
  }
}

/**
 * Global event fan-in (§4.2): run events, backend-created runs, and queue
 * updates feed the stores once per session, independent of which route is
 * mounted. The timeline renders whatever thread is open.
 */
export async function ensureRunEventSubscriptions(): Promise<void> {
  if (!isTauri() || unlisten) return;
  const offRun = await onRunEvent(({ runId, event }) => {
    useRunsStore.getState().receiveRunEvent(runId, event);
    afterRunEvents(runId, [event]);
  });
  const offRunBatch = await onRunEvents(({ runId, events }) => {
    useRunsStore.getState().receiveRunEventsBatch(runId, events);
    afterRunEvents(runId, events);
  });
  const offStarted = await onRunStarted((run) => {
    useRunsStore.getState().registerRun(run);
  });
  const offQueue = await onQueueUpdate(({ threadId, items }) => {
    useRunsStore.getState().setQueue(threadId, items);
  });
  const offElicitation = await onElicitationRequest(({ runId, requestId, message, detail }) => {
    const surface: ElicitationSurface = {
      runId,
      requestId,
      message,
      detail: (detail ?? {}) as Record<string, unknown>,
    };
    useRunsStore.getState().setElicitation(surface);
  });
  // PTY terminal streams (M5): decoded chunks feed the xterm panes (or the
  // store's backfill while no pane is attached).
  const offPtyOutput = await onPtyOutput((payload) => {
    useTerminalsStore.getState().pushChunk(payload);
  });
  const offPtyExit = await onPtyExit(({ terminalId, exitCode }) => {
    useTerminalsStore.getState().markExit(terminalId, exitCode);
  });
  unlisten = [offRun, offRunBatch, offStarted, offQueue, offElicitation, offPtyOutput, offPtyExit];
}
