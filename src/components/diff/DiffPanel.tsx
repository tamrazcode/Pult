import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  GitBranch,
  GitPullRequest,
  RefreshCw,
  Upload,
} from "lucide-react";
import { openExternalUrl } from "../../lib/ipc";
import { useGitStore } from "../../stores/git";
import type { FilePatchState } from "../../stores/git";
import { useRunsStore } from "../../stores/runs";
import { useSettingsStore } from "../../stores/settings";
import { useThreadsStore } from "../../stores/threads";
import type { DiffFileSummary } from "../../lib/types";
import { plural, useT } from "../../lib/i18n";
import { SplitLines, UnifiedLines } from "./DiffLines";
import { useVirtualRows } from "./useVirtualRows";

/** Latest suggested-commit line, cached per run at finish; scans runs only. */
function useSuggestedCommitMessage(threadId: string | null): string | null {
  return useRunsStore((s) => {
    if (!threadId) return null;
    const runs = s.runsByThread[threadId] ?? [];
    for (let i = runs.length - 1; i >= 0; i -= 1) {
      const value = s.viewsByRun[runs[i].id]?.suggestedCommit;
      if (value) return value;
    }
    return null;
  });
}

function Diffstat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="tnum shrink-0 text-xs">
      <span className="text-success">+{added}</span> <span className="text-danger">−{removed}</span>
    </span>
  );
}

const STATUS_KEY: Record<string, string> = {
  added: "panels.diff.status.new",
  deleted: "panels.diff.status.deleted",
  renamed: "panels.diff.status.renamed",
  modified: "",
};

function FileCard({
  file,
  patch,
  viewMode,
  reviewed,
  open,
  onToggle,
  onToggleReviewed,
}: {
  file: DiffFileSummary;
  patch: FilePatchState | undefined;
  viewMode: "unified" | "split";
  reviewed: boolean;
  open: boolean;
  onToggle: () => void;
  onToggleReviewed: () => void;
}) {
  const t = useT();
  const statusKey = STATUS_KEY[file.status];
  const statusLabel = statusKey ? t(statusKey) : "";
  return (
    <div className="rounded-(--radius-md) border border-border-subtle bg-surface">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <button
          onClick={onToggle}
          aria-expanded={open}
          title={file.path}
          className="flex min-w-0 flex-1 items-center gap-1 text-left"
        >
          <ChevronRight
            size={12}
            className={`shrink-0 text-text-tertiary transition-transform ${open ? "rotate-90" : ""}`}
          />
          <span className="truncate font-mono text-xs text-text-secondary">{file.path}</span>
          {statusLabel && (
            <span className="shrink-0 rounded-full bg-active px-1.5 text-xs text-text-tertiary">
              {statusLabel}
            </span>
          )}
          {file.binary && (
            <span className="shrink-0 rounded-full bg-active px-1.5 text-xs text-text-tertiary">
              {t("panels.diff.binary")}
            </span>
          )}
        </button>
        <Diffstat added={file.added} removed={file.removed} />
        <button
          onClick={onToggleReviewed}
          title={reviewed ? t("panels.diff.unmarkReviewed") : t("panels.diff.markReviewed")}
          aria-label={reviewed ? t("panels.diff.unmarkReviewed") : t("panels.diff.markReviewed")}
          aria-pressed={reviewed}
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-(--radius-sm) border transition ${
            reviewed
              ? "border-success bg-diff-add-bg text-success"
              : "border-border-strong text-transparent hover:text-text-tertiary"
          }`}
        >
          <Check size={12} />
        </button>
      </div>
      {open && (
        <div className="border-t border-border-subtle bg-canvas">
          {patch?.loading ? (
            <p className="px-3 py-2 text-xs text-text-tertiary">{t("panels.diff.loading")}</p>
          ) : patch?.error ? (
            <p className="px-3 py-2 text-xs text-danger">{patch.error}</p>
          ) : patch?.file ? (
            viewMode === "split" ? (
              <SplitLines raw={patch.file.raw} />
            ) : (
              <UnifiedLines raw={patch.file.raw} />
            )
          ) : (
            <p className="px-3 py-2 text-xs text-text-tertiary">{t("panels.diff.loading")}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** Groups files by directory; dirs collapse. */
function groupByDir(files: DiffFileSummary[]): Map<string, DiffFileSummary[]> {
  const groups = new Map<string, DiffFileSummary[]>();
  for (const file of files) {
    const idx = file.path.lastIndexOf("/");
    const dir = idx >= 0 ? file.path.slice(0, idx) : "";
    const list = groups.get(dir) ?? [];
    list.push(file);
    groups.set(dir, list);
  }
  return groups;
}

/** Large diffs start collapsed so thousands of rows never mount at once. */
function defaultDirOpen(dirFiles: number, totalFiles: number): boolean {
  return totalFiles <= 200 && dirFiles <= 100;
}

function DirRow({
  dir,
  count,
  open,
  onToggle,
}: {
  dir: string;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <button
      onClick={onToggle}
      aria-expanded={open}
      className="flex w-full items-center gap-1 px-1 py-1 text-left text-xs text-text-tertiary hover:text-text-secondary"
    >
      <ChevronDown
        size={12}
        className={`shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
      />
      <span className="truncate font-mono">{dir || t("panels.diff.root")}</span>
      <span className="tnum ml-auto shrink-0">{count}</span>
    </button>
  );
}

