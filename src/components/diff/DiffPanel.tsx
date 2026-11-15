import { useEffect, useState } from "react";
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
import { useRunsStore } from "../../stores/runs";
import { useThreadsStore } from "../../stores/threads";
import type { DiffFile } from "../../lib/types";
import { SplitLines, UnifiedLines } from "./DiffLines";

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

const STATUS_LABEL: Record<string, string> = {
  added: "new",
  deleted: "deleted",
  renamed: "renamed",
  modified: "",
};

function FileCard({
  file,
  viewMode,
  reviewed,
  onToggleReviewed,
}: {
  file: DiffFile;
  viewMode: "unified" | "split";
  reviewed: boolean;
  onToggleReviewed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const statusLabel = STATUS_LABEL[file.status] ?? "";
  return (
    <div className="rounded-(--radius-md) border border-border-subtle bg-surface">
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <button
          onClick={() => setOpen((o) => !o)}
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
              binary
            </span>
          )}
        </button>
        <Diffstat added={file.added} removed={file.removed} />
        <button
          onClick={onToggleReviewed}
          title={reviewed ? "Mark as not reviewed" : "Mark reviewed"}
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
          {viewMode === "split" ? <SplitLines raw={file.raw} /> : <UnifiedLines raw={file.raw} />}
        </div>
      )}
    </div>
  );
}

