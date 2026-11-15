import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Pencil, Plus } from "lucide-react";
import { CreateProjectDialog } from "../components/projects/CreateProjectDialog";
import { ProjectSettingsDialog } from "../components/projects/ProjectSettingsDialog";
import { projectInitials, projectMonogram } from "../lib/projectColor";
import { useProjectsStore } from "../stores/projects";

export const Route = createFileRoute("/settings/projects")({ component: ProjectsSettings });

function ProjectsSettings() {
  const projects = useProjectsStore((s) => s.projects);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="mx-auto max-w-2xl">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-medium text-text-primary">Projects</h2>
          <p className="mt-1 text-sm text-text-tertiary">
            Folders pult can work in, with their worktree strategy.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex h-8 items-center gap-1.5 rounded-(--radius-sm) bg-accent px-3 text-xs font-medium text-accent-fg transition hover:brightness-110"
        >
          <Plus size={13} /> New project
        </button>
      </div>

      <div className="mt-4 divide-y divide-border-subtle border-y border-border-subtle">
        {projects.length === 0 && (
          <p className="py-6 text-sm text-text-tertiary">No projects yet.</p>
        )}
        {projects.map((project) => {
          const monogram = projectMonogram(project.color);
          return (
            <div key={project.id} className="flex items-center gap-3 py-2.5">
              <span
                data-project-badge
                aria-hidden
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-xs leading-none font-semibold tracking-tight"
                style={{
                  backgroundColor: monogram.background,
                  color: monogram.color,
                  borderColor: monogram.border,
                }}
              >
                {projectInitials(project.name)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-text-primary">{project.name}</p>
                <p className="truncate font-mono text-xs text-text-tertiary">{project.rootPath}</p>
              </div>
              <span className="shrink-0 text-xs text-text-tertiary">
                {project.worktreeStrategy === "worktree" ? "Worktree" : "Root"}
              </span>
              <button
                type="button"
                aria-label={`Edit ${project.name}`}
                onClick={() => setEditingId(project.id)}
                className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
              >
                <Pencil size={13} />
              </button>
            </div>
          );
        })}
      </div>

      <CreateProjectDialog open={creating} onClose={() => setCreating(false)} />
      <ProjectSettingsDialog
        open={editingId !== null}
        projectId={editingId ?? ""}
        onClose={() => setEditingId(null)}
      />
    </div>
  );
}
