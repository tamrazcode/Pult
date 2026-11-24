import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Download,
  FolderPlus,
  GitPullRequest,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  SquareDashed,
  SquarePen,
  Star,
} from "lucide-react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { isTauri } from "../../lib/tauri";
import { localizeIpcError, translate, useT } from "../../lib/i18n";
import {
  appUpdateCheck,
  appUpdateInstall,
  onAppUpdateProgress,
  runsCancel,
  threadsWorktreeStatus,
  type AppUpdateInfo,
} from "../../lib/ipc";
import { useUiStore } from "../../stores/ui";
import { buildSidebarGroups, useThreadsStore, type SidebarFilter } from "../../stores/threads";
import { useProjectsStore } from "../../stores/projects";
import { useSettingsStore } from "../../stores/settings";
import { useDraftsStore } from "../../stores/drafts";
import { activeRunForThread, useRunsStore } from "../../stores/runs";
import type { Project, Thread, WorktreeDirtyStatus } from "../../lib/types";
import { PultLogo } from "../ui/PultLogo";
import { ThinkingAscii } from "../chat/MessagesTimeline";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import { Tooltip } from "../ui/Tooltip";
import { projectInitials, projectMonogram } from "../../lib/projectColor";
import { FadeText } from "../ui/FadeText";
import { CreateProjectDialog } from "../projects/CreateProjectDialog";
import { ProjectSettingsDialog } from "../projects/ProjectSettingsDialog";
import { SidebarToggleButton } from "./WindowChrome";

const UPDATE_RING = 2 * Math.PI * 13;

const FILTERS: Array<{ id: SidebarFilter; labelKey: string }> = [
  { id: "all", labelKey: "sidebar.filter.all" },
  { id: "unread", labelKey: "sidebar.filter.unread" },
  { id: "pinned", labelKey: "sidebar.filter.pinned" },
  { id: "working", labelKey: "sidebar.filter.working" },
  { id: "archived", labelKey: "sidebar.filter.archived" },
];

function relativeTime(ts: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seconds < 60) return translate("sidebar.time.now");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return translate("sidebar.time.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return translate("sidebar.time.hours", { count: hours });
  return translate("sidebar.time.days", { count: Math.floor(hours / 24) });
}