/** Groups files by directory; dirs collapse. */
function groupByDir(files: DiffFile[]): Map<string, DiffFile[]> {
  const groups = new Map<string, DiffFile[]>();
  for (const file of files) {
    const idx = file.path.lastIndexOf("/");
    const dir = idx >= 0 ? file.path.slice(0, idx) : "";
    const list = groups.get(dir) ?? [];
    list.push(file);
    groups.set(dir, list);
  }
  return groups;
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
      <span className="truncate font-mono">{dir || "(root)"}</span>
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
  const state = useGitStore((s) => (threadId ? s.byThread[threadId] : undefined));
  const viewMode = useGitStore((s) => s.viewMode);
  const setViewMode = useGitStore((s) => s.setViewMode);
  const refresh = useGitStore((s) => s.refresh);
  const commit = useGitStore((s) => s.commit);
  const push = useGitStore((s) => s.push);
  const createPr = useGitStore((s) => s.createPr);
  const setCommitMessage = useGitStore((s) => s.setCommitMessage);
  const toggleReviewed = useGitStore((s) => s.toggleReviewed);
  const ghAvailable = useGitStore((s) => s.ghAvailable);
  const loadGhAvailability = useGitStore((s) => s.loadGhAvailability);
  const threadTitle = useThreadsStore((s) =>
    threadId ? s.threads.find((t) => t.id === threadId)?.title : undefined,
  );
  const suggested = useSuggestedCommitMessage(threadId);
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void loadGhAvailability();
  }, [loadGhAvailability]);

  // First open of the panel (or first visit of the thread) loads git state.
  useEffect(() => {
    if (!threadId) return;
    if (!useGitStore.getState().byThread[threadId]) void refresh(threadId);
  }, [threadId, refresh]);

  if (!threadId) return null;

  if (!state || (state.loading && !state.diff)) {
    return (
      <div className="flex flex-1 items-center justify-center px-8 text-center text-sm text-text-tertiary">
        {state?.loading ? "Reading git state…" : "No git state loaded yet."}
      </div>
    );
  }

  if (state.notRepo) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 text-center">
        <CircleSlash size={18} className="text-text-tertiary" />
        <p className="text-sm text-text-secondary">Not a git repository</p>
        <p className="text-xs text-text-tertiary">
          Pick a workspace inside a repo (or use a worktree thread) to review diffs here.
        </p>
      </div>
    );
  }

  const diff = state.diff;
  const files = diff?.files ?? [];
  const groups = groupByDir(files);
  const totalAdded = files.reduce((acc, f) => acc + f.added, 0);
  const totalRemoved = files.reduce((acc, f) => acc + f.removed, 0);
  const reviewedCount = files.filter((f) => state.reviewed[f.path] !== undefined).length;
  const hasChanges = files.length > 0;
  const commitReady = hasChanges && state.commitMessage.trim().length > 0;
  // Push: there is an unpushed commit. PR: a pushed commit exists — pushing
  // again is not a prerequisite for opening the PR.
  const pushReady = state.lastCommit !== null && state.lastCommit.sha !== state.pushedSha;
  const prReady = state.pushedSha !== null && ghAvailable;
  const commitTooltip = !hasChanges
    ? "Nothing to commit"
    : commitReady
      ? `Commit ${files.length} changed files`
      : "Type a commit message first";
  const pushTooltip =
    state.lastCommit === null
      ? "Commit first"
      : !pushReady
        ? "Everything is pushed"
        : "Push the new commit";
  const prTooltip = !state.pushedSha
    ? "Push first"
    : !ghAvailable
      ? "gh CLI not found on PATH"
      : "Open a pull request for the pushed commit";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* header: branch + totals + refresh + view toggle */}
      <div className="flex items-center gap-1.5 border-b border-border-subtle px-2.5 py-1.5">
        <span className="flex items-center gap-1 rounded-(--radius-sm) bg-active px-2 py-0.5 font-mono text-xs text-text-secondary">
          <GitBranch size={12} className="text-text-tertiary" />
          {state.status?.branch ?? "HEAD"}
          {state.status && state.status.ahead + state.status.behind > 0 && (
            <span className="tnum text-text-tertiary">
              {" "}
              ↑{state.status.ahead} ↓{state.status.behind}
            </span>
          )}
        </span>
        {hasChanges && <Diffstat added={totalAdded} removed={totalRemoved} />}
        <span className="tnum text-xs text-text-tertiary">
          {reviewedCount}/{files.length} reviewed
        </span>
        <div className="flex-1" />
        <button
          onClick={() => void refresh(threadId)}
          title="Re-read git status and diff"
          className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
        >
          <RefreshCw size={13} className={state.loading ? "animate-spin" : ""} />
        </button>
        <div className="flex h-7 overflow-hidden rounded-(--radius-sm) border border-border-subtle text-xs">
          {(["unified", "split"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className={`px-2 transition ${
                viewMode === mode
                  ? "bg-active text-text-primary"
                  : "text-text-tertiary hover:bg-hover"
              }`}
            >
              {mode === "unified" ? "Unified" : "Split"}
            </button>
          ))}
        </div>
      </div>

      {/* actions: commit ▸ push ▸ PR */}
      <div className="flex items-center gap-1.5 border-b border-border-subtle px-2.5 py-1.5">
        <input
          value={state.commitMessage}
          onChange={(e) => setCommitMessage(threadId, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && commitReady) void commit(threadId);
          }}
          placeholder="Commit message…"
          aria-label="Commit message"
          className="h-7 min-w-0 flex-1 rounded-(--radius-sm) border border-border-subtle bg-(--input) px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-strong focus:outline-none"
        />
        {suggested && !state.commitMessage && (
          <button
            onClick={() => setCommitMessage(threadId, suggested)}
            title={`Agent suggested: ${suggested}`}
            className="flex h-7 shrink-0 items-center rounded-(--radius-sm) border border-border-subtle bg-surface px-2 text-xs text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
          >
            Use suggested
          </button>
        )}
        <ActionButton
          onClick={() => void commit(threadId)}
          disabled={!commitReady}
          tooltip={commitTooltip}
          icon={Check}
          label="Commit"
          busy={state.busy === "commit"}
        />
        <ActionButton
          onClick={() => void push(threadId)}
          disabled={!pushReady}
          tooltip={pushTooltip}
          icon={Upload}
          label="Push"
          busy={state.busy === "push"}
        />
        <ActionButton
          onClick={() => void createPr(threadId, threadTitle ?? "thread")}
          disabled={!prReady}
          tooltip={prTooltip}
          icon={GitPullRequest}
          label="Create PR"
          busy={state.busy === "pr"}
        />
      </div>

      {state.lastCommit && (
        <div className="flex items-center gap-2 border-b border-border-subtle px-2.5 py-1 text-xs text-text-tertiary">
          <span className="font-mono">{state.lastCommit.sha.slice(0, 7)}</span>
          <span>
            committed {state.lastCommit.filesCommitted}{" "}
            {state.lastCommit.filesCommitted === 1 ? "file" : "files"}
          </span>
          {state.pushedSha === state.lastCommit.sha && <span>· pushed</span>}
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

      {/* file tree */}
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {files.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-text-tertiary">
            Working tree matches {diff?.base ?? "HEAD"}.
          </p>
        ) : (
          [...groups.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([dir, dirFiles]) => {
              const dirOpen = openDirs[dir] ?? true;
              return (
                <div key={dir}>
                  {dir && (
                    <DirRow
                      dir={dir}
                      count={dirFiles.length}
                      open={dirOpen}
                      onToggle={() => setOpenDirs((m) => ({ ...m, [dir]: !dirOpen }))}
                    />
                  )}
                  {dirOpen &&
                    dirFiles.map((file) => (
                      <div key={file.path} className={dir ? "ml-3" : ""}>
                        <FileCard
                          file={file}
                          viewMode={viewMode}
                          reviewed={state.reviewed[file.path] !== undefined}
                          onToggleReviewed={() => toggleReviewed(threadId, file.path, file.raw)}
                        />
                      </div>
                    ))}
                </div>
              );
            })
        )}
      </div>
    </div>
  );
}