function ActionButton({
  onClick,
  disabled,
  tooltip,
  icon: Icon,
  label,
  busy,
}: {
  onClick: () => void;
  disabled: boolean;
  tooltip: string;
  icon: typeof Upload;
  label: string;
  busy: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || busy}
      title={tooltip}
      className="flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-(--radius-sm) border border-border-subtle bg-surface px-2.5 text-xs text-text-secondary transition enabled:hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50"
    >
      {busy ? (
        <RefreshCw size={12} className="animate-spin" />
      ) : (
        <Icon size={12} className="text-text-tertiary" />
      )}
      {label}
    </button>
  );
}

export function DiffPanel({ threadId }: { threadId: string | null }) {
  const t = useT();
  const state = useGitStore((s) => (threadId ? s.byThread[threadId] : undefined));
  const viewMode = useGitStore((s) => s.viewMode);
  const refresh = useGitStore((s) => s.refresh);
  const commit = useGitStore((s) => s.commit);
  const push = useGitStore((s) => s.push);
  const createPr = useGitStore((s) => s.createPr);
  const setCommitMessage = useGitStore((s) => s.setCommitMessage);
  const toggleReviewed = useGitStore((s) => s.toggleReviewed);
  const loadFileDiff = useGitStore((s) => s.loadFileDiff);
  const ghAvailable = useGitStore((s) => s.ghAvailable);
  const loadGhAvailability = useGitStore((s) => s.loadGhAvailability);
  const threadTitle = useThreadsStore((s) =>
    threadId ? s.threads.find((t) => t.id === threadId)?.title : undefined,
  );
  const suggested = useSuggestedCommitMessage(threadId);
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({});
  const [openFiles, setOpenFiles] = useState<Record<string, boolean>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  const files = useMemo(() => state?.diff?.files ?? [], [state?.diff?.files]);
  const groups = useMemo(() => groupByDir(files), [files]);
  const rows = useMemo(() => {
    const next: Array<
      | { kind: "dir"; dir: string; count: number; open: boolean }
      | { kind: "file"; file: DiffFileSummary; nested: boolean }
    > = [];
    for (const [dir, dirFiles] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const open = openDirs[dir] ?? defaultDirOpen(dirFiles.length, files.length);
      if (dir) next.push({ kind: "dir", dir, count: dirFiles.length, open });
      if (dir && !open) continue;
      for (const file of dirFiles) next.push({ kind: "file", file, nested: dir.length > 0 });
    }
    return next;
  }, [groups, files.length, openDirs]);
  const { totalHeight, virtualItems, measureElement, onScroll } = useVirtualRows({
    count: rows.length,
    getItemKey: (index) => {
      const row = rows[index];
      return row.kind === "dir" ? `dir:${row.dir}` : `file:${row.file.path}`;
    },
    scrollRef,
    estimateHeight: (index) => (rows[index].kind === "dir" ? 30 : 38),
    overscan: 6,
  });
  // Stable per-row refs: inline callbacks re-observe every row on every render.
  const measureRef = useRef(measureElement);
  measureRef.current = measureElement;
  const rowRefs = useRef(new Map<string, (element: HTMLDivElement | null) => void>());
  const refFor = (key: string) => {
    let callback = rowRefs.current.get(key);
    if (!callback) {
      callback = (element) => measureRef.current(key, element);
      rowRefs.current.set(key, callback);
    }
    return callback;
  };

  useEffect(() => {
    void loadGhAvailability();
  }, [loadGhAvailability]);

  // First open of the panel (or first visit of the thread) loads git state.
  useEffect(() => {
    if (!threadId) return;
    if (!useGitStore.getState().byThread[threadId]) void refresh(threadId);
  }, [threadId, refresh]);

  // A refresh evicts patches whose hash changed; reload any still-open row.
  useEffect(() => {
    if (!threadId) return;
    for (const [path, open] of Object.entries(openFiles)) {
      if (open && !state?.filePatches[path]) void loadFileDiff(threadId, path);
    }
  }, [openFiles, state?.filePatches, threadId, loadFileDiff]);

  if (!threadId) return null;

  if (!state || (state.loading && !state.diff)) {
    return (
      <div className="flex flex-1 items-center justify-center px-8 text-center text-sm text-text-tertiary">
        {state?.loading ? t("panels.diff.reading") : t("panels.diff.noState")}
      </div>
    );
  }

  if (state.notRepo) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 text-center">
        <CircleSlash size={18} className="text-text-tertiary" />
        <p className="text-sm text-text-secondary">{t("panels.diff.notRepo")}</p>
        <p className="text-xs text-text-tertiary">{t("panels.diff.notRepoBody")}</p>
      </div>
    );
  }

  const diff = state.diff;
  const totalAdded = diff?.totalAdded ?? files.reduce((acc, file) => acc + file.added, 0);
  const totalRemoved = diff?.totalRemoved ?? files.reduce((acc, file) => acc + file.removed, 0);
  const reviewedCount = files.filter((f) => state.reviewed[f.path] !== undefined).length;
  const hasChanges = files.length > 0;
  const commitReady = hasChanges && state.commitMessage.trim().length > 0;
  // Push: there is an unpushed commit. PR: a pushed commit exists — pushing
  // again is not a prerequisite for opening the PR.
  const pushReady = state.lastCommit !== null && state.lastCommit.sha !== state.pushedSha;
  const prReady = state.pushedSha !== null && ghAvailable;
  const commitTooltip = !hasChanges
    ? t("panels.diff.nothingToCommit")
    : commitReady
      ? plural("panels.diff.commitCount", files.length)
      : t("panels.diff.typeMessage");
  const pushTooltip =
    state.lastCommit === null
      ? t("panels.diff.commitFirst")
      : !pushReady
        ? t("panels.diff.allPushed")
        : t("panels.diff.pushNewCommit");
  const prTooltip = !state.pushedSha
    ? t("panels.diff.pushFirst")
    : !ghAvailable
      ? t("panels.diff.ghMissing")
      : t("panels.diff.openPr");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* header: branch + totals + refresh + view toggle */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border-subtle px-2.5 py-1.5">
        <span className="flex min-w-0 max-w-full items-center gap-1 rounded-(--radius-sm) bg-active px-2 py-0.5 font-mono text-xs text-text-secondary">
          <GitBranch size={12} className="shrink-0 text-text-tertiary" />
          <span className="truncate">{state.status?.branch ?? "HEAD"}</span>
          {state.status && state.status.ahead + state.status.behind > 0 && (
            <span className="tnum shrink-0 text-text-tertiary">
              {" "}
              ↑{state.status.ahead} ↓{state.status.behind}
            </span>
          )}
        </span>
        {hasChanges && <Diffstat added={totalAdded} removed={totalRemoved} />}
        <span className="tnum shrink-0 text-xs whitespace-nowrap text-text-tertiary">
          {t("panels.diff.reviewed", { reviewed: reviewedCount, total: files.length })}
        </span>
        <div className="flex-1" />
        <button
          onClick={() => void refresh(threadId)}
          title={t("panels.diff.refreshTitle")}
          aria-label={t("panels.diff.refresh")}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
        >
          <RefreshCw size={13} className={state.loading ? "animate-spin" : ""} />
        </button>
        <div className="flex h-7 shrink-0 overflow-hidden rounded-(--radius-sm) border border-border-subtle text-xs">
          {(["unified", "split"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => useSettingsStore.getState().setDiffViewMode(mode)}
              aria-pressed={viewMode === mode}
              className={`px-2 transition ${
                viewMode === mode
                  ? "bg-active text-text-primary"
                  : "text-text-tertiary hover:bg-hover"
              }`}
            >
              {mode === "unified" ? t("panels.diff.unified") : t("panels.diff.split")}
            </button>
          ))}
        </div>
      </div>

      {/* actions: commit ▸ push ▸ PR */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border-subtle px-2.5 py-1.5">
        <input
          value={state.commitMessage}
          onChange={(e) => setCommitMessage(threadId, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && commitReady) void commit(threadId);
          }}
          placeholder={t("panels.diff.commitPlaceholder")}
          aria-label={t("panels.diff.commitMessage")}
          className="h-7 min-w-[120px] flex-1 rounded-(--radius-sm) border border-border-subtle bg-(--input) px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-strong focus:outline-none"
        />
        {suggested && !state.commitMessage && (
          <button
            onClick={() => setCommitMessage(threadId, suggested)}
            title={t("panels.diff.suggested", { message: suggested })}
            className="flex h-7 shrink-0 items-center rounded-(--radius-sm) border border-border-subtle bg-surface px-2 text-xs text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
          >
            {t("panels.diff.useSuggested")}
          </button>
        )}
        <ActionButton
          onClick={() => void commit(threadId)}
          disabled={!commitReady}
          tooltip={commitTooltip}
          icon={Check}
          label={t("panels.diff.commit")}
          busy={state.busy === "commit"}
        />
        <ActionButton
          onClick={() => void push(threadId)}
          disabled={!pushReady}
          tooltip={pushTooltip}
          icon={Upload}
          label={t("panels.diff.push")}
          busy={state.busy === "push"}
        />
        <ActionButton
          onClick={() => void createPr(threadId, threadTitle ?? "thread")}
          disabled={!prReady}
          tooltip={prTooltip}
          icon={GitPullRequest}
          label={t("panels.diff.createPr")}
          busy={state.busy === "pr"}
        />
      </div>

      {state.lastCommit && (
        <div className="flex items-center gap-2 border-b border-border-subtle px-2.5 py-1 text-xs text-text-tertiary">
          <span className="font-mono">{state.lastCommit.sha.slice(0, 7)}</span>
          <span>{plural("panels.diff.committed", state.lastCommit.filesCommitted)}</span>
          {state.pushedSha === state.lastCommit.sha && <span>{t("panels.diff.pushed")}</span>}
          {state.prUrl && (
            <button
              onClick={() => void openExternalUrl(state.prUrl!)}
              className="ml-auto truncate text-accent hover:underline"
            >
              {state.prUrl}
            </button>
          )}
        </div>
      )}

      {state.error && (
        <p className="border-b border-border-subtle bg-diff-del-bg px-2.5 py-1.5 text-xs text-diff-del-fg">
          {state.error}
        </p>
      )}

      {/* virtualized file tree: only rows in the viewport are mounted */}
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto p-2">
        {files.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-text-tertiary">
            {t("panels.diff.clean", { base: diff?.base ?? "HEAD" })}
          </p>
        ) : (
          <div style={{ height: totalHeight, position: "relative" }}>
            {virtualItems.map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              return (
                <div
                  key={item.key}
                  ref={refFor(item.key)}
                  data-diff-dir-row={row.kind === "dir" ? "" : undefined}
                  data-diff-file-row={row.kind === "file" ? "" : undefined}
                  className={`absolute inset-x-0 ${row.kind === "file" && row.nested ? "pl-3" : ""}`}
                  style={{ transform: `translateY(${item.offsetTop}px)` }}
                >
                  {row.kind === "dir" ? (
                    <DirRow
                      dir={row.dir}
                      count={row.count}
                      open={row.open}
                      onToggle={() => setOpenDirs((open) => ({ ...open, [row.dir]: !row.open }))}
                    />
                  ) : (
                    <FileCard
                      file={row.file}
                      patch={state.filePatches[row.file.path]}
                      viewMode={viewMode}
                      reviewed={state.reviewed[row.file.path] !== undefined}
                      open={openFiles[row.file.path] === true}
                      onToggle={() => {
                        const open = openFiles[row.file.path] !== true;
                        setOpenFiles((current) => ({
                          ...current,
                          [row.file.path]: open,
                        }));
                        if (open) void loadFileDiff(threadId, row.file.path);
                      }}
                      onToggleReviewed={() =>
                        toggleReviewed(threadId, row.file.path, row.file.patchHash)
                      }
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
