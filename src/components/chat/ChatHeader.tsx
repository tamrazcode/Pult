import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { CheckCheck, GitBranch, Moon, Pencil, Pin, PinOff, Trash2, X } from "lucide-react";
import { runsCancel } from "../../lib/ipc";
import { activeRunForThread, useRunsStore } from "../../stores/runs";
import { useThreadsStore } from "../../stores/threads";

/**
 * Thread identity only (§6.1): title + worktree badge, plus the thread's own
 * lifecycle actions (rename, pin, snooze, settle, delete). The controls that
 * parameterize the next message — agent instance, session mode, permission —
 * live in the composer's control bar (ComposerControls).
 */
export function ChatHeader({
  title = "New thread",
  threadId,
}: {
  title?: string;
  threadId?: string;
}) {
  const router = useRouter();
  const thread = useThreadsStore((s) =>
    threadId ? s.threads.find((t) => t.id === threadId) : undefined,
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const heading = thread?.title ?? title;
  const worktreeName = thread?.worktreeName;

  const commitRename = () => {
    setEditing(false);
    if (!threadId) return;
    const next = draft.trim();
    if (!next || next === heading) {
      setDraft(heading);
      return;
    }
    void useThreadsStore
      .getState()
      .renameThread(threadId, next)
      .catch((err) => console.error("threads_rename failed", err));
  };

  const act = (fn: () => void) => {
    setMenuOpen(false);
    fn();
  };

  const removeThread = () => {
    if (!threadId) return;
    const active = activeRunForThread(useRunsStore.getState().runsByThread[threadId]);
    if (active?.status === "running") {
      void runsCancel(active.id).catch(() => undefined);
    }
    void useThreadsStore
      .getState()
      .deleteThread(threadId)
      .catch((err) => console.error("threads_delete failed", err))
      .finally(() => {
        useRunsStore.getState().dropThreadState(threadId);
        void router.navigate({ to: "/chat" });
      });
  };

  return (
    <div className="relative flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle px-4">
      {editing ? (
        <input
          autoFocus
          aria-label="Thread title"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              setDraft(heading);
              setEditing(false);
            }
          }}
          className="min-w-0 flex-1 rounded-(--radius-sm) border border-border-strong bg-surface px-2 py-0.5 text-lg text-text-primary focus:outline-none"
        />
      ) : (
        <>
          <h1 className="min-w-0 truncate text-lg font-medium text-text-primary">{heading}</h1>
          {threadId && (
            <button
              aria-label="Rename thread"
              title="Rename thread"
              onClick={() => {
                setDraft(heading);
                setEditing(true);
              }}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
            >
              <Pencil size={12} />
            </button>
          )}
        </>
      )}
      {worktreeName && (
        <span
          title={`Isolated git worktree: ${worktreeName}`}
          className="flex shrink-0 items-center gap-1 rounded-(--radius-sm) bg-active px-2 py-0.5 font-mono text-xs text-text-tertiary"
        >
          <GitBranch size={11} />
          worktree
        </span>
      )}
      {threadId && (
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            aria-label={thread?.pinned ? "Unpin thread" : "Pin thread"}
            title={thread?.pinned ? "Unpin" : "Pin"}
            onClick={() =>
              void useThreadsStore
                .getState()
                .setThreadPinned(threadId, !(thread?.pinned ?? false))
                .catch((err) => console.error("threads_set_pinned failed", err))
            }
            className="flex h-6 w-6 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
          >
            {thread?.pinned ? <PinOff size={13} /> : <Pin size={13} />}
          </button>
          <button
            aria-label="Thread actions"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((open) => !open)}
            className="flex h-6 items-center rounded-(--radius-sm) px-1.5 text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
          >
            ⋯
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-4 top-11 z-30 w-40 rounded-(--radius-md) border border-border-strong bg-surface-raised py-1 shadow-(--shadow-composer)"
            >
              <button
                role="menuitem"
                onClick={() =>
                  act(
                    () =>
                      void useThreadsStore
                        .getState()
                        .setThreadStatus(threadId, "snoozed")
                        .catch((err) => console.error("threads_set_status failed", err)),
                  )
                }
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-text-secondary transition hover:bg-hover"
              >
                <Moon size={13} /> Snooze
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  act(
                    () =>
                      void useThreadsStore
                        .getState()
                        .setThreadStatus(threadId, "settled")
                        .catch((err) => console.error("threads_set_status failed", err)),
                  )
                }
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-text-secondary transition hover:bg-hover"
              >
                <CheckCheck size={13} /> Mark settled
              </button>
              <button
                role="menuitem"
                onClick={() => act(() => setConfirmDelete(true))}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-danger transition hover:bg-hover"
              >
                <Trash2 size={13} /> Delete thread
              </button>
            </div>
          )}
        </div>
      )}
      {confirmDelete && (
        <div
          role="dialog"
          aria-label="Confirm thread deletion"
          className="absolute right-4 top-11 z-40 w-72 rounded-(--radius-md) border border-danger/40 bg-surface-raised p-3 shadow-(--shadow-composer)"
        >
          <p className="text-sm text-text-primary">Delete this thread?</p>
          <p className="mt-1 text-xs text-text-tertiary">
            {worktreeName
              ? "Its git worktree is removed; the branch and commits stay reachable."
              : "Its transcript is removed. This cannot be undone."}
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <button
              onClick={() => setConfirmDelete(false)}
              className="flex h-7 items-center rounded-(--radius-sm) border border-border-subtle px-2 text-xs text-text-secondary transition hover:bg-hover"
            >
              <X size={11} className="mr-1" /> Cancel
            </button>
            <button
              onClick={removeThread}
              className="flex h-7 items-center rounded-(--radius-sm) bg-danger px-2 text-xs font-medium text-white transition hover:brightness-110"
            >
              <Trash2 size={11} className="mr-1" /> Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
