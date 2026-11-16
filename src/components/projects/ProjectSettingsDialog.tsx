import { useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { PROJECT_COLORS, useProjectsStore } from "../../stores/projects";
import { Button } from "../ui/button";
import { WorkspaceStrategyRadio } from "./WorkspaceStrategyRadio";
import { localizeIpcError, useT } from "../../lib/i18n";

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
  const t = useT();
  const project = useProjectsStore((s) => s.projects.find((p) => p.id === projectId));
  const [name, setName] = useState("");
  const [color, setColor] = useState(PROJECT_COLORS[0]);
  const [strategy, setStrategy] = useState<"root" | "worktree">("root");
  const [pinned, setPinned] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    // Read fresh values once per project open: store updates while editing
    // must not clobber unsaved inputs.
    const current = useProjectsStore.getState().projects.find((p) => p.id === projectId);
    if (!current) return;
    setName(current.name);
    setColor(current.color ?? PROJECT_COLORS[0]);
    setStrategy(current.worktreeStrategy);
    setPinned(current.pinned);
    setConfirmDelete(false);
    setError(null);
    setBusy(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const frame = requestAnimationFrame(() => nameRef.current?.focus());
    return () => {
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(frame);
    };
  }, [open, projectId, onClose]);

  if (!open || !project) return null;

  const save = async () => {
    if (busy) return;
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
      setError(localizeIpcError(err));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await useProjectsStore.getState().deleteProject(project.id);
      onClose();
    } catch (err) {
      setError(localizeIpcError(err));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.projects.settingsTitle")}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
        className="w-full max-w-md rounded-(--radius-lg) border border-border-strong bg-surface-raised p-5 shadow-2xl"
      >
        <h2 className="text-lg font-semibold text-text-primary">
          {t("settings.projects.settingsTitle")}
        </h2>

        <div className="mt-4 space-y-4">
          <label className="block">
            <span className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">
              {t("common.name")}
            </span>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mt-1.5 h-9 w-full rounded-(--radius-sm) border border-border-subtle bg-(--input) px-3 text-sm text-text-primary focus:border-border-strong focus:outline-none"
            />
          </label>

          <div>
            <span className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">
              {t("common.color")}
            </span>
            <div
              role="group"
              aria-label={t("settings.projects.colorLabel")}
              className="mt-1.5 flex flex-wrap gap-2"
            >
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
              {t("common.workspace")}
            </span>
            <WorkspaceStrategyRadio
              name="settings-worktree"
              label={t("settings.projects.strategyRoot")}
              description={t("settings.projects.strategyRootDesc")}
              checked={strategy === "root"}
              onChange={() => setStrategy("root")}
            />
            <WorkspaceStrategyRadio
              name="settings-worktree"
              label={t("settings.projects.strategyWorktree")}
              description={t("settings.projects.strategyWorktreeDesc")}
              checked={strategy === "worktree"}
              onChange={() => setStrategy("worktree")}
            />
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              checked={pinned}
              onChange={(e) => setPinned(e.target.checked)}
              className="accent-(--accent)"
            />
            {t("settings.projects.star")}
          </label>

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              type="button"
              onClick={() => void navigator.clipboard.writeText(project.rootPath)}
            >
              <Copy size={13} />
              {t("settings.projects.copyPath")}
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
                <span className="text-sm text-danger">{t("settings.projects.deleteConfirm")}</span>
                <Button
                  variant="danger"
                  size="sm"
                  type="button"
                  className="shrink-0 whitespace-nowrap"
                  onClick={() => void remove()}
                  disabled={busy}
                >
                  {t("settings.projects.confirmDelete")}
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-text-secondary">
                  {t("settings.projects.deleteHint")}
                </span>
                <Button
                  variant="danger_outline"
                  size="sm"
                  type="button"
                  className="shrink-0 whitespace-nowrap"
                  onClick={() => setConfirmDelete(true)}
                  disabled={busy}
                >
                  {t("settings.projects.delete")}
                </Button>
              </div>
            )}
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" type="button" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" size="sm" type="submit" disabled={busy || !name.trim()}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </div>
  );
}
