import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { FolderOpen } from "lucide-react";
import { pickFolder } from "../../lib/ipc";
import { PROJECT_COLORS, projectColorFor, useProjectsStore } from "../../stores/projects";
import { Button } from "../ui/button";
import { WorkspaceStrategyRadio } from "./WorkspaceStrategyRadio";
import { localizeIpcError, useT } from "../../lib/i18n";

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Create a folder-backed project via the native picker. */
export function CreateProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const router = useRouter();
  const [rootPath, setRootPath] = useState("");
  const [name, setName] = useState("");
  const [color, setColor] = useState(
    () => PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)],
  );
  const [strategy, setStrategy] = useState<"root" | "worktree">("root");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setRootPath("");
    setName("");
    setColor(PROJECT_COLORS[Math.floor(Math.random() * PROJECT_COLORS.length)]);
    setStrategy("root");
    setError(null);
    setBusy(false);
    setPicking(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const frame = requestAnimationFrame(() => nameRef.current?.focus());
    return () => {
      window.removeEventListener("keydown", onKey);
      cancelAnimationFrame(frame);
    };
  }, [open, onClose]);

  if (!open) return null;

  const chooseFolder = async () => {
    if (busy || picking) return;
    setPicking(true);
    setError(null);
    try {
      const picked = await pickFolder(t("settings.projects.chooseFolderTitle"));
      if (!picked) return;
      const nextName = basename(picked);
      setRootPath(picked);
      setName(nextName);
      setColor(projectColorFor(nextName));
    } catch (err) {
      setError(localizeIpcError(err));
    } finally {
      setPicking(false);
    }
  };

  const submit = async () => {
    if (busy) return;
    const trimmed = name.trim();
    if (!rootPath || !trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await useProjectsStore.getState().createProject(trimmed, rootPath, color, strategy);
      onClose();
      await router.navigate({ to: "/chat" });
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
        aria-label={t("settings.projects.new")}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="w-full max-w-md rounded-(--radius-lg) border border-border-strong bg-surface-raised p-5 shadow-2xl"
      >
        <h2 className="text-lg font-semibold text-text-primary">{t("settings.projects.new")}</h2>
        <p className="mt-1 text-sm text-text-tertiary">{t("settings.projects.createHint")}</p>

        <div className="mt-4 space-y-4">
          <div>
            <span className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">
              {t("common.folder")}
            </span>
            <div className="mt-1.5 flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                type="button"
                onClick={() => void chooseFolder()}
                disabled={busy || picking}
              >
                <FolderOpen size={14} />
                {t("settings.projects.chooseFolder")}
              </Button>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary">
                {rootPath || t("settings.projects.noFolder")}
              </span>
            </div>
          </div>

          <label className="block">
            <span className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">
              {t("common.name")}
            </span>
            <input
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("settings.projects.namePlaceholder")}
              className="mt-1.5 h-9 w-full rounded-(--radius-sm) border border-border-subtle bg-(--input) px-3 text-sm text-text-primary placeholder:text-text-tertiary focus:border-border-strong focus:outline-none"
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
              name="worktree-strategy"
              label={t("settings.projects.strategyRoot")}
              description={t("settings.projects.strategyRootDesc")}
              checked={strategy === "root"}
              onChange={() => setStrategy("root")}
            />
            <WorkspaceStrategyRadio
              name="worktree-strategy"
              label={t("settings.projects.strategyWorktree")}
              description={t("settings.projects.strategyWorktreeDesc")}
              checked={strategy === "worktree"}
              onChange={() => setStrategy("worktree")}
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" type="button" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            disabled={busy || !rootPath || !name.trim()}
          >
            {t("common.create")}
          </Button>
        </div>
      </form>
    </div>
  );
}
