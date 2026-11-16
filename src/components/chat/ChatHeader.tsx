import { useEffect, useState } from "react";
import { GitBranch, Pencil, Pin, PinOff } from "lucide-react";
import { isTauri } from "../../lib/tauri";
import { useProjectsStore } from "../../stores/projects";
import { useThreadsStore } from "../../stores/threads";
import { useUiStore } from "../../stores/ui";
import { PanelToggleButtons, SidebarToggleButton, WindowControls } from "../layout/WindowChrome";
import { projectInitials, projectMonogram } from "../../lib/projectColor";
import { useT } from "../../lib/i18n";

/**
 * Thread identity only (§6.1): title + worktree badge, plus pin/rename. The
 * controls that parameterize the next message live in the composer.
 */
export function ChatHeader({ title, threadId }: { title?: string; threadId?: string }) {
  const t = useT();
  const fallbackTitle = title ?? t("sidebar.newThread");
  const thread = useThreadsStore((s) =>
    threadId ? s.threads.find((t) => t.id === threadId) : undefined,
  );
  const selectedProjectId = useProjectsStore((s) => s.selectedProjectId);
  const projectId = thread?.projectId ?? (!threadId ? selectedProjectId : null);
  const project = useProjectsStore((s) =>
    projectId ? s.projects.find((candidate) => candidate.id === projectId) : undefined,
  );
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fallbackTitle);

  const heading = thread?.title ?? fallbackTitle;
  const worktreeName = thread?.worktreeName;
  const projectMonogramStyle = project ? projectMonogram(project.color) : null;

  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setDraft(heading);
      setEditing(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, heading]);

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

  return (
    <header
      data-tauri-drag-region
      className={`group/header relative flex h-10 shrink-0 select-none items-center gap-2 pl-4 ${
        isTauri() && !rightPanelOpen ? "pr-[136px]" : "pr-3"
      }`}
    >
      {!sidebarOpen && <SidebarToggleButton />}
      {editing ? (
        <input
          autoFocus
          aria-label={t("sidebar.threadTitle")}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              e.preventDefault();
              setDraft(heading);
              setEditing(false);
            }
          }}
          className="min-w-0 flex-1 rounded-(--radius-sm) border border-border-strong bg-surface px-2 py-0.5 text-sm font-medium text-text-primary focus:outline-none"
        />
      ) : (
        <>
          {project && projectMonogramStyle && (
            <span className="flex shrink-0 items-center gap-1.5">
              <span
                aria-hidden
                data-project-badge
                className="flex h-4 w-4 items-center justify-center rounded border text-[0.625rem] leading-none font-semibold tracking-tight"
                style={{
                  backgroundColor: projectMonogramStyle.background,
                  color: projectMonogramStyle.color,
                  borderColor: projectMonogramStyle.border,
                }}
              >
                {projectInitials(project.name)}
              </span>
              <span className="text-sm text-text-secondary">{project.name}</span>
              <span aria-hidden className="text-text-tertiary">
                /
              </span>
            </span>
          )}
          <h1 className="min-w-0 truncate text-sm font-medium text-text-primary">{heading}</h1>
          {threadId && (
            <button
              aria-label={t("sidebar.renameThread")}
              title={t("sidebar.renameThread")}
              onClick={() => {
                setDraft(heading);
                setEditing(true);
              }}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-(--radius-sm) text-text-tertiary opacity-0 transition hover:bg-hover hover:text-text-secondary focus-visible:opacity-100 group-hover/header:opacity-100 group-focus-within/header:opacity-100"
            >
              <Pencil size={12} />
            </button>
          )}
        </>
      )}
      {worktreeName && (
        <span
          title={t("sidebar.worktreeBadge", { name: worktreeName })}
          className="flex shrink-0 items-center gap-1 rounded-(--radius-sm) bg-active px-2 py-0.5 font-mono text-xs text-text-tertiary"
        >
          <GitBranch size={11} />
          {t("sidebar.worktree")}
        </span>
      )}
      <div data-tauri-drag-region className="min-w-2 flex-1" />
      {threadId && (
        <button
          aria-label={thread?.pinned ? t("sidebar.unpin") : t("sidebar.pin")}
          title={thread?.pinned ? t("sidebar.unpinShort") : t("sidebar.pinShort")}
          onClick={() =>
            void useThreadsStore
              .getState()
              .setThreadPinned(threadId, !(thread?.pinned ?? false))
              .catch((err) => console.error("threads_set_pinned failed", err))
          }
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
        >
          {thread?.pinned ? <PinOff size={13} /> : <Pin size={13} />}
        </button>
      )}
      <PanelToggleButtons />
      <WindowControls />
    </header>
  );
}
