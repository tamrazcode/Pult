import { useMemo } from "react";
import { FolderOpen, GitBranch, History } from "lucide-react";
import { EditorSplitButton } from "../ui/EditorSplitButton";
import { openInEditor } from "../../lib/ipc";
import { projectInitials, projectMonogram } from "../../lib/projectColor";
import { useGitStore } from "../../stores/git";
import { useProjectsStore } from "../../stores/projects";
import { useRunsStore } from "../../stores/runs";
import { useThreadsStore } from "../../stores/threads";
import { useUiStore } from "../../stores/ui";

/**
 * T3-style project context card: where this thread lives, its git state, and
 * who has worked here before. Replaces the old composer status line.
 */
export function ProjectCard({ threadId }: { threadId?: string | null }) {
  const thread = useThreadsStore((s) =>
    threadId ? s.threads.find((t) => t.id === threadId) : undefined,
  );
  const project = useProjectsStore((s) => {
    const id = thread?.projectId ?? (!threadId ? s.selectedProjectId : null);
    return id ? s.projects.find((p) => p.id === id) : undefined;
  });
  const git = useGitStore((s) => (threadId ? s.byThread[threadId] : undefined));
  const runsByThread = useRunsStore((s) => s.runsByThread);
  const threads = useThreadsStore((s) => s.threads);
  const instances = useUiStore((s) => s.instances);
  const setRightPanelTab = useUiStore((s) => s.setRightPanelTab);

  const previousAgents = useMemo(() => {
    if (!project) return { total: 0, failed: 0, names: [] as string[] };
    const ids = new Set(threads.filter((t) => t.projectId === project.id).map((t) => t.id));
    if (threadId) ids.add(threadId);
    const runs = [...ids].flatMap((id) => runsByThread[id] ?? []);
    const names = [...new Set(runs.map((run) => run.instanceId))].map(
      (id) => instances.find((instance) => instance.id === id)?.displayName ?? id,
    );
    return {
      total: runs.length,
      failed: runs.filter((run) => run.status === "failed").length,
      names,
    };
  }, [project, threads, threadId, runsByThread, instances]);

  if (!project) return null;

  const workspace = thread?.workspace ?? project.rootPath;
  const branch = git?.status?.branch ?? null;
  const added = git?.diff?.totalAdded ?? 0;
  const removed = git?.diff?.totalRemoved ?? 0;
  const dirty = added + removed > 0;
  const monogram = projectMonogram(project.color);

  return (
    <div className="shrink-0 border-b border-border-subtle p-2">
      <section className="rounded-(--radius-md) border border-border-subtle bg-surface">
        <button
          type="button"
          onClick={() =>
            void openInEditor(workspace).catch((err) => console.error("open_in_editor failed", err))
          }
          className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-hover"
        >
          <span
            data-project-badge
            aria-hidden
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-[0.625rem] leading-none font-semibold tracking-tight"
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
          className="flex w-full items-center gap-2 border-t border-border-subtle px-3 py-1.5 text-left text-xs transition hover:bg-hover"
        >
          <span className="text-text-secondary">Changes</span>
          <span className="text-text-tertiary">{dirty ? "Uncommitted" : "Clean"}</span>
          <span className="flex-1" />
          <span className="tnum text-success">+{added}</span>
          <span className="tnum text-danger">-{removed}</span>
        </button>

        <section className="border-t border-border-subtle px-3 py-1.5">
          <div className="flex items-center gap-2">
            <History size={12} className="shrink-0 text-text-tertiary" />
            <span className="text-xs text-text-secondary">Previous agents</span>
            <span className="flex-1" />
            {previousAgents.failed > 0 && (
              <span className="text-xs text-danger">{previousAgents.failed} failed</span>
            )}
            <span className="tnum text-xs text-text-tertiary">{previousAgents.total}</span>
          </div>
          {previousAgents.names.length > 0 && (
            <p className="mt-0.5 truncate text-xs text-text-tertiary">
              {previousAgents.names.join(" · ")}
            </p>
          )}
        </section>
      </section>
    </div>
  );
}
