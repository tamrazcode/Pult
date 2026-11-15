import { ChatHeader } from "./ChatHeader";
import { MessagesTimeline } from "./MessagesTimeline";
import { Composer } from "./Composer";
import { NewChatEmptyState } from "./NewChatEmptyState";
import { ProjectInfoWidget } from "../layout/ProjectInfoWidget";
import { useUiStore } from "../../stores/ui";

export function ChatColumn({ title, threadId }: { title?: string; threadId?: string }) {
  const projectWidgetOpen = useUiStore((s) => s.projectWidgetOpen);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);

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
        <MessagesTimeline threadId={threadId} />
        {projectWidgetOpen && !rightPanelOpen && <ProjectInfoWidget threadId={threadId} />}
        {/* Streaming text fades out as it slides under the composer. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-24 bg-gradient-to-t from-canvas via-canvas/80 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 z-20">
          <Composer threadId={threadId} />
        </div>
      </div>
    </div>
  );
}
