import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { FolderOpen } from "lucide-react";
import { ipcErrorMessage, pickFolder } from "../../lib/ipc";
import { PROJECT_COLORS, projectColorFor, useProjectsStore } from "../../stores/projects";
import { Button } from "../ui/button";

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Create a folder-backed project via the native picker. */
export function CreateProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [rootPath, setRootPath] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState(PROJECT_COLORS[0]);
  const [strategy, setStrategy] = useState<"root" | "worktree">("root");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRootPath("");
    setName("");
    setColor(PROJECT_COLORS[0]);
    setStrategy("root");
    setError(null);
    setBusy(false);
  }, [open]);

  if (!open) return null;

  const chooseFolder = async () => {
    const picked = await pickFolder("Choose project folder");
    if (!picked) return;
    const nextName = basename(picked);
    setRootPath(picked);
    setName(nextName);
    setColor(projectColorFor(nextName));
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!rootPath || !trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await useProjectsStore.getState().createProject(trimmed, rootPath, color, strategy);
      onClose();
      await router.navigate({ to: "/chat" });
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
        aria-label="New project"
        className="w-full max-w-md rounded-(--radius-lg) border border-border-strong bg-surface-raised p-5 shadow-2xl"
      >
        <h2 className="text-lg font-semibold text-text-primary">New project</h2>
        <p className="mt-1 text-sm text-text-tertiary">
          Threads in this project run inside the chosen folder.
        </p>

        <div className="mt-4 space-y-4">
          <div>
            <span className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">
              Folder
            </span>
            <div className="mt-1.5 flex items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => void chooseFolder()}>
                <FolderOpen size={14} />
                Choose folder
              </Button>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary">
                {rootPath || "No folder selected"}
              </span>
            </div>
          </div>

          <label className="block">
            <span className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">
              Name
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Project name"
              className="mt-1.5 h-9 w-full rounded-(--radius-sm) border border-border-subtle bg-(--input) px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-border-strong focus:outline-none"
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
                name="worktree-strategy"
                checked={strategy === "root"}
                onChange={() => setStrategy("root")}
                className="accent-(--accent)"
              />
              Direct folder
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-text-secondary">
              <input
                type="radio"
                name="worktree-strategy"
                checked={strategy === "worktree"}
                onChange={() => setStrategy("worktree")}
                className="accent-(--accent)"
              />
              Git worktree
            </label>
          </div>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void submit()}
            disabled={busy || !rootPath || !name.trim()}
          >
            Create
          </Button>
        </div>
      </div>
    </div>
  );
}
