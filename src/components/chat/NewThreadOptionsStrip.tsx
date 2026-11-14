import { FolderTree } from "lucide-react";
import { useUiStore } from "../../stores/ui";

/** Options strip for threads created from the empty /chat route (M4). */
export function NewThreadOptionsStrip() {
  const workspace = useUiStore((s) => s.newThreadOptions.workspace);
  const worktree = useUiStore((s) => s.newThreadOptions.worktree);
  const setNewThreadOptions = useUiStore((s) => s.setNewThreadOptions);
  return (
    <div className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-2 rounded-(--radius-md) border border-border-subtle bg-surface px-3 py-2">
      <FolderTree size={14} className="shrink-0 text-text-tertiary" />
      <input
        value={workspace}
        onChange={(e) => setNewThreadOptions({ workspace: e.target.value })}
        placeholder="Workspace folder (optional — defaults to the pult root)"
        aria-label="Workspace folder for new threads"
        className="h-7 min-w-0 flex-1 rounded-(--radius-sm) border border-border-subtle bg-(--input) px-2 font-mono text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-strong focus:outline-none"
      />
      <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-text-secondary">
        <input
          type="checkbox"
          checked={worktree}
          onChange={(e) => setNewThreadOptions({ worktree: e.target.checked })}
          className="h-3.5 w-3.5 accent-(--accent)"
        />
        Isolated worktree
      </label>
    </div>
  );
}
