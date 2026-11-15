import { useEffect, useState } from "react";
import { FolderOpen, GitBranch, Plus, X } from "lucide-react";
import { EditorSplitButton } from "../ui/EditorSplitButton";
import { openInEditor } from "../../lib/ipc";
import { projectInitials, projectMonogram } from "../../lib/projectColor";
import { useGitStore } from "../../stores/git";
import { useProjectsStore } from "../../stores/projects";
import { useThreadsStore } from "../../stores/threads";
import { useUiStore } from "../../stores/ui";

interface ProjectScript {
  id: string;
  name: string;
  command: string;
}

function scriptsKey(projectId: string): string {
  return `pult:project-scripts:${projectId}`;
}

function readScripts(projectId: string): ProjectScript[] {
  try {
    const raw = localStorage.getItem(scriptsKey(projectId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as ProjectScript[]) : [];
  } catch {
    return [];
  }
}

/** T3-style project card floating at the right edge of the chat. */
export function ProjectInfoWidget({ threadId }: { threadId: string }) {
  const thread = useThreadsStore((s) => s.threads.find((candidate) => candidate.id === threadId));
  const project = useProjectsStore((s) =>
    thread?.projectId
      ? s.projects.find((candidate) => candidate.id === thread.projectId)
      : undefined,
  );
  const git = useGitStore((s) => s.byThread[threadId]);
  const setRightPanelTab = useUiStore((s) => s.setRightPanelTab);
  const setComposerPrefill = useUiStore((s) => s.setComposerPrefill);
  const [scripts, setScripts] = useState<ProjectScript[]>([]);
  const [adding, setAdding] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftCommand, setDraftCommand] = useState("");

  useEffect(() => {
    setScripts(project ? readScripts(project.id) : []);
    setAdding(false);
  }, [project]);

  if (!project) return null;

  const workspace = thread?.workspace ?? project.rootPath;
  const monogram = projectMonogram(project.color);
  const branch = git?.status?.branch ?? null;
  const added = git?.diff?.totalAdded ?? 0;
  const removed = git?.diff?.totalRemoved ?? 0;

  const saveScripts = (next: ProjectScript[]) => {
    setScripts(next);
    try {
      localStorage.setItem(scriptsKey(project.id), JSON.stringify(next));
    } catch {
      // storage unavailable: keep the in-memory list
    }
  };

  const addScript = () => {
    const name = draftName.trim();
    const command = draftCommand.trim();
    if (!name || !command) return;
    saveScripts([...scripts, { id: `${Date.now()}`, name, command }]);
    setDraftName("");
    setDraftCommand("");
    setAdding(false);
  };

  return (
    <aside
      aria-label="Project info"
      className="pointer-events-auto absolute top-3 right-3 z-20 w-72 rounded-(--radius-md) border border-border-strong bg-surface-raised/95 shadow-(--shadow-composer) backdrop-blur"
    >
      <button
        type="button"
        onClick={() =>
          void openInEditor(workspace).catch((err) => console.error("open_in_editor failed", err))
        }
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-hover"
      >
        <span
          aria-hidden
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[0.625rem] leading-none font-semibold tracking-tight"
          style={{
            backgroundColor: monogram.background,
            color: monogram.color,
            borderColor: monogram.border,
          }}
        >
          {projectInitials(project.name)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
          {project.name}
        </span>
        <FolderOpen size={14} className="shrink-0 text-text-tertiary" />
      </button>

      <EditorSplitButton
        variant="card"
        className="border-t border-border-subtle"
        onOpen={(editor) =>
          void openInEditor(workspace, editor).catch((err) =>
            console.error("open_in_editor failed", err),
          )
        }
      />

      <div className="border-t border-border-subtle px-3 py-1.5">
        <button
          type="button"
          onClick={() => setAdding((open) => !open)}
          className="flex w-full items-center gap-2 text-left text-xs text-text-secondary transition hover:text-text-primary"
        >
          <Plus size={12} className="shrink-0 text-text-tertiary" /> Add project script
        </button>
        {adding && (
          <div className="mt-1.5 space-y-1">
            <input
              autoFocus
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              placeholder="Name"
              aria-label="Script name"
              className="h-6 w-full rounded-(--radius-sm) border border-border-subtle bg-surface px-1.5 text-xs text-text-primary focus:border-border-strong focus:outline-none"
            />
            <div className="flex gap-1">
              <input
                value={draftCommand}
                onChange={(event) => setDraftCommand(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") addScript();
                  if (event.key === "Escape") setAdding(false);
                }}
                placeholder="pnpm dev"
                aria-label="Script command"
                className="h-6 min-w-0 flex-1 rounded-(--radius-sm) border border-border-subtle bg-surface px-1.5 font-mono text-xs text-text-primary focus:border-border-strong focus:outline-none"
              />
              <button
                type="button"
                aria-label="Save script"
                onClick={addScript}
                className="flex h-6 items-center rounded-(--radius-sm) bg-accent px-1.5 text-xs text-accent-fg"
              >
                Add
              </button>
            </div>
          </div>
        )}
        {scripts.map((script) => (
          <div key={script.id} className="mt-1 flex items-center gap-1">
            <button
              type="button"
              title={script.command}
              onClick={() => setComposerPrefill(`Run: ${script.command}`)}
              className="min-w-0 flex-1 truncate rounded-(--radius-sm) px-1 py-0.5 text-left font-mono text-xs text-text-secondary transition hover:bg-hover hover:text-text-primary"
            >
              {script.name}
            </button>
            <button
              type="button"
              aria-label={`Remove ${script.name}`}
              onClick={() => saveScripts(scripts.filter((item) => item.id !== script.id))}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
            >
              <X size={10} />
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2 border-t border-border-subtle px-3 py-1.5 text-xs">
        <GitBranch size={12} className="shrink-0 text-text-tertiary" />
        <span className="min-w-0 flex-1 truncate font-mono text-text-secondary">
          {branch ?? "No repository"}
        </span>
        {git?.status && (
          <span className="shrink-0 text-text-tertiary">
            {git.status.upstream ? "Published" : "Local only"}
          </span>
        )}
      </div>

      <button
        type="button"
        onClick={() => setRightPanelTab("diff")}
        className="flex w-full items-center gap-2 border-t border-border-subtle px-3 py-1.5 text-left text-xs text-text-secondary transition hover:bg-hover"
      >
        <span>Commit &amp; push</span>
        <span className="flex-1" />
        <span className="text-text-tertiary">Diff</span>
      </button>

      <button
        type="button"
        onClick={() => setRightPanelTab("diff")}
        className="flex w-full items-center gap-2 border-t border-border-subtle px-3 py-1.5 text-left text-xs transition hover:bg-hover"
      >
        <span className="text-text-secondary">Changes</span>
        <span className="flex-1" />
        <span className="tnum text-success">+{added}</span>
        <span className="tnum text-danger">-{removed}</span>
      </button>
    </aside>
  );
}
