import { useState } from "react";
import { ChevronRight, FileDiff, FolderTree, Terminal } from "lucide-react";
import { DiffPanel } from "../diff/DiffPanel";
import { TerminalPanel } from "../terminal/TerminalPanel";
import { useRunsStore } from "../../stores/runs";
import { useThreadsStore } from "../../stores/threads";
import { useUiStore } from "../../stores/ui";
import type { RightPanelTab } from "../../stores/ui";

const TABS: { id: RightPanelTab; label: string; icon: typeof FileDiff }[] = [
  { id: "diff", label: "Diff", icon: FileDiff },
  { id: "files", label: "Files", icon: FolderTree },
  { id: "terminal", label: "Terminal", icon: Terminal },
];

const EMPTY_COPY: Record<RightPanelTab, { title: string; hint: string }> = {
  diff: {
    title: "No diff yet",
    hint: "Changes an agent makes to your files will appear here.",
  },
  files: {
    title: "No files",
    hint: "Files changed in this thread will appear here.",
  },
  terminal: {
    title: "Terminal not started",
    hint: "Shells that agents open will appear here.",
  },
};

/** One changed file: diffstat line, click expands the unified diff. */
function FileRow({
  path,
  diff,
  added,
  removed,
}: {
  path: string;
  diff: string;
  added: number;
  removed: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-(--radius-md) border border-border-subtle bg-surface">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <ChevronRight
          size={12}
          className={`shrink-0 text-text-tertiary transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary">
          {path}
        </span>
        <span className="tnum shrink-0 text-xs text-success">+{added}</span>
        <span className="tnum shrink-0 text-xs text-danger">-{removed}</span>
      </button>
      {open && (
        <pre className="overflow-x-auto border-t border-border-subtle px-2.5 py-2 font-mono text-xs whitespace-pre text-text-tertiary">
          {diff}
        </pre>
      )}
    </div>
  );
}

export function RightPanel({ width }: { width: number }) {
  const tab = useUiStore((s) => s.rightPanelTab);
  const setTab = useUiStore((s) => s.setRightPanelTab);
  const activeThreadId = useThreadsStore((s) => s.activeThreadId);
  const files = useRunsStore((s) => (activeThreadId ? s.filesByThread[activeThreadId] : undefined));

  return (
    <aside
      style={{ width }}
      className="flex shrink-0 flex-col border-l border-border-subtle bg-chrome"
    >
      <div className="flex items-center gap-1 border-b border-border-subtle px-2 py-1.5">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex h-7 items-center gap-1.5 rounded-(--radius-sm) px-2.5 text-sm transition-colors duration-150 ${
              tab === id
                ? "bg-active text-text-primary"
                : "text-text-tertiary hover:bg-hover hover:text-text-secondary"
            }`}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {tab === "diff" ? (
        <DiffPanel threadId={activeThreadId} />
      ) : tab === "terminal" ? (
        <TerminalPanel threadId={activeThreadId} />
      ) : tab === "files" && files && files.length > 0 ? (
        <div className="flex-1 space-y-1.5 overflow-y-auto p-2">
          {files.map((file) => (
            <FileRow
              key={file.path}
              path={file.path}
              diff={file.diff}
              added={file.added}
              removed={file.removed}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 text-center">
          <p className="text-sm text-text-secondary">{EMPTY_COPY[tab].title}</p>
          <p className="text-xs text-text-tertiary">{EMPTY_COPY[tab].hint}</p>
        </div>
      )}
    </aside>
  );
}
