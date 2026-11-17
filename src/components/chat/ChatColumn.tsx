import { ChatHeader } from "./ChatHeader";
import { MessagesTimeline } from "./MessagesTimeline";
import { Composer } from "./Composer";
import { NewChatEmptyState } from "./NewChatEmptyState";
import { ProjectInfoWidget } from "../layout/ProjectInfoWidget";
import { ElicitationModal } from "./ElicitationModal";
import { runsRespondElicitation } from "../../lib/ipc";
import { useRunsStore } from "../../stores/runs";
import { useUiStore } from "../../stores/ui";
import { useThreadsStore } from "../../stores/threads";
import { useT } from "../../lib/i18n";

export function ChatColumn({ title, threadId }: { title?: string; threadId?: string }) {
  const t = useT();
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
          <MessagesTimeline threadId={threadId} />
          {projectWidgetOpen && !rightPanelOpen && <ProjectInfoWidget threadId={threadId} />}
        </div>
        <div className="shrink-0">
          {elicitationHere && activeElicitation && (
            <ElicitationModal
              inline
              key={activeElicitation.requestId}
              request={activeElicitation}
              onSubmit={(action, content) => {
                const { runId, requestId } = activeElicitation;
                useRunsStore.getState().clearElicitation();
                runsRespondElicitation(runId, requestId, action, content).catch((err) =>
                  console.error("runs_respond_elicitation failed", err),
                );
              }}
            />
          )}
          {isSubagent ? (
            <div className="mx-auto mb-4 w-full max-w-3xl px-6">
              <p className="rounded-(--radius-md) border border-border-subtle bg-surface px-4 py-3 text-center text-xs text-text-tertiary">
                {t("subagents.readOnly")}
              </p>
            </div>
          ) : (
            <Composer threadId={threadId} />
          )}
        </div>
      </div>
    </div>
  );
}
