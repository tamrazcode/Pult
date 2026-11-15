import { useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  File as FileIcon,
  Folder,
  FolderOpen,
} from "lucide-react";
import { ContextMenu, type ContextMenuItem } from "../ui/ContextMenu";
import { openInEditor, readImageDataUrl, workspaceReadText, workspaceTree } from "../../lib/ipc";
import type { WorkspaceEntry } from "../../lib/ipc";
import { useSettingsStore } from "../../stores/settings";
import { useThreadsStore } from "../../stores/threads";
import { useProjectsStore } from "../../stores/projects";
import { useUiStore } from "../../stores/ui";

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|svg)$/i;

function relativeToFull(root: string, path: string): string {
  return `${root.replace(/[\\/]+$/, "")}\\${path.replace(/\//g, "\\")}`;
}

function EditorButton({ onOpen }: { onOpen: (editor: string) => void }) {
  const preferred = useSettingsStore((s) => s.preferredEditor);
  const setPreferred = useSettingsStore((s) => s.setPreferredEditor);
  const [open, setOpen] = useState(false);
  const label =
    preferred === "vscode"
      ? "VS Code"
      : preferred === "antigravity"
        ? "Antigravity"
        : preferred === "explorer"
          ? "File Explorer"
          : "Zed";

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="relative flex shrink-0" onMouseDown={(event) => event.stopPropagation()}>
      <button
        type="button"
        title={`Open in ${label}`}
        onClick={() => onOpen(preferred)}
        className="flex h-7 items-center gap-1 rounded-l-(--radius-sm) border border-border-subtle px-2 text-xs text-text-secondary transition hover:bg-hover"
      >
        <ExternalLink size={12} /> {label}
      </button>
      <button
        type="button"
        aria-label="Choose editor"
        aria-expanded={open}
        title="Choose editor"
        onClick={() => setOpen((value) => !value)}
        className="flex h-7 w-6 items-center justify-center rounded-r-(--radius-sm) border border-l-0 border-border-subtle text-text-tertiary transition hover:bg-hover"
      >
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Editor"
          className="absolute top-full right-0 z-40 mt-1 w-40 rounded-(--radius-md) border border-border-strong bg-surface-raised py-1 shadow-(--shadow-composer)"
        >
          {(
            [
              ["vscode", "VS Code"],
              ["zed", "Zed"],
              ["antigravity", "Antigravity"],
              ["explorer", "File Explorer"],
            ] as const
          ).map(([id, name]) => (
            <button
              key={id}
              type="button"
              role="menuitem"
              onClick={() => {
                setPreferred(id);
                onOpen(id);
                setOpen(false);
              }}
              className={`flex w-full items-center px-3 py-1.5 text-left text-xs transition hover:bg-hover ${
                preferred === id ? "text-text-primary" : "text-text-secondary"
              }`}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** T3-style Files surface: workspace tree + preview, editor choice, context menu. */
export function FilesPanel({ threadId }: { threadId?: string | null }) {
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; entry: WorkspaceEntry } | null>(null);
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

  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    workspaceTree(threadId)
      .then((list) => {
        if (!cancelled) {
          setEntries(list);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  useEffect(() => {
    if (!threadId || !selected) return;
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
          if (!cancelled) setError(String(err));
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
        if (!cancelled) setError(String(err));
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
        label: `Open in ${preferredEditor === "vscode" ? "VS Code" : preferredEditor === "antigravity" ? "Antigravity" : preferredEditor === "explorer" ? "File Explorer" : "Zed"}`,
        onSelect: () =>
          void openInEditor(full, preferredEditor).catch((err) => setError(String(err))),
      },
      {
        id: "reveal",
        label: "Reveal in File Explorer",
        onSelect: () => void openInEditor(full, "explorer").catch((err) => setError(String(err))),
      },
      "separator",
      {
        id: "copy-rel",
        label: "Copy relative path",
        onSelect: () => void navigator.clipboard.writeText(entry.path).catch(() => undefined),
      },
      {
        id: "copy-full",
        label: "Copy full path",
        onSelect: () => void navigator.clipboard.writeText(full).catch(() => undefined),
      },
    ];
  };

  if (!threadId) {
    return <p className="p-4 text-sm text-text-tertiary">Open a thread to browse its workspace.</p>;
  }

  const breadcrumb = selected ? selected.split("/") : [];
  const depth = (path: string) => path.split("/").length - 1;
  const lines = preview?.split("\n") ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border-subtle px-2 py-1.5">
        <div className="min-w-0 flex-1 truncate text-xs text-text-tertiary" title={selected ?? ""}>
          {breadcrumb.length > 0 ? breadcrumb.join(" › ") : "Files"}
        </div>
        <EditorButton
          onOpen={(editor) => {
            if (!selected) return;
            void openInEditor(relativeToFull(root, selected), editor).catch((err) =>
              setError(String(err)),
            );
          }}
        />
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex w-44 shrink-0 flex-col border-r border-border-subtle">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search files…"
            aria-label="Search files"
            className="m-1.5 h-7 rounded-(--radius-sm) border border-border-subtle bg-surface px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-strong focus:outline-none"
          />
          <div className="min-h-0 flex-1 overflow-y-auto pb-2">
            {error && <p className="px-2 py-1 text-xs text-danger">{error}</p>}
            {visible.map((entry) => {
              const isCollapsed = collapsed.has(entry.path);
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
                  <span className="truncate">{entry.name}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-w-0 flex-1 overflow-auto p-2">
          {!selected && (
            <p className="p-2 text-xs text-text-tertiary">
              Pick a file to preview it, or click a file link in the chat.
            </p>
          )}
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
            <p className="p-2 text-xs text-text-tertiary">Loading preview…</p>
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
