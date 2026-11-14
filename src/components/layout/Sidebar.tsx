import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  GitPullRequest,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  SquarePen,
  Star,
} from "lucide-react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { isTauri } from "../../lib/tauri";
import { useUiStore } from "../../stores/ui";
import { buildSidebarGroups, useThreadsStore, type SidebarFilter } from "../../stores/threads";
import { useProjectsStore } from "../../stores/projects";
import type { Project, Thread } from "../../lib/types";
import { PultLogo } from "../ui/PultLogo";
import { CreateProjectDialog } from "../projects/CreateProjectDialog";

const FILTERS: Array<{ id: SidebarFilter; label: string }> = [
  { id: "all", label: "All threads" },
  { id: "unread", label: "Unread" },
  { id: "pinned", label: "Pinned" },
  { id: "working", label: "Working" },
  { id: "archived", label: "Archived" },
];

function relativeTime(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function ThreadRow({
  thread,
  active,
  unread,
  onNavigate,
  onStar,
}: {
  thread: Thread;
  active: boolean;
  unread: boolean;
  onNavigate: () => void;
  onStar: () => void;
}) {
  const working = thread.status === "working" || thread.status === "waiting";
  return (
    <div
      className={`group flex items-center rounded-(--radius-sm) transition ${
        active ? "bg-active text-text-primary" : "text-text-secondary hover:bg-hover"
      }`}
    >
      <a
        href={`/thread/${thread.id}`}
        onClick={(e) => {
          e.preventDefault();
          onNavigate();
        }}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-sm"
      >
        {unread ? (
          <span
            data-unread="true"
            aria-label="Unread"
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
          />
        ) : working ? (
          <span
            aria-label={thread.status}
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
              thread.status === "working" ? "bg-accent" : "bg-warning"
            }`}
          />
        ) : null}
        <span className="truncate">{thread.title || "Untitled"}</span>
        <span className="tnum ml-auto shrink-0 text-[10px] text-text-tertiary">
          {relativeTime(thread.updatedAt)}
        </span>
      </a>
      <button
        type="button"
        aria-label={thread.pinned ? "Unstar thread" : "Star thread"}
        onClick={onStar}
        className={`mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-(--radius-sm) transition hover:bg-hover ${
          thread.pinned ? "text-warning" : "text-text-tertiary opacity-0 group-hover:opacity-100"
        }`}
      >
        <Star size={11} fill={thread.pinned ? "currentColor" : "none"} />
      </button>
    </div>
  );
}

function ProjectRow({
  project,
  collapsed,
  onToggle,
  onNewThread,
  onStar,
}: {
  project: Project;
  collapsed: boolean;
  onToggle: () => void;
  onNewThread: () => void;
  onStar: () => void;
}) {
  const initials = project.name.slice(0, 2).toUpperCase();
  return (
    <div data-project-row className="group flex items-center gap-1 px-1 py-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-(--radius-sm) px-1 py-1 text-left transition hover:bg-hover"
      >
        {collapsed ? (
          <ChevronRight size={12} className="shrink-0 text-text-tertiary" />
        ) : (
          <ChevronDown size={12} className="shrink-0 text-text-tertiary" />
        )}
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-(--radius-sm) text-[10px] font-semibold text-white"
          style={{ backgroundColor: project.color ?? "#346bf1" }}
        >
          {initials}
        </span>
        <span className="truncate text-sm font-medium text-text-primary">{project.name}</span>
        {project.pinned && <Star size={10} className="shrink-0 text-warning" fill="currentColor" />}
      </button>
      <button
        type="button"
        aria-label="Star project"
        onClick={onStar}
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-(--radius-sm) transition hover:bg-hover ${
          project.pinned ? "text-warning" : "text-text-tertiary opacity-0 group-hover:opacity-100"
        }`}
      >
        <Star size={10} fill={project.pinned ? "currentColor" : "none"} />
      </button>
      <button
        type="button"
        aria-label="New thread in project"
        onClick={onNewThread}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-(--radius-sm) text-text-tertiary opacity-0 transition hover:bg-hover hover:text-text-secondary group-hover:opacity-100"
      >
        <Plus size={12} />
      </button>
    </div>
  );
}

export function Sidebar({ width }: { width: number }) {
  const projects = useProjectsStore((s) => s.projects);
  const threads = useThreadsStore((s) => s.threads);
  const unreadIds = useThreadsStore((s) => s.unreadIds);
  const activeThreadId = useThreadsStore((s) => s.activeThreadId);
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SidebarFilter>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    void useProjectsStore.getState().loadProjects();
    void useThreadsStore.getState().loadThreads();
  }, []);

  const groups = useMemo(
    () =>
      buildSidebarGroups(projects, threads, {
        query,
        filter,
        unreadIds: new Set(unreadIds),
      }),
    [projects, threads, query, filter, unreadIds],
  );

  const openThread = (thread: Thread) => {
    useThreadsStore.getState().setActiveThread(thread.id);
    if (thread.projectId) useProjectsStore.getState().selectProject(thread.projectId);
    void router.navigate({ to: "/thread/$threadId", params: { threadId: thread.id } });
  };

  const newThread = (project: Project | null) => {
    useProjectsStore.getState().selectProject(project?.id ?? null);
    void router.navigate({ to: "/chat" });
  };

  const refresh = () => {
    void useProjectsStore.getState().loadProjects();
    void useThreadsStore.getState().loadThreads();
    void useUiStore.getState().loadInstances();
  };

  return (
    <aside
      style={{ width }}
      className="flex shrink-0 flex-col border-r border-border-subtle bg-chrome"
    >
      <div className="flex items-center gap-2 px-3 pt-3 pb-2">
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <PultLogo className="h-5 w-5 shrink-0 text-text-primary" />
          <span className="truncate text-sm font-semibold tracking-tight text-text-primary">
            pult
          </span>
        </span>
        <button
          type="button"
          aria-label="Back"
          onClick={() => router.history.back()}
          className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          aria-label="Forward"
          onClick={() => router.history.forward()}
          className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
        >
          <ArrowRight size={14} />
        </button>
      </div>

      <div className="flex items-center gap-1 px-2 pb-2">
        <div className="relative min-w-0 flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-text-tertiary"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search threads"
            aria-label="Search threads"
            type="search"
            className="h-8 w-full rounded-(--radius-sm) border border-border-subtle bg-surface pr-2 pl-7 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-strong focus:outline-none"
          />
        </div>
        <div className="relative">
          <button
            type="button"
            aria-label="Filter threads"
            aria-expanded={filterOpen}
            onClick={() => setFilterOpen((open) => !open)}
            className={`flex h-8 w-8 items-center justify-center rounded-(--radius-sm) transition hover:bg-hover hover:text-text-secondary ${
              filter === "all" ? "text-text-tertiary" : "bg-active text-text-primary"
            }`}
          >
            <SlidersHorizontal size={14} />
          </button>
          {filterOpen && (
            <div
              role="menu"
              aria-label="Filters"
              className="absolute top-full right-0 z-30 mt-1 w-40 rounded-(--radius-md) border border-border-strong bg-surface-raised py-1 shadow-xl"
            >
              {FILTERS.map((option) => (
                <button
                  key={option.id}
                  role="menuitemradio"
                  aria-checked={filter === option.id}
                  onClick={() => {
                    setFilter(option.id);
                    setFilterOpen(false);
                  }}
                  className={`flex w-full items-center px-3 py-1.5 text-left text-xs ${
                    filter === option.id
                      ? "bg-active text-text-primary"
                      : "text-text-secondary hover:bg-hover"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          aria-label="New project"
          onClick={() => setCreateOpen(true)}
          className="flex h-8 w-8 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
        >
          <FolderPlus size={15} />
        </button>
        <button
          type="button"
          aria-label="New thread"
          onClick={() => newThread(null)}
          className="flex h-8 w-8 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
        >
          <SquarePen size={15} />
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-1 pb-4" aria-label="Threads">
        {groups.map((group) => {
          const key = group.project?.id ?? "__none__";
          const isCollapsed = group.project ? collapsed.has(group.project.id) : false;
          return (
            <section key={key} className="mb-2">
              {group.project ? (
                <ProjectRow
                  project={group.project}
                  collapsed={isCollapsed}
                  onToggle={() =>
                    setCollapsed((current) => {
                      const next = new Set(current);
                      if (next.has(group.project!.id)) next.delete(group.project!.id);
                      else next.add(group.project!.id);
                      return next;
                    })
                  }
                  onNewThread={() => newThread(group.project)}
                  onStar={() => void useProjectsStore.getState().togglePin(group.project!.id)}
                />
              ) : (
                <div className="px-3 pb-1 pt-2 text-[10px] font-semibold tracking-wider text-text-tertiary uppercase">
                  No project
                </div>
              )}
              {!isCollapsed && (
                <div className="space-y-0.5 pl-3">
                  {group.threads.map((thread) => (
                    <ThreadRow
                      key={thread.id}
                      thread={thread}
                      active={pathname === `/thread/${thread.id}` || activeThreadId === thread.id}
                      unread={unreadIds.includes(thread.id)}
                      onNavigate={() => openThread(thread)}
                      onStar={() =>
                        void useThreadsStore.getState().setThreadPinned(thread.id, !thread.pinned)
                      }
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </nav>

      <footer className="border-t border-border-subtle p-2">
        <button
          type="button"
          aria-label="Settings"
          onClick={() => void router.navigate({ to: "/settings/appearance" })}
          className="flex w-full items-center gap-2 rounded-(--radius-sm) px-2 py-1.5 text-sm text-text-secondary transition hover:bg-hover"
        >
          <Settings size={15} className="text-text-tertiary" />
          <span>Settings</span>
        </button>
        <button
          type="button"
          aria-label="Pull requests"
          onClick={() => void router.navigate({ to: "/pull-requests" })}
          className="flex w-full items-center gap-2 rounded-(--radius-sm) px-2 py-1.5 text-sm text-text-secondary transition hover:bg-hover"
        >
          <GitPullRequest size={15} className="text-text-tertiary" />
          <span>Pull requests</span>
        </button>
        <button
          type="button"
          aria-label="Usage"
          onClick={() => void router.navigate({ to: "/usage" })}
          className="flex w-full items-center gap-2 rounded-(--radius-sm) px-2 py-1.5 text-sm text-text-secondary transition hover:bg-hover"
        >
          <BarChart3 size={15} className="text-text-tertiary" />
          <span>Usage</span>
        </button>
        <button
          type="button"
          aria-label="Refresh"
          onClick={refresh}
          className="flex w-full items-center gap-2 rounded-(--radius-sm) px-2 py-1.5 text-sm text-text-secondary transition hover:bg-hover"
        >
          <RefreshCw size={15} className="text-text-tertiary" />
          <span>Refresh</span>
        </button>
      </footer>

      <CreateProjectDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </aside>
  );
}
