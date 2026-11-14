import { useEffect, useMemo, useRef, useState } from "react";
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
import { runsCancel } from "../../lib/ipc";
import { useUiStore } from "../../stores/ui";
import { buildSidebarGroups, useThreadsStore, type SidebarFilter } from "../../stores/threads";
import { useProjectsStore } from "../../stores/projects";
import { activeRunForThread, useRunsStore } from "../../stores/runs";
import type { Project, Thread } from "../../lib/types";
import { PultLogo } from "../ui/PultLogo";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import { CreateProjectDialog } from "../projects/CreateProjectDialog";
import { ProjectSettingsDialog } from "../projects/ProjectSettingsDialog";

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
  renaming,
  onRename,
  onContextMenu,
}: {
  thread: Thread;
  active: boolean;
  unread: boolean;
  onNavigate: () => void;
  onStar: () => void;
  renaming: boolean;
  onRename: (title: string | null) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const working = thread.status === "working" || thread.status === "waiting";
  return (
    <div
      onContextMenu={onContextMenu}
      className={`group flex items-center rounded-(--radius-sm) transition ${
        active ? "bg-active text-text-primary" : "text-text-secondary hover:bg-hover"
      }`}
    >
      {renaming ? (
        <input
          autoFocus
          defaultValue={thread.title}
          aria-label="Thread title"
          onKeyDown={(event) => {
            if (event.key === "Enter") onRename(event.currentTarget.value.trim());
            if (event.key === "Escape") onRename(null);
          }}
          onBlur={(event) => onRename(event.currentTarget.value.trim())}
          className="mx-1 my-0.5 h-6 min-w-0 flex-1 rounded-(--radius-sm) border border-border-strong bg-(--input) px-2 text-sm text-text-primary focus:outline-none"
        />
      ) : (
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
      )}
      <button
        type="button"
        aria-label={thread.pinned ? "Unstar thread" : "Star thread"}
        onClick={onStar}
        className={`mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-(--radius-sm) transition hover:bg-hover focus-visible:opacity-100 ${
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
  onContextMenu,
}: {
  project: Project;
  collapsed: boolean;
  onToggle: () => void;
  onNewThread: () => void;
  onStar: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const initials = project.name.slice(0, 2).toUpperCase();
  return (
    <div
      data-project-row
      onContextMenu={onContextMenu}
      className="group flex items-center gap-1 px-1 py-1"
    >
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
        aria-label={project.pinned ? "Unstar project" : "Star project"}
        onClick={onStar}
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-(--radius-sm) transition hover:bg-hover focus-visible:opacity-100 ${
          project.pinned ? "text-warning" : "text-text-tertiary opacity-0 group-hover:opacity-100"
        }`}
      >
        <Star size={10} fill={project.pinned ? "currentColor" : "none"} />
      </button>
      <button
        type="button"
        aria-label="New thread in project"
        onClick={onNewThread}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-(--radius-sm) text-text-tertiary opacity-0 transition hover:bg-hover hover:text-text-secondary focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Plus size={12} />
      </button>
    </div>
  );
}

