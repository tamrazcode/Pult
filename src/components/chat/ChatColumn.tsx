import { ChatHeader } from "./ChatHeader";
import { MessagesTimeline } from "./MessagesTimeline";
import { Composer } from "./Composer";
import { NewChatEmptyState } from "./NewChatEmptyState";

export function ChatColumn({ title, threadId }: { title?: string; threadId?: string }) {
  if (!threadId) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
        <ChatHeader title={title} />
        <NewChatEmptyState />
      </div>
    );
  }
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-canvas">
      <ChatHeader title={title} threadId={threadId} />
      <div className="relative flex min-h-0 flex-1 flex-col">
        <MessagesTimeline threadId={threadId} />
        {/* Streaming text fades out as it slides under the composer. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-24 bg-gradient-to-t from-canvas via-canvas/80 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 z-20">
          <Composer threadId={threadId} />
        </div>
      </div>
    </div>
  );
}
