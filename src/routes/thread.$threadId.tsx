import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ChatColumn } from "../components/chat/ChatColumn";
import { loadThread } from "../lib/threadLoad";
import { ipcErrorMessage } from "../lib/ipc";
import { useT } from "../lib/i18n";
import { useGitStore } from "../stores/git";
import { useThreadsStore } from "../stores/threads";

export const Route = createFileRoute("/thread/$threadId")({ component: ThreadRoute });

function ThreadRoute() {
  const t = useT();
  const { threadId } = Route.useParams();
  const title = useThreadsStore((s) => s.threads.find((t) => t.id === threadId)?.title);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Load the transcript once on open; live events (run events, backend
  // runs, queue updates) fan in globally via lib/runEvents and the stores
  // keep every thread current, whichever route is mounted. A failed load is
  // a visible state with Retry — not an empty chat.
  useEffect(() => {
    let cancelled = false;
    useThreadsStore.getState().setActiveThread(threadId);
    setLoading(true);
    setError(null);
    void useGitStore.getState().refresh(threadId);
    void loadThread(threadId, () => cancelled)
      .catch((err) => {
        if (!cancelled) setError(ipcErrorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      useThreadsStore.getState().setActiveThread(null);
    };
  }, [threadId, attempt]);

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-text-secondary">{t("chat.historyLoadFailed")}</p>
        <p className="max-w-md text-xs break-words text-text-tertiary">{error}</p>
        <button
          type="button"
          onClick={() => setAttempt((value) => value + 1)}
          className="rounded-(--radius-sm) border border-border-subtle px-3 py-1 text-xs text-text-secondary transition hover:bg-hover"
        >
          {t("common.retry")}
        </button>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-text-tertiary">
        {t("common.loading")}
      </div>
    );
  }

  return (
    <ChatColumn
      key={threadId}
      threadId={threadId}
      title={title ?? `Thread ${threadId.slice(0, 8)}`}
    />
  );
}
