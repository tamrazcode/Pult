import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ChatColumn } from "../components/chat/ChatColumn";
import { loadThread } from "../lib/threadLoad";
import { useGitStore } from "../stores/git";
import { useThreadsStore } from "../stores/threads";

export const Route = createFileRoute("/thread/$threadId")({ component: ThreadRoute });

function ThreadRoute() {
  const { threadId } = Route.useParams();
  const title = useThreadsStore((s) => s.threads.find((t) => t.id === threadId)?.title);

  // Load the transcript once on open; live events (run events, backend
  // runs, queue updates) fan in globally via lib/runEvents and the stores
  // keep every thread current, whichever route is mounted.
  useEffect(() => {
    let cancelled = false;
    useThreadsStore.getState().setActiveThread(threadId);
    void useGitStore.getState().refresh(threadId);
    void loadThread(threadId, () => cancelled).catch((err) =>
      console.error("threads_get failed", err),
    );
    return () => {
      cancelled = true;
      useThreadsStore.getState().setActiveThread(null);
    };
  }, [threadId]);

  return (
    <ChatColumn
      key={threadId}
      threadId={threadId}
      title={title ?? `Thread ${threadId.slice(0, 8)}`}
    />
  );
}
