import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { ipcErrorMessage } from "../../lib/ipc";
import { PROJECT_COLORS, useProjectsStore } from "../../stores/projects";
import { Button } from "../ui/button";

/** Edit a project's identity, worktree strategy, pin state, or delete it. */
export function ProjectSettingsDialog({
  open,
  projectId,
  onClose,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
}) {
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const [name, setName] = useState("");
  const [color, setColor] = useState(PROJECT_COLORS[0]);
  const [strategy, setStrategy] = useState<"root" | "worktree">("root");
  const [pinned, setPinned] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !project) return;
    setName(project.name);
    setColor(project.color ?? PROJECT_COLORS[0]);
    setStrategy(project.worktreeStrategy);
    setPinned(project.pinned);
    setConfirmDelete(false);
    setError(null);
    setBusy(false);
  }, [open, project]);

  if (!open || !project) return null;

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await useProjectsStore
        .getState()
        .updateProject(project.id, { name: trimmed, color, worktreeStrategy: strategy, pinned });
      onClose();
    } catch (err) {
      setError(ipcErrorMessage(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await useProjectsStore.getState().deleteProject(project.id);
      onClose();
    } catch (err) {
      setError(ipcErrorMessage(err));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Project settings"
        className="w-full max-w-md rounded-(--radius-lg) border border-border-strong bg-surface-raised p-5 shadow-2xl"
      >
        <h2 className="text-lg font-semibold text-text-primary">Project settings</h2>

        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">
              Name
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1.5 h-9 w-full rounded-(--radius-sm) border border-border-subtle bg-(--input) px-3 text-sm text-text-primary focus:border-border-strong focus:outline-none"
            />
          </label>

          <div>
            <span className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">
              Color
            </span>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {PROJECT_COLORS.map((swatch) => (
                <button
                  key={swatch}
                  type="button"
                  aria-label={swatch}
                  aria-pressed={color === swatch}
                  onClick={() => setColor(swatch)}
                  className={`h-7 w-7 rounded-full border-2 transition ${
                    color === swatch ? "border-text-primary" : "border-transparent"
                  }`}
                  style={{ backgroundColor: swatch }}
                />
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <span className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">
              Workspace
            </span>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-text-secondary">
              <input
                type="radio"
                name="settings-worktree"
                checked={strategy === "root"}
                onChange={() => setStrategy("root")}
                className="accent-(--accent)"
              />
              Direct folder
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-text-secondary">
              <input
                type="radio"
                name="settings-worktree"
                checked={strategy === "worktree"}
                onChange={() => setStrategy("worktree")}
                className="accent-(--accent)"
              />
              Git worktree
            </label>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => setPinned(e.target.checked)}
              className="accent-(--accent)"
            />
            Star this project
          </label>

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void navigator.clipboard.writeText(project.rootPath)}
            >
              <Copy size={13} />
              Copy path
            </Button>
            <span className="min-w-0 truncate font-mono text-xs text-text-tertiary">
              {project.rootPath}
            </span>
          </div>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}

          <div className="rounded-(--radius-md) border border-danger/40 p-3">
            {confirmDelete ? (
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-danger">
                  Delete this project? Threads stay, their folder link clears.
                </span>
                <Button variant="danger" size="sm" onClick={() => void remove()} disabled={busy}>
                  Confirm delete
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-text-secondary">
                  Deleting keeps its threads; they lose the project link.
                </span>
                <Button
                  variant="danger_outline"
                  size="sm"
                  onClick={() => setConfirmDelete(true)}
                  disabled={busy}
                >
                  Delete project
                </Button>
              </div>
            )}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => void save()} disabled={busy}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
