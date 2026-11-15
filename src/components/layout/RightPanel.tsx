import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { FileDiff, FolderTree, GitPullRequest, Plus, Terminal } from "lucide-react";
import { FilesPanel } from "../files/FilesPanel";
import { PullRequestsList } from "../git/PullRequestsList";
import { ProjectCard } from "./ProjectCard";
import { isTauri } from "../../lib/tauri";

const DiffPanel = lazy(() =>
  import("../diff/DiffPanel").then((module) => ({ default: module.DiffPanel })),
);
const TerminalPanel = lazy(() =>
  import("../terminal/TerminalPanel").then((module) => ({ default: module.TerminalPanel })),
);
import { useThreadsStore } from "../../stores/threads";
import { useUiStore } from "../../stores/ui";
import type { RightPanelTab } from "../../stores/ui";

const TABS: { id: RightPanelTab; label: string; icon: typeof FileDiff }[] = [
  { id: "diff", label: "Diff", icon: FileDiff },
  { id: "files", label: "Files", icon: FolderTree },
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "pull-requests", label: "Pull requests", icon: GitPullRequest },
];

export function RightPanel({ width }: { width: number }) {
  const tab = useUiStore((s) => s.rightPanelTab);
  const setTab = useUiStore((s) => s.setRightPanelTab);
  const activeThreadId = useThreadsStore((s) => s.activeThreadId);
  const [surfacesOpen, setSurfacesOpen] = useState(false);
  const surfacesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!surfacesOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (!surfacesRef.current?.contains(event.target as Node)) setSurfacesOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSurfacesOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [surfacesOpen]);

  return (
    <aside
      style={{ width }}
      className="glass-panel flex shrink-0 flex-col border-l border-border-subtle bg-panel"
    >
      <div
        className={`flex h-10 shrink-0 items-center gap-1 border-b border-border-subtle pl-2 ${isTauri() ? "pr-[136px]" : "pr-2"}`}
      >
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-label={label}
            title={label}
            aria-pressed={tab === id}
            onClick={() => setTab(id)}
            className={`flex h-7 w-7 items-center justify-center rounded-(--radius-sm) transition-colors duration-150 ${
              tab === id
                ? "border border-accent/40 bg-active text-text-primary"
                : "border border-transparent text-text-tertiary hover:bg-hover hover:text-text-secondary"
            }`}
          >
            <Icon size={14} />
          </button>
        ))}
        <div ref={surfacesRef} className="relative">
          <button
            type="button"
            aria-label="Open a surface"
            title="Open a surface"
            aria-haspopup="menu"
            aria-expanded={surfacesOpen}
            onClick={() => setSurfacesOpen((open) => !open)}
            className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
          >
            <Plus size={14} />
          </button>
          {surfacesOpen && (
            <div
              role="menu"
              aria-label="Open a surface"
              title="Open a surface"
              className="absolute top-full right-0 z-40 mt-1 w-44 rounded-(--radius-md) border border-border-strong bg-surface-raised py-1 shadow-(--shadow-composer)"
            >
              {TABS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setTab(id);
                    setSurfacesOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition hover:bg-hover ${
                    tab === id ? "text-text-primary" : "text-text-secondary"
                  }`}
                >
                  <Icon size={13} /> {label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <ProjectCard threadId={activeThreadId} />

      <div className="flex min-h-0 flex-1 flex-col">
        <Suspense fallback={<p className="p-3 text-xs text-text-tertiary">Loading surface…</p>}>
          {tab === "diff" ? (
            <DiffPanel key={activeThreadId ?? "none"} threadId={activeThreadId} />
          ) : tab === "terminal" ? (
            <TerminalPanel threadId={activeThreadId} />
          ) : tab === "pull-requests" ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <PullRequestsList />
            </div>
          ) : (
            <FilesPanel threadId={activeThreadId} />
          )}
        </Suspense>
      </div>
    </aside>
  );
}