export function Sidebar({ width }: { width: number }) {
  const projects = useProjectsStore((s) => s.projects);
  const selectedProjectId = useProjectsStore((s) => s.selectedProjectId);
  const threads = useThreadsStore((s) => s.threads);
  const unreadIds = useThreadsStore((s) => s.unreadIds);
  const collapsedProjects = useUiStore((s) => s.collapsedProjects);
  const activeThreadId = useThreadsStore((s) => s.activeThreadId);
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SidebarFilter>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsProjectId, setSettingsProjectId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    project?: Project;
    thread?: Thread;
  } | null>(null);
  const filterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isTauri()) return;
    void useProjectsStore.getState().loadProjects();
    void useThreadsStore.getState().loadThreads();
  }, []);

  useEffect(() => {
    if (!filterOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (!filterRef.current?.contains(event.target as Node)) setFilterOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFilterOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [filterOpen]);

  const unreadSet = useMemo(() => new Set(unreadIds), [unreadIds]);
  const groups = useMemo(
    () => buildSidebarGroups(projects, threads, { query, filter, unreadIds: unreadSet }),
    [projects, threads, query, filter, unreadSet],
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

  const projectMenuItems = (project: Project): Array<ContextMenuItem | "separator"> => [
    {
      id: "new-thread",
      label: "New thread",
      icon: <SquarePen size={12} />,
      onSelect: () => newThread(project),
    },
    {
      id: "copy-path",
      label: "Copy path",
      onSelect: () => void navigator.clipboard.writeText(project.rootPath),
    },
    {
      id: "pin",
      label: project.pinned ? "Unpin" : "Pin",
      onSelect: () => void useProjectsStore.getState().togglePin(project.id),
    },
    {
      id: "settings",
      label: "Project settings",
      onSelect: () => setSettingsProjectId(project.id),
    },
    "separator",
    {
      id: "delete",
      label: "Delete",
      danger: true,
      confirmLabel: "Confirm delete",
      onSelect: () => void useProjectsStore.getState().deleteProject(project.id),
    },
  ];

  const threadMenuItems = (thread: Thread): Array<ContextMenuItem | "separator"> => {
    const project = projects.find((candidate) => candidate.id === thread.projectId);
    const unread = unreadSet.has(thread.id);
    return [
      {
        id: "pin",
        label: thread.pinned ? "Unpin" : "Pin",
        onSelect: () => void useThreadsStore.getState().setThreadPinned(thread.id, !thread.pinned),
      },
      {
        id: "settle",
        label: "Settle",
        onSelect: () => void useThreadsStore.getState().setThreadStatus(thread.id, "settled"),
      },
      {
        id: "snooze",
        label: "Snooze",
        onSelect: () => void useThreadsStore.getState().setThreadStatus(thread.id, "snoozed"),
      },
      { id: "rename", label: "Rename", onSelect: () => setRenamingId(thread.id) },
      {
        id: "unread",
        label: unread ? "Mark read" : "Mark unread",
        onSelect: () => useThreadsStore.getState().markUnread(thread.id, !unread),
      },
      {
        id: "copy-path",
        label: "Copy path",
        onSelect: () =>
          void navigator.clipboard.writeText(thread.workspace ?? project?.rootPath ?? ""),
      },
      {
        id: "settings",
        label: "Project settings",
        disabled: thread.projectId === null,
        onSelect: () => setSettingsProjectId(thread.projectId),
      },
      {
        id: "archive",
        label: "Archive",
        onSelect: () => void useThreadsStore.getState().setThreadStatus(thread.id, "archived"),
      },
      "separator",
      {
        id: "delete",
        label: "Delete",
        danger: true,
        confirmLabel: "Confirm delete",
        onSelect: () => {
          const active = activeRunForThread(useRunsStore.getState().runsByThread[thread.id]);
          void (async () => {
            if (active && (active.status === "running" || active.status === "queued")) {
              await runsCancel(active.id).catch(() => {});
            }
            await useThreadsStore.getState().deleteThread(thread.id);
          })();
        },
      },
    ];
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
        <div ref={filterRef} className="relative">
          <button
            type="button"
            aria-label="Filter threads"
            aria-haspopup="menu"
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
                  type="button"
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
          onClick={() =>
            newThread(projects.find((project) => project.id === selectedProjectId) ?? null)
          }
          className="flex h-8 w-8 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
        >
          <SquarePen size={15} />
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-1 pb-4" aria-label="Threads">
        {groups.map((group) => {
          const key = group.project?.id ?? "__none__";
          const isCollapsed = group.project ? collapsedProjects.includes(group.project.id) : false;
          return (
            <section key={key} className="mb-2">
              {group.project ? (
                <ProjectRow
                  project={group.project}
                  collapsed={isCollapsed}
                  onToggle={() => useUiStore.getState().toggleProjectCollapsed(group.project!.id)}
                  onNewThread={() => newThread(group.project)}
                  onStar={() => void useProjectsStore.getState().togglePin(group.project!.id)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ x: event.clientX, y: event.clientY, project: group.project! });
                  }}
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
                      unread={unreadSet.has(thread.id)}
                      onNavigate={() => openThread(thread)}
                      onStar={() =>
                        void useThreadsStore.getState().setThreadPinned(thread.id, !thread.pinned)
                      }
                      renaming={renamingId === thread.id}
                      onRename={(title) => {
                        setRenamingId(null);
                        if (title) void useThreadsStore.getState().renameThread(thread.id, title);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setMenu({ x: event.clientX, y: event.clientY, thread });
                      }}
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
      <ProjectSettingsDialog
        open={settingsProjectId !== null}
        projectId={settingsProjectId ?? ""}
        onClose={() => setSettingsProjectId(null)}
      />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.project ? projectMenuItems(menu.project) : threadMenuItems(menu.thread!)}
          onClose={() => setMenu(null)}
        />
      )}
    </aside>
  );
}
