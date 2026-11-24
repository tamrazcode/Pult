import { ChatHeader } from "./ChatHeader";
import { FleetStrip } from "./FleetStrip";
import { MessagesTimeline } from "./MessagesTimeline";
import { Composer } from "./Composer";
import { NewChatEmptyState } from "./NewChatEmptyState";
import { ProjectInfoWidget } from "../layout/ProjectInfoWidget";
import { ElicitationModal } from "./ElicitationModal";
import { runsRespondElicitation } from "../../lib/ipc";
import { normalizeToolKind } from "../../lib/toolDetails";
import { activeRunForThread, useRunsStore } from "../../stores/runs";
import { useUiStore } from "../../stores/ui";
import { useThreadsStore } from "../../stores/threads";

export function ChatColumn({ title, threadId }: { title?: string; threadId?: string }) {
  const projectWidgetOpen = useUiStore((s) => s.projectWidgetOpen);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const isSubagent = useThreadsStore((s) =>
    threadId ? Boolean(s.threads.find((thread) => thread.id === threadId)?.parentThreadId) : false,
  );
  const activeElicitation = useRunsStore((s) => s.activeElicitation);
  const elicitationHere = useRunsStore((s) =>
    Boolean(
      threadId &&
      s.activeElicitation &&
      s.runsByThread[threadId]?.some((run) => run.id === s.activeElicitation?.runId),
    ),
  );
  const runs = useRunsStore((s) => (threadId ? s.runsByThread[threadId] : undefined));
  const activeRun = activeRunForThread(runs);
  const activeView = useRunsStore((s) => (activeRun ? s.viewsByRun[activeRun.id] : undefined));
  const parentWorking = activeRun?.status === "running";
  let ambientKind = "idle";
  if (parentWorking && activeView) {
    const current = [...activeView.items]
      .reverse()
      .find(
        (item) =>
          (item.type === "tool" && (item.status === "pending" || item.status === "in_progress")) ||
          (item.type === "thought" && item.streaming),
      );
    if (current?.type === "tool") ambientKind = normalizeToolKind(current);
    else if (current?.type === "thought") ambientKind = "thought";
  }

  if (!threadId) {
    return (
      <div className="flex min-h-0 min-w-[400px] flex-1 flex-col bg-canvas">
        <ChatHeader title={title} />
        <NewChatEmptyState />
      </div>
    );
  }
  return (
    <div className="relative flex min-h-0 min-w-[400px] flex-1 flex-col bg-canvas">
      <ChatHeader title={title} threadId={threadId} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="relative flex min-h-0 flex-1 flex-col">
          <FleetStrip threadId={threadId} />
          <MessagesTimeline threadId={threadId} />
          {projectWidgetOpen && !rightPanelOpen && <ProjectInfoWidget threadId={threadId} />}
        </div>
        {/* Ambient glow: dim at rest, alive while the parent run works.
            data-ambient-kind follows the current smart-row action. */}
        {!isSubagent && (
          <div
            aria-hidden
            data-composer-ambient
            data-ambient-state={parentWorking ? "working" : "idle"}
            data-ambient-kind={ambientKind}
            className="composer-ambient pointer-events-none absolute inset-x-0 bottom-0 h-48"
          />
        )}
        <div className="shrink-0">
          {elicitationHere && activeElicitation && (
            <ElicitationModal
              inline
              key={activeElicitation.requestId}
              request={activeElicitation}
              onSubmit={(action, content) => {
                const { runId, requestId } = activeElicitation;
                // Keep the form and its values until the answer is accepted;
                // a failed send must not throw the user's input away.
                void runsRespondElicitation(runId, requestId, action, content)
                  .then(() => useRunsStore.getState().clearElicitation())
                  .catch((err) => {
                    console.error("runs_respond_elicitation failed", err);
                    useUiStore.getState().setGlobalError({
                      kind: "protocol",
                      message: err instanceof Error ? err.message : String(err),
                    });
                  });
              }}
            />
          )}
          {!isSubagent && <Composer threadId={threadId} />}
        </div>
      </div>
    </div>
  );
}