function ThreadRow({
  thread,
  active,
  unread,
  draft,
  onNavigate,
  onStar,
  renaming,
  onRename,
  onContextMenu,
}: {
  thread: Thread;
  active: boolean;
  unread: boolean;
  draft: boolean;
  onNavigate: () => void;
  onStar: () => void;
  renaming: boolean;
  onRename: (title: string | null) => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const t = useT();
  // A parked approval or elicitation is not "working": the user must see
  // which thread is waiting for a decision even from another thread.
  const waiting = useRunsStore((s) => {
    const runs = s.runsByThread[thread.id];
    if (!runs || runs.length === 0) return false;
    return runs.some((run) => {
      if (s.viewsByRun[run.id]?.pendingApproval) return true;
      return s.activeElicitation?.runId === run.id;
    });
  });
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
          aria-label={t("sidebar.threadTitle")}
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
          className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-1 pl-9 text-sm"
        >
          {draft && !active ? (
            <span
              data-draft="true"
              aria-label={t("sidebar.hasDraft")}
              title={t("sidebar.hasDraft")}
              className="flex shrink-0"
            >
              <SquarePen size={12} className="text-warning" />
            </span>
          ) : null}
          <FadeText text={thread.title || t("sidebar.untitled")} className="min-w-0" />
          {waiting ? (
            <span
              data-waiting="true"
              aria-label={t("sidebar.waitingForYou")}
              title={t("sidebar.waitingForYou")}
              className="ml-auto flex w-8 shrink-0 justify-end"
            >
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warning" />
            </span>
          ) : working ? (
            <span className="ml-auto flex w-8 shrink-0 justify-end">
              <ThinkingAscii />
            </span>
          ) : unread ? (
            <span
              data-unread="true"
              aria-label={t("sidebar.unreadThread")}
              className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
            />
          ) : (
            <span className="tnum ml-auto shrink-0 text-xs text-text-tertiary">
              {relativeTime(thread.updatedAt)}
            </span>
          )}
        </a>
      )}
      <button
        type="button"
        aria-label={thread.pinned ? t("sidebar.unstarThread") : t("sidebar.starThread")}
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
  const t = useT();
  const initials = projectInitials(project.name);
  const monogram = projectMonogram(project.color);
  return (
    <div
      data-project-row
      onContextMenu={onContextMenu}
      className="group flex items-center gap-1 rounded-(--radius-sm) px-2 py-1.5 transition hover:bg-hover"
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex min-w-0 shrink items-center gap-2 rounded-(--radius-sm) py-0.5 pr-1 pl-1 text-left"
      >
        <span
          data-project-badge
          aria-hidden
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[0.625rem] leading-none font-semibold tracking-tight"
          style={{
            backgroundColor: monogram.background,
            color: monogram.color,
            borderColor: monogram.border,
          }}
        >
          {initials}
        </span>
        <FadeText text={project.name} className="min-w-0 text-sm font-medium text-text-primary" />
      </button>
      <button
        type="button"
        aria-label={project.pinned ? t("sidebar.unstarProject") : t("sidebar.starProject")}
        onClick={onStar}
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-(--radius-sm) transition hover:bg-hover focus-visible:opacity-100 ${
          project.pinned ? "text-warning" : "text-text-tertiary opacity-0 group-hover:opacity-100"
        }`}
      >
        <Star size={10} fill={project.pinned ? "currentColor" : "none"} />
      </button>
      <span className="flex-1" />
      <button
        type="button"
        aria-label={t("sidebar.newThreadInProject")}
        title={t("sidebar.newThreadInProject")}
        onClick={onNewThread}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-(--radius-sm) text-text-tertiary opacity-0 transition hover:bg-hover hover:text-text-secondary focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Plus size={12} />
      </button>
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? t("sidebar.expandProject") : t("sidebar.collapseProject")}
        aria-expanded={!collapsed}
        data-project-chevron="right"
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
      </button>
    </div>
  );
}

/** Pult app update: idle, checking, available, installing or failed. */
type AppUpdateState = "idle" | "checking" | "available" | "installing" | "error";

export function Sidebar({ width }: { width: number }) {
  const t = useT();
  const projects = useProjectsStore((s) => s.projects);
  const threads = useThreadsStore((s) => s.threads);
  const unreadIds = useThreadsStore((s) => s.unreadIds);
  const collapsedProjects = useUiStore((s) => s.collapsedProjects);
  const drafts = useDraftsStore((s) => s.byThread);
  const attachmentDrafts = useDraftsStore((s) => s.attachments);
  const activeThreadId = useThreadsStore((s) => s.activeThreadId);
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<SidebarFilter>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsProjectId, setSettingsProjectId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [appUpdate, setAppUpdate] = useState<AppUpdateInfo | null>(null);
  const [updateState, setUpdateState] = useState<AppUpdateState>("idle");
  const [updateProgress, setUpdateProgress] = useState<{
    downloaded: number;
    total: number | null;
  }>({
    downloaded: 0,
    total: null,
  });
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateNotice, setUpdateNotice] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    project?: Project;
    thread?: Thread;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{
    thread: Thread;
    status: WorktreeDirtyStatus;
  } | null>(null);
  const filterRef = useRef<HTMLDivElement>(null);
  const progressPercent =
    updateProgress.total && updateProgress.total > 0
      ? Math.min(100, (updateProgress.downloaded / updateProgress.total) * 100)
      : 0;
  const updateLabel =
    updateState === "installing"
      ? updateProgress.total
        ? t("sidebar.installingUpdate", { percent: Math.round(progressPercent) })
        : t("sidebar.installingUpdateIndeterminate")
      : updateState === "checking"
        ? t("sidebar.checkingUpdate")
        : updateState === "available" && appUpdate
          ? t("sidebar.updateAvailable", { version: appUpdate.version })
          : updateState === "error" && updateError
            ? updateError
            : (updateNotice ?? t("sidebar.checkAppUpdate"));

  useEffect(() => {
    if (!isTauri()) return;
    void useProjectsStore.getState().loadProjects();
    void useThreadsStore.getState().loadThreads();
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void onAppUpdateProgress((payload) => {
      setUpdateProgress({ downloaded: payload.downloaded, total: payload.total });
    })
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      })
      .catch(() => {
        // Event bridge unavailable in plain-browser/test environments.
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!updateNotice) return;
    const timer = window.setTimeout(() => setUpdateNotice(null), 3000);
    return () => window.clearTimeout(timer);
  }, [updateNotice]);

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

  const performDelete = async (threadId: string, mode: "safe" | "keep" | "force_remove") => {
    const active = activeRunForThread(useRunsStore.getState().runsByThread[threadId]);
    if (active && (active.status === "running" || active.status === "queued")) {
      await runsCancel(active.id, mode === "force_remove").catch(() => {});
    }
    try {
      await useThreadsStore.getState().deleteThread(threadId, mode);
    } catch {
      return;
    }
    useRunsStore.getState().dropThreadState(threadId);
    const wasActive = useThreadsStore.getState().activeThreadId === threadId;
    if (wasActive) useThreadsStore.getState().setActiveThread(null);
    if (pathname === `/thread/${threadId}`) void router.navigate({ to: "/chat" });
  };

  const requestDelete = async (thread: Thread) => {
    // A worktree with uncommitted files needs an explicit choice; a plain
    // thread only asks when the user kept the confirmation setting on.
    const status = isTauri() ? await threadsWorktreeStatus(thread.id).catch(() => null) : null;
    if (status?.dirty || useSettingsStore.getState().confirmDeleteThread) {
      setDeleteTarget({
        thread,
        status: status ?? { dirty: false, modified: 0, untracked: 0, entries: [] },
      });
      return;
    }
    await performDelete(thread.id, "safe");
  };

  useEffect(() => {
    if (!deleteTarget) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDeleteTarget(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [deleteTarget]);

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

  const checkAppUpdate = useCallback(
    (manual = true) => {
      if (!isTauri() || updateState === "checking" || updateState === "installing") return;
      setUpdateState("checking");
      setUpdateError(null);
      setUpdateNotice(null);
      void appUpdateCheck()
        .then((info) => {
          if (info) {
            setAppUpdate(info);
            setUpdateState("available");
          } else {
            setAppUpdate(null);
            setUpdateState("idle");
            setUpdateNotice(t("sidebar.upToDate"));
          }
        })
        .catch((err) => {
          if (!manual) {
            // Background checks must not nag: a proxy blip is not a product error.
            setUpdateState("idle");
            return;
          }
          setUpdateState("error");
          setUpdateError(t("sidebar.updateCheckFailed", { detail: localizeIpcError(err) }));
        });
    },
    [t, updateState],
  );

  const installAppUpdate = () => {
    if (!isTauri() || updateState === "installing") return;
    setUpdateState("installing");
    setUpdateProgress({ downloaded: 0, total: null });
    setUpdateError(null);
    void appUpdateInstall()
      .then(() => {
        // The app restarts on success; reaching this means the release vanished
        // between the check and the install.
        setAppUpdate(null);
        setUpdateState("idle");
        setUpdateNotice(t("sidebar.upToDate"));
      })
      .catch((err) => {
        setUpdateState("error");
        setUpdateError(t("sidebar.updateInstallFailed", { detail: localizeIpcError(err) }));
      });
  };

  const onUpdateButton = () => {
    if (updateState === "available") installAppUpdate();
    else if (updateState !== "installing") checkAppUpdate();
  };

  useEffect(() => {
    if (!isTauri()) return;
    const run = () => {
      if (updateState !== "installing") checkAppUpdate(false);
    };
    const initial = window.setTimeout(run, 15_000);
    const timer = window.setInterval(run, 6 * 60 * 60 * 1000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [updateState, checkAppUpdate]);

  const copyPath = (path: string) => {
    if (!path) return;
    void navigator.clipboard
      ?.writeText(path)
      .catch((err) => console.error("copy path failed", err));
  };

  const projectMenuItems = (project: Project): Array<ContextMenuItem | "separator"> => [
    {
      id: "new-thread",
      label: t("sidebar.newThread"),
      icon: <SquarePen size={12} />,
      onSelect: () => newThread(project),
    },
    {
      id: "copy-path",
      label: t("sidebar.copyPath"),
      onSelect: () => copyPath(project.rootPath),
    },
    {
      id: "pin",
      label: project.pinned ? t("sidebar.unpinShort") : t("sidebar.pinShort"),
      onSelect: () => void useProjectsStore.getState().togglePin(project.id),
    },
    {
      id: "settings",
      label: t("sidebar.projectSettings"),
      onSelect: () => setSettingsProjectId(project.id),
    },
    "separator",
    {
      id: "delete",
      label: t("sidebar.delete"),
      danger: true,
      confirmLabel: t("sidebar.confirmDelete"),
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
        label: thread.pinned ? t("sidebar.unpinShort") : t("sidebar.pinShort"),
        onSelect: () => void useThreadsStore.getState().setThreadPinned(thread.id, !thread.pinned),
      },
      {
        id: "settle",
        label: t("sidebar.settle"),
        onSelect: () => void useThreadsStore.getState().setThreadStatus(thread.id, "settled"),
      },
      {
        id: "snooze",
        label: t("sidebar.snooze"),
        onSelect: () => void useThreadsStore.getState().setThreadStatus(thread.id, "snoozed"),
      },
      { id: "rename", label: t("sidebar.rename"), onSelect: () => setRenamingId(thread.id) },
      {
        id: "unread",
        label: unread ? t("sidebar.markRead") : t("sidebar.markUnread"),
        onSelect: () => useThreadsStore.getState().markUnread(thread.id, !unread),
      },
      {
        id: "copy-path",
        label: t("sidebar.copyPath"),
        onSelect: () => copyPath(thread.workspace ?? project?.rootPath ?? ""),
      },
      {
        id: "settings",
        label: t("sidebar.projectSettings"),
        disabled: thread.projectId === null,
        onSelect: () => setSettingsProjectId(thread.projectId),
      },
      {
        id: "archive",
        label: t("sidebar.archive"),
        onSelect: () => void useThreadsStore.getState().setThreadStatus(thread.id, "archived"),
      },
      "separator",
      {
        id: "delete",
        label: t("sidebar.delete"),
        danger: true,
        onSelect: () => void requestDelete(thread),
      },
    ];
  };

  return (
    <aside
      style={{ width }}
      className="glass-panel flex h-full shrink-0 flex-col border-r border-border-subtle bg-panel"
    >
      <div data-tauri-drag-region className="flex h-10 shrink-0 items-center gap-3 px-3">
        <SidebarToggleButton />
        <span data-tauri-drag-region className="flex min-w-0 flex-1 items-center gap-1">
          <PultLogo className="h-6 w-6 shrink-0 text-text-primary" />
          <span className="truncate text-sm font-normal tracking-tight text-text-primary">
            Pult
          </span>
        </span>
        <button
          type="button"
          aria-label={t("sidebar.back")}
          onClick={() => router.history.back()}
          className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          aria-label={t("sidebar.forward")}
          onClick={() => router.history.forward()}
          className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
        >
          <ArrowRight size={14} />
        </button>
      </div>

      <div ref={filterRef} className="relative flex items-center gap-2 px-3 py-3">
        <div className="relative min-w-0 flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-text-tertiary"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("sidebar.searchPlaceholder")}
            aria-label={t("sidebar.search")}
            type="search"
            className="h-8 w-full bg-transparent pr-8 pl-7 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none"
          />
          <button
            type="button"
            aria-label={t("sidebar.filter")}
            title={t("sidebar.filter")}
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
            aria-label={t("sidebar.filters")}
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
                {t(option.labelKey)}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          aria-label={t("sidebar.newProject")}
          title={t("sidebar.newProject")}
          onClick={() => setCreateOpen(true)}
          className="flex h-8 w-8 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
        >
          <FolderPlus size={15} />
        </button>
        <button
          type="button"
          aria-label={t("sidebar.newThread")}
          title={t("sidebar.newThread")}
          onClick={() => newThread(null)}
          className="flex h-8 w-8 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
        >
          <SquarePen size={15} />
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4" aria-label={t("sidebar.threads")}>
        {groups.map((group) => {
          const key = group.project?.id ?? "__none__";
          const noProjectCollapsed = collapsedProjects.includes("__none__");
          const isCollapsed = group.project
            ? collapsedProjects.includes(group.project.id)
            : noProjectCollapsed;
          return (
            <section key={key} className="mb-3">
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
                <div className="flex items-center gap-2 rounded-(--radius-sm) py-1.5 pr-2 pl-3 transition hover:bg-hover">
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center text-text-tertiary">
                    <SquareDashed size={14} />
                  </span>
                  <button
                    type="button"
                    aria-expanded={!noProjectCollapsed}
                    onClick={() => useUiStore.getState().toggleProjectCollapsed("__none__")}
                    className="min-w-0 flex-1 truncate text-left text-sm font-medium text-text-primary"
                  >
                    {t("sidebar.noProject")}
                  </button>
                  <button
                    type="button"
                    aria-label={
                      noProjectCollapsed ? t("sidebar.expandProject") : t("sidebar.collapseProject")
                    }
                    aria-expanded={!noProjectCollapsed}
                    data-project-chevron="right"
                    onClick={() => useUiStore.getState().toggleProjectCollapsed("__none__")}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
                  >
                    {noProjectCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  </button>
                </div>
              )}
              {!isCollapsed && (
                <div className="space-y-1">
                  {group.threads.map((thread) => (
                    <ThreadRow
                      key={thread.id}
                      thread={thread}
                      active={pathname === `/thread/${thread.id}` || activeThreadId === thread.id}
                      unread={unreadSet.has(thread.id)}
                      draft={Boolean(
                        drafts[thread.id]?.trim() ||
                        attachmentDrafts[thread.id]?.images.length ||
                        attachmentDrafts[thread.id]?.files.length,
                      )}
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

      <footer className="p-3">
        <div className="flex items-center gap-1">
          <Tooltip label={t("sidebar.settings")} align="left">
            <button
              type="button"
              aria-label={t("sidebar.settings")}
              onClick={() => void router.navigate({ to: "/settings/appearance" })}
              className="flex h-8 w-8 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
            >
              <Settings size={16} />
            </button>
          </Tooltip>
          <Tooltip label={t("sidebar.pullRequests")}>
            <button
              type="button"
              aria-label={t("sidebar.pullRequests")}
              onClick={() => void router.navigate({ to: "/pull-requests" })}
              className="flex h-8 w-8 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
            >
              <GitPullRequest size={16} />
            </button>
          </Tooltip>
          <Tooltip label={t("sidebar.usage")}>
            <button
              type="button"
              aria-label={t("sidebar.usage")}
              onClick={() => void router.navigate({ to: "/usage" })}
              className="flex h-8 w-8 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
            >
              <BarChart3 size={16} />
            </button>
          </Tooltip>
          <span className="flex-1" />
          <Tooltip label={updateLabel} align="right">
            <button
              type="button"
              aria-label={updateLabel}
              title={updateLabel}
              onClick={onUpdateButton}
              className="relative flex h-8 w-8 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
            >
              {updateState === "installing" ? (
                <>
                  <svg
                    aria-hidden
                    viewBox="0 0 32 32"
                    className="absolute inset-0 m-auto h-8 w-8 -rotate-90"
                  >
                    <circle
                      cx="16"
                      cy="16"
                      r="13"
                      fill="none"
                      stroke="var(--border-strong)"
                      strokeWidth="2"
                    />
                    <circle
                      cx="16"
                      cy="16"
                      r="13"
                      fill="none"
                      stroke="var(--accent)"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeDasharray={UPDATE_RING}
                      strokeDashoffset={
                        updateProgress.total
                          ? UPDATE_RING * (1 - progressPercent / 100)
                          : UPDATE_RING * 0.75
                      }
                      className={updateProgress.total ? undefined : "animate-spin origin-center"}
                    />
                  </svg>
                  <Download size={12} className="text-accent" />
                </>
              ) : updateState === "checking" ? (
                <Loader2 size={15} className="animate-spin" />
              ) : updateState === "available" ? (
                <Download size={15} className="text-accent" />
              ) : (
                <RefreshCw size={15} />
              )}
              {updateState === "available" && (
                <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-accent" />
              )}
            </button>
          </Tooltip>
        </div>
        {updateState === "installing" && (
          <p
            role="status"
            data-update-progress
            className="truncate px-1 pt-1 text-xs text-text-secondary"
            title={updateLabel}
          >
            {updateLabel}
          </p>
        )}
        {updateState === "error" && updateError && (
          <p
            role="alert"
            data-update-error
            className="truncate px-1 pt-1 text-xs text-danger"
            title={updateError}
          >
            {updateError}
          </p>
        )}
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

      {deleteTarget && (
        <div
          className="fixed inset-0 z-[90] grid place-items-center bg-black/50 p-6"
          onClick={() => setDeleteTarget(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t("sidebar.deleteThread")}
            onClick={(event) => event.stopPropagation()}
            className="w-full max-w-md rounded-(--radius-lg) border border-border-strong bg-surface-raised p-4 shadow-2xl"
          >
            <h2 className="text-sm font-medium text-text-primary">
              {t("sidebar.confirmDeleteTitle", { title: deleteTarget.thread.title })}
            </h2>
            <p className="mt-2 text-xs text-text-secondary">
              {deleteTarget.status.dirty
                ? t("sidebar.confirmDeleteWorktree", {
                    modified: deleteTarget.status.modified,
                    untracked: deleteTarget.status.untracked,
                  })
                : t("sidebar.confirmDeletePlain")}
              {deleteTarget.thread.workspace && (
                <span className="mt-1 block truncate font-mono text-text-tertiary">
                  {deleteTarget.thread.workspace}
                </span>
              )}
            </p>
            {deleteTarget.status.entries.length > 0 && (
              <ul className="mt-2 max-h-28 overflow-y-auto rounded-(--radius-sm) bg-canvas px-2 py-1 font-mono text-xs text-text-tertiary">
                {deleteTarget.status.entries.slice(0, 8).map((entry) => (
                  <li key={entry} className="truncate" title={entry}>
                    {entry}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 flex flex-col gap-2">
              {deleteTarget.status.dirty ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      const thread = deleteTarget.thread;
                      setDeleteTarget(null);
                      void performDelete(thread.id, "keep");
                    }}
                    className="h-8 rounded-(--radius-sm) border border-border-strong bg-surface px-3 text-xs text-text-primary transition hover:bg-hover"
                  >
                    {t("sidebar.deleteKeepWorktree")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const thread = deleteTarget.thread;
                      setDeleteTarget(null);
                      void performDelete(thread.id, "force_remove");
                    }}
                    className="h-8 rounded-(--radius-sm) bg-danger px-3 text-xs font-medium text-white transition hover:brightness-110"
                  >
                    {t("sidebar.deleteDiscardFiles", {
                      count: deleteTarget.status.untracked + deleteTarget.status.modified,
                    })}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    const thread = deleteTarget.thread;
                    setDeleteTarget(null);
                    void performDelete(thread.id, "safe");
                  }}
                  className="h-8 rounded-(--radius-sm) bg-danger px-3 text-xs font-medium text-white transition hover:brightness-110"
                >
                  {t("sidebar.deleteConfirm")}
                </button>
              )}
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className="h-8 rounded-(--radius-sm) px-3 text-xs text-text-tertiary transition hover:text-text-secondary"
              >
                {t("sidebar.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
