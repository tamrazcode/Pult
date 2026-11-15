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
import { Tooltip } from "../ui/Tooltip";
import { projectInitials, projectMonogram } from "../../lib/projectColor";
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
  const renameDone = useRef(false);
  useEffect(() => {
    if (renaming) renameDone.current = false;
  }, [renaming]);
  const finishRename = (title: string | null) => {
    if (renameDone.current) return;
    renameDone.current = true;
    onRename(title);
  };
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
          data-escape-layer
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              finishRename(event.currentTarget.value.trim() || null);
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              finishRename(null);
            }
          }}
          onBlur={(event) => finishRename(event.currentTarget.value.trim() || null)}
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
          <span className="tnum ml-auto shrink-0 text-xs text-text-tertiary">
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
  const initials = projectInitials(project.name);
  const monogram = projectMonogram(project.color);
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
        data-project-chevron="right"
        className="flex min-w-0 flex-1 items-center gap-2 rounded-(--radius-sm) px-1 py-1 text-left transition hover:bg-hover"
      >
        <span
          data-project-badge
          aria-hidden
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border px-0.5 text-xs leading-none font-semibold tracking-tight"
          style={{
            backgroundColor: monogram.background,
            color: monogram.color,
            borderColor: monogram.border,
          }}
        >
          {initials}
        </span>
        <span className="truncate text-sm font-medium text-text-primary">{project.name}</span>
        {project.pinned && <Star size={10} className="shrink-0 text-warning" fill="currentColor" />}
        <span className="flex-1" />
        {collapsed ? (
          <ChevronRight size={12} className="shrink-0 text-text-tertiary" />
        ) : (
          <ChevronDown size={12} className="shrink-0 text-text-tertiary" />
        )}
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

  const copyPath = (path: string) => {
    if (!path) return;
    void navigator.clipboard
      ?.writeText(path)
      .catch((err) => console.error("copy path failed", err));
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
      onSelect: () => copyPath(project.rootPath),
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
      onSelect: () =>
        void useProjectsStore
          .getState()
          .deleteProject(project.id)
          .catch(() => {}),
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
        onSelect: () => copyPath(thread.workspace ?? project?.rootPath ?? ""),
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
            await useThreadsStore
              .getState()
              .deleteThread(thread.id)
              .catch(() => {});
            if (
              useThreadsStore.getState().threads.some((candidate) => candidate.id === thread.id)
            ) {
              return;
            }
            useRunsStore.getState().dropThreadState(thread.id);
            const wasActive = useThreadsStore.getState().activeThreadId === thread.id;
            if (wasActive) useThreadsStore.getState().setActiveThread(null);
            if (pathname === `/thread/${thread.id}`) {
              void router.navigate({ to: "/chat" });
            }
          })();
        },
      },
    ];
  };

  return (
    <aside
      style={{ width }}
      className="glass-panel flex shrink-0 flex-col border-r border-border-subtle bg-panel"
    >
      <div
        data-tauri-drag-region
        className="flex h-10 shrink-0 items-center gap-2 border-b border-border-subtle px-3"
      >
        <span data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-2">
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

      <div ref={filterRef} className="relative flex items-center gap-1 px-2 py-2">
        <div className="relative min-w-0 flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-text-tertiary"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            aria-label="Search threads"
            type="search"
            className="h-8 w-full rounded-(--radius-sm) border border-border-subtle bg-surface pr-8 pl-7 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-strong focus:outline-none"
          />
          <button
            type="button"
            aria-label="Filter threads"
            aria-haspopup="menu"
            aria-expanded={filterOpen}
            onClick={() => setFilterOpen((open) => !open)}
            className={`absolute top-1/2 right-1 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-(--radius-sm) transition hover:bg-hover hover:text-text-secondary ${
              filter === "all" ? "text-text-tertiary" : "bg-active text-text-primary"
            }`}
          >
            <SlidersHorizontal size={13} />
          </button>
        </div>
        {filterOpen && (
          <div
            role="menu"
            aria-label="Filters"
            className="absolute top-full left-0 z-30 mt-1 w-44 rounded-(--radius-md) border border-border-strong bg-surface-raised py-1 shadow-xl"
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
                <div className="px-3 pb-1 pt-2 text-xs font-semibold tracking-wider text-text-tertiary uppercase">
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

      <footer className="flex items-center gap-1 border-t border-border-subtle p-2">
        <Tooltip label="Settings">
          <button
            type="button"
            aria-label="Settings"
            onClick={() => void router.navigate({ to: "/settings/appearance" })}
            className="flex h-8 w-8 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
          >
            <Settings size={16} />
          </button>
        </Tooltip>
        <Tooltip label="Pull requests">
          <button
            type="button"
            aria-label="Pull requests"
            onClick={() => void router.navigate({ to: "/pull-requests" })}
            className="flex h-8 w-8 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
          >
            <GitPullRequest size={16} />
          </button>
        </Tooltip>
        <Tooltip label="Usage">
          <button
            type="button"
            aria-label="Usage"
            onClick={() => void router.navigate({ to: "/usage" })}
            className="flex h-8 w-8 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
          >
            <BarChart3 size={16} />
          </button>
        </Tooltip>
        <Tooltip label="Refresh">
          <button
            type="button"
            aria-label="Refresh"
            onClick={refresh}
            className="flex h-8 w-8 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
          >
            <RefreshCw size={15} />
          </button>
        </Tooltip>
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
