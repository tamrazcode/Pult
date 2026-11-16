import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderOpen,
  RefreshCw,
} from "lucide-react";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import { EditorSplitButton } from "../ui/EditorSplitButton";
import { getEditorMeta } from "../../lib/editors";
import { buildFileGitStatusMap } from "../../lib/fileGitStatus";
import { openInEditor, readImageDataUrl, workspaceReadText, workspaceTree } from "../../lib/ipc";
import type { WorkspaceEntry } from "../../lib/ipc";
import { useGitStore } from "../../stores/git";
import { useSettingsStore } from "../../stores/settings";
import { useThreadsStore } from "../../stores/threads";
import { useProjectsStore } from "../../stores/projects";
import { useUiStore } from "../../stores/ui";
import { localizeIpcError, translate, useT } from "../../lib/i18n";

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

function relativeToFull(root: string, path: string): string {
  return `${root.replace(/[\\/]+$/, "")}\\${path.replace(/\//g, "\\")}`;
}

/** T3-style Files surface: workspace tree + preview, editor choice, context menu. */
export function FilesPanel({ threadId }: { threadId?: string | null }) {
  const t = useT();
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: WorkspaceEntry } | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [loadingTree, setLoadingTree] = useState(false);
  const treeRequest = useRef(0);
  const filePreview = useUiStore((s) => s.filePreview);
  const openFilePreview = useUiStore((s) => s.openFilePreview);
  const preferredEditor = useSettingsStore((s) => s.preferredEditor);
  const thread = useThreadsStore((s) =>
    threadId ? s.threads.find((candidate) => candidate.id === threadId) : undefined,
  );
  const project = useProjectsStore((s) => {
    const id = thread?.projectId ?? s.selectedProjectId;
    return id ? s.projects.find((candidate) => candidate.id === id) : undefined;
  });
  const root = thread?.workspace ?? project?.rootPath ?? "";
  const selected = filePreview;
  const gitStatus = useGitStore((s) => (threadId ? s.byThread[threadId]?.status : undefined));
  const gitByPath = useMemo(() => buildFileGitStatusMap(gitStatus), [gitStatus]);

  const loadTree = useCallback(async () => {
    if (!threadId) return;
    const request = ++treeRequest.current;
    setLoadingTree(true);
    try {
      const tree = await workspaceTree(threadId);
      if (request !== treeRequest.current) return;
      setEntries(tree.entries);
      setTruncated(tree.truncated);
      setError(null);
    } catch (err) {
      if (request === treeRequest.current) setError(localizeIpcError(err));
    } finally {
      if (request === treeRequest.current) setLoadingTree(false);
    }
  }, [threadId]);

  useEffect(() => {
    void loadTree();
    return () => {
      treeRequest.current += 1;
    };
  }, [loadTree]);

  useEffect(() => {
    if (!threadId || !selected) return;
    if (!root) {
      setError(translate("panels.files.noWorkspace"));
      return;
    }
    let cancelled = false;
    setPreview(null);
    setImage(null);
    setError(null);
    if (IMAGE_EXT.test(selected)) {
      readImageDataUrl(relativeToFull(root, selected))
        .then((url) => {
          if (!cancelled) setImage(url);
        })
        .catch((err) => {
          if (!cancelled) setError(localizeIpcError(err));
        });
      return () => {
        cancelled = true;
      };
    }
    workspaceReadText(threadId, selected)
      .then((text) => {
        if (!cancelled) setPreview(text);
      })
      .catch((err) => {
        if (!cancelled) setError(localizeIpcError(err));
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, selected, root]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (q && !entry.path.toLowerCase().includes(q)) return false;
      let parent = entry.path.split("/").slice(0, -1).join("/");
      while (parent) {
        if (collapsed.has(parent)) return false;
        parent = parent.split("/").slice(0, -1).join("/");
      }
      return true;
    });
  }, [entries, query, collapsed]);

  const toggleDir = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const menuItems = (entry: WorkspaceEntry): Array<ContextMenuItem | "separator"> => {
    const full = relativeToFull(root, entry.path);
    return [
      {
        id: "open-editor",
        label: t("panels.files.openIn", { editor: getEditorMeta(preferredEditor).label }),
        onSelect: () =>
          void openInEditor(full, preferredEditor).catch((err) => setError(localizeIpcError(err))),
      },
      {
        id: "reveal",
        label: t("panels.files.reveal"),
        onSelect: () =>
          void openInEditor(full, "explorer").catch((err) => setError(localizeIpcError(err))),
      },
      "separator",
      {
        id: "copy-rel",
        label: t("panels.files.copyRelativePath"),
        onSelect: () => void navigator.clipboard.writeText(entry.path).catch(() => undefined),
      },
      {
        id: "copy-full",
        label: t("panels.files.copyFullPath"),
        onSelect: () => void navigator.clipboard.writeText(full).catch(() => undefined),
      },
    ];
  };

  if (!threadId) {
    return <p className="p-4 text-sm text-text-tertiary">{t("panels.files.noThread")}</p>;
  }

  const breadcrumb = selected ? selected.split("/") : [];
  const depth = (path: string) => path.split("/").length - 1;
  const lines = preview?.split("\n") ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border-subtle px-2 py-1.5">
        <div className="min-w-0 flex-1 truncate text-xs text-text-tertiary" title={selected ?? ""}>
          {breadcrumb.length > 0 ? breadcrumb.join(" › ") : t("panels.files.title")}
        </div>
        <button
          type="button"
          aria-label={t("panels.files.refresh")}
          title={t("panels.files.refresh")}
          disabled={loadingTree}
          onClick={() => void loadTree()}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover disabled:opacity-60"
        >
          <RefreshCw size={13} className={loadingTree ? "animate-spin" : undefined} />
        </button>
        <EditorSplitButton
          onOpen={(editor) => {
            if (!selected || !root) return;
            void openInEditor(relativeToFull(root, selected), editor).catch((err) =>
              setError(localizeIpcError(err)),
            );
          }}
        />
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-44 shrink-0 flex-col border-r border-border-subtle">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("panels.files.searchPlaceholder")}
            aria-label={t("panels.files.search")}
            className="m-1.5 h-7 rounded-(--radius-sm) border border-border-subtle bg-surface px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-strong focus:outline-none"
          />
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            {error && <p className="px-2 py-1 text-xs text-danger">{error}</p>}
            {visible.map((entry) => {
              const isCollapsed = collapsed.has(entry.path);
              const git = gitByPath.get(entry.path);
              return (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => {
                    if (entry.isDir) toggleDir(entry.path);
                    else openFilePreview(entry.path);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ x: event.clientX, y: event.clientY, entry });
                  }}
                  title={entry.path}
                  className={`flex w-full items-center gap-1 rounded-(--radius-sm) py-0.5 pr-1 text-left text-xs transition hover:bg-hover ${
                    selected === entry.path ? "bg-active text-text-primary" : "text-text-secondary"
                  }`}
                  style={{ paddingLeft: 6 + depth(entry.path) * 10 }}
                >
                  {entry.isDir ? (
                    isCollapsed ? (
                      <ChevronRight size={10} className="shrink-0 text-text-tertiary" />
                    ) : (
                      <ChevronDown size={10} className="shrink-0 text-text-tertiary" />
                    )
                  ) : (
                    <span className="w-[10px] shrink-0" />
                  )}
                  {entry.isDir ? (
                    isCollapsed ? (
                      <Folder size={11} className="shrink-0 text-text-tertiary" />
                    ) : (
                      <FolderOpen size={11} className="shrink-0 text-text-tertiary" />
                    )
                  ) : (
                    <FileIcon size={11} className="shrink-0 text-text-tertiary" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {git && (
                    <span
                      data-git-status={git.code}
                      title={git.label}
                      aria-label={git.label}
                      className={`ml-auto shrink-0 font-mono text-xs font-medium ${git.colorClass}`}
                    >
                      {git.code}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {truncated && (
            <p
              role="status"
              data-truncated-notice
              className="border-t border-border-subtle px-2 py-1 text-xs text-text-tertiary"
            >
              {t("panels.files.truncated")}
            </p>
          )}
        </div>

        <div className="min-w-0 flex-1 overflow-auto p-2">
          {!selected && <p className="p-2 text-xs text-text-tertiary">{t("panels.files.pick")}</p>}
          {selected && image && (
            <img
              src={image}
              alt={selected}
              className="max-w-full rounded-(--radius-sm) border border-border-subtle"
            />
          )}
          {selected && !image && preview !== null && (
            <div className="flex font-mono text-xs leading-5">
              <pre className="shrink-0 pr-2 text-right text-text-tertiary select-none">
                {lines.map((_, index) => `${index + 1}\n`).join("")}
              </pre>
              <pre className="min-w-0 flex-1 whitespace-pre-wrap text-text-secondary">
                {preview}
              </pre>
            </div>
          )}
          {selected && !image && preview === null && !error && (
            <p className="p-2 text-xs text-text-tertiary">{t("panels.files.loadingPreview")}</p>
          )}
        </div>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.entry)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
