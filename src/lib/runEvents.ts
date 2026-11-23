import {
  onAgentCaps,
  onElicitationRequest,
  onPtyExit,
  onPtyOutput,
  onQueueUpdate,
  onRunCancelling,
  onRunEvent,
  onRunEvents,
  onRunStarted,
  onSubagentFinished,
  onSubagentSpawned,
  onSubagentUpdated,
} from "./ipc";
import { isTauri } from "./tauri";
import { scheduleGitRefresh } from "../stores/git";
import { useRunsStore } from "../stores/runs";
import type { ElicitationSurface } from "../stores/runs";
import { useTerminalsStore } from "../stores/terminals";
import { useThreadsStore } from "../stores/threads";
import { useUiStore } from "../stores/ui";
import { useSubagentsStore } from "../stores/subagents";
import type { AppEvent } from "./types";
import { translate } from "./i18n";
import { notifyRunFinished } from "./notifications";

let unlisten: (() => void)[] | null = null;

/** Post-fold side effects, shared by single and batched event deliveries. */
function afterRunEvents(runId: string, events: AppEvent[]): void {
  let refreshGit = false;
  for (const event of events) {
    // Capability changes arrive as a targeted event; patch the cached
    // instance in memory instead of re-listing every provider.
    if (event.kind === "config_options") {
      const instanceId = instanceIdForRun(runId);
      if (instanceId) {
        useUiStore.getState().patchInstance(instanceId, {
          configOptions: event.payload.options,
        });
      }
    }
    if (event.kind === "file_changed" || event.kind === "run_finished") {
      refreshGit = true;
    }
    if (event.kind === "run_finished") {
      const threadId = useRunsStore.getState().runThreadId(runId);
      const thread = useThreadsStore.getState().threads.find((item) => item.id === threadId);
      // A child run is progress inside the parent card: no unread badge or OS
      // notification, even when its thread happens to be open.
      if (!thread?.parentThreadId) {
        if (threadId && useThreadsStore.getState().activeThreadId !== threadId) {
          useThreadsStore.getState().markUnread(threadId, true);
        }
        const title = thread?.title || translate("sidebar.untitled");
        const kind =
          event.payload.stopReason === "failed" || event.payload.error
            ? "error"
            : event.payload.stopReason === "cancelled"
              ? "cancelled"
              : "done";
        notifyRunFinished(
          kind,
          translate(`notifications.${kind}Title`),
          translate(`notifications.${kind}Body`, { title }),
        );
      }
    }
  }
  // Diff panel freshness: every write re-projects the git diff (debounced).
  if (refreshGit) {
    const threadId = useRunsStore.getState().runThreadId(runId);
    if (threadId) scheduleGitRefresh(threadId);
  }
}

function instanceIdForRun(runId: string): string | null {
  for (const runs of Object.values(useRunsStore.getState().runsByThread)) {
    const run = runs.find((candidate) => candidate.id === runId);
    if (run) return run.instanceId;
  }
  return null;
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
  const offCaps = await onAgentCaps((caps) => {
    useUiStore.getState().patchInstance(caps.instanceId, {
      promptImage: caps.promptImage,
      loadSession: caps.loadSession,
      steeringSupported: caps.steeringSupported,
      modes: caps.modes,
      configOptions: caps.configOptions,
      authMethods: caps.authMethods,
      authHint: caps.authHint,
    });
  });
  const offStarted = await onRunStarted((run) => {
    useRunsStore.getState().registerRun(run);
  });
  const offCancelling = await onRunCancelling((runId) => {
    useRunsStore.getState().markCancelling(runId);
  });
  const offQueue = await onQueueUpdate(({ threadId, items }) => {
    useRunsStore.getState().setQueue(threadId, items);
  });
  const offSubagentSpawned = await onSubagentSpawned((payload) => {
    useSubagentsStore.getState().applySpawned(payload);
    // The child thread exists only in the backend until it is opened; keep
    // the sidebar store honest without waiting for a reload.
    void useThreadsStore.getState().loadThreads();
  });
  const offSubagentFinished = await onSubagentFinished((payload) => {
    useSubagentsStore.getState().applyFinished(payload);
  });
  const offSubagentUpdated = await onSubagentUpdated((payload) => {
    useSubagentsStore.getState().applyUpdated(payload);
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
  unlisten = [
    offRun,
    offRunBatch,
    offCaps,
    offStarted,
    offCancelling,
    offQueue,
    offSubagentSpawned,
    offSubagentFinished,
    offSubagentUpdated,
    offElicitation,
    offPtyOutput,
    offPtyExit,
  ];
}
