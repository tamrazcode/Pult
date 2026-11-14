import { ChatHeader } from "./ChatHeader";
import { MessagesTimeline } from "./MessagesTimeline";
import { Composer } from "./Composer";
import { NewChatEmptyState } from "./NewChatEmptyState";

export function ChatColumn({ title, threadId }: { title?: string; threadId?: string }) {
  if (!threadId) {
    return (
      <div className="flex min-w-0 flex-1 flex-col bg-canvas">
        <ChatHeader title={title} />
        <NewChatEmptyState />
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-1 flex-col bg-canvas">
      <ChatHeader title={title} threadId={threadId} />
      <MessagesTimeline threadId={threadId} />
      <Composer threadId={threadId} />
    </div>
  );
}
