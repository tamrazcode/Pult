import { useEffect, useState } from "react";
import { FolderOpen, GitPullRequest, Plus, Search } from "lucide-react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { isTauri } from "../../lib/tauri";
import { useUiStore } from "../../stores/ui";
import { threadsInShelf, useThreadsStore } from "../../stores/threads";
import type { ShelfName, Thread } from "../../stores/threads";

const SHELVES: ShelfName[] = ["drafts", "working", "snoozed", "settled", "pinned"];

const SHELF_HINTS: Record<ShelfName, string> = {
  drafts: "New threads start here.",
  working: "An agent is working in these threads.",
  snoozed: "Threads you paused for later.",
  settled: "Threads whose PR has merged.",
  pinned: "Threads you pinned for quick access.",
};

/** Dragging onto a shelf moves the thread there (persisted status/pinned).
 * `working` is earned by a live run, never chosen by a drag. */
const SHELF_TARGET: Record<ShelfName, { status?: Thread["status"]; pinned?: boolean }> = {
  drafts: { status: "draft", pinned: false },
  working: { status: "waiting" },
  snoozed: { status: "snoozed", pinned: false },
  settled: { status: "settled", pinned: false },
  pinned: { pinned: true },
};

/** The persisted patch for a shelf drop, or null when the shelf is derived. */
export function shelfDropTarget(
  shelf: ShelfName,
): { status?: Thread["status"]; pinned?: boolean } | null {
  return shelf === "working" ? null : SHELF_TARGET[shelf];
}

const STATUS_DOT_CLASSES: Partial<Record<Thread["status"], string>> = {
  working: "bg-accent",
  waiting: "bg-warning",
};

function ThreadRow({
  thread,
  active,
  onNavigate,
}: {
  thread: Thread;
  active: boolean;
  onNavigate: () => void;
}) {
  const dot = STATUS_DOT_CLASSES[thread.status];
  return (
    <a
      href={`/thread/${thread.id}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/pult-thread", thread.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={(e) => {
        e.preventDefault();
        onNavigate();
      }}
      className={`flex items-center gap-2 rounded-(--radius-sm) px-2 py-1.5 text-sm transition ${
        active ? "bg-active text-text-primary" : "text-text-secondary hover:bg-hover"
      }`}
    >
      {dot && <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />}
      <span className="truncate">{thread.title || "Untitled"}</span>
    </a>
  );
}

export function Sidebar({ width }: { width: number }) {
  const threads = useThreadsStore((s) => s.threads);
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Which shelf is the current drop target (drives the highlight ring).
  const [dropShelf, setDropShelf] = useState<ShelfName | null>(null);

  useEffect(() => {
    if (isTauri()) void useThreadsStore.getState().loadThreads();
  }, []);

  const handleDrop = (shelf: ShelfName, e: React.DragEvent) => {
    e.preventDefault();
    setDropShelf(null);
    const threadId = e.dataTransfer.getData("text/pult-thread");
    if (!threadId) return;
    const thread = threads.find((t) => t.id === threadId);
    if (!thread) return;
    const target = shelfDropTarget(shelf);
    if (!target) return;
    if (target.pinned) {
      void useThreadsStore.getState().setThreadPinned(threadId, true);
      return;
    }
    const nextStatus = target.status ?? thread.status;
    if (thread.status !== nextStatus) {
      void useThreadsStore.getState().setThreadStatus(threadId, nextStatus);
    }
    if (target.pinned === false && thread.pinned) {
      void useThreadsStore.getState().setThreadPinned(threadId, false);
    }
  };

  return (
    <aside
      style={{ width }}
      className="flex shrink-0 flex-col border-r border-border-subtle bg-canvas"
    >
      <div className="flex items-center gap-2 px-3 pt-3">
        <button
          onClick={() => void router.navigate({ to: "/chat" })}
          className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-(--radius-md) bg-accent text-sm font-medium text-accent-fg transition hover:brightness-110"
        >
          <Plus size={14} /> New thread
        </button>
        <button
          title="Search (⌘K)"
          aria-label="Search"
          onClick={() => useUiStore.getState().setPaletteOpen(true)}
          className="flex h-8 w-8 items-center justify-center rounded-(--radius-md) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
        >
          <Search size={15} />
        </button>
      </div>

      <nav className="mt-4 flex-1 space-y-4 overflow-y-auto px-2 pb-4">
        {SHELVES.map((shelf) => {
          const items = threadsInShelf(threads, shelf);
          const isTarget = dropShelf === shelf;
          return (
            <section
              key={shelf}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes("text/pult-thread")) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                setDropShelf(shelf);
              }}
              onDragLeave={() => setDropShelf((s) => (s === shelf ? null : s))}
              onDrop={(e) => handleDrop(shelf, e)}
              className={`rounded-(--radius-md) transition ${
                isTarget ? "ring-1 ring-accent bg-hover/60" : ""
              }`}
            >
              <header className="flex items-center justify-between px-2 pb-1">
                <span className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">
                  {shelf}
                </span>
                <span className="tnum text-xs text-text-tertiary">{items.length}</span>
              </header>
              {items.length === 0 && (
                <p className="px-2 pb-1 text-xs text-text-tertiary">{SHELF_HINTS[shelf]}</p>
              )}
              {items.map((thread) => (
                <ThreadRow
                  key={thread.id}
                  thread={thread}
                  active={pathname === `/thread/${thread.id}`}
                  onNavigate={() =>
                    void router.navigate({
                      to: "/thread/$threadId",
                      params: { threadId: thread.id },
                    })
                  }
                />
              ))}
            </section>
          );
        })}
      </nav>

      <footer className="border-t border-border-subtle p-3">
        <button
          onClick={() => void router.navigate({ to: "/pull-requests" })}
          className="mb-1 flex w-full items-center gap-2 rounded-(--radius-md) px-2 py-1.5 text-sm text-text-secondary transition hover:bg-hover"
        >
          <GitPullRequest size={15} className="text-text-tertiary" />
          <span>Pull requests</span>
        </button>
        <button
          onClick={() => void router.navigate({ to: "/chat" })}
          title="Start a thread with a workspace folder"
          className="flex w-full items-center gap-2 rounded-(--radius-md) px-2 py-1.5 text-sm text-text-secondary transition hover:bg-hover"
        >
          <FolderOpen size={15} className="text-text-tertiary" />
          <span>New thread with workspace…</span>
        </button>
      </footer>
    </aside>
  );
}
