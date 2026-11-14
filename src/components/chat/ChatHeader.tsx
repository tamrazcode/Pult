import { GitBranch } from "lucide-react";
import { useThreadsStore } from "../../stores/threads";

/**
 * Thread identity only (§6.1): title + worktree badge. The controls that
 * parameterize the next message — agent instance, session mode, permission —
 * live in the composer's control bar (ComposerControls), where the decision
 * happens.
 */
export function ChatHeader({
  title = "New thread",
  threadId,
}: {
  title?: string;
  threadId?: string;
}) {
  const worktreeName = useThreadsStore((s) =>
    threadId ? s.threads.find((t) => t.id === threadId)?.worktreeName : undefined,
  );
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle px-4">
      <h1 className="min-w-0 truncate text-lg font-medium text-text-primary">{title}</h1>
      {worktreeName && (
        <span
          title={`Isolated git worktree: ${worktreeName}`}
          className="flex shrink-0 items-center gap-1 rounded-(--radius-sm) bg-active px-2 py-0.5 font-mono text-xs text-text-tertiary"
        >
          <GitBranch size={11} />
          worktree
        </span>
      )}
    </div>
  );
}
