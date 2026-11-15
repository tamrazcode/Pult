import { createFileRoute } from "@tanstack/react-router";
import { useSettingsStore } from "../stores/settings";

export const Route = createFileRoute("/settings/diffs")({ component: DiffSettings });

function DiffSettings() {
  const diffViewMode = useSettingsStore((s) => s.diffViewMode);
  const setDiffViewMode = useSettingsStore((s) => s.setDiffViewMode);

  return (
    <div className="mx-auto max-w-2xl">
      <h2 className="text-lg font-medium text-text-primary">Diffs & pull requests</h2>
      <p className="mt-1 text-sm text-text-tertiary">
        How changed files open in the right panel. Pull request history stays under Pull requests.
      </p>

      <h3 className="mt-6 text-xs font-semibold tracking-wider text-text-tertiary uppercase">
        Default diff view
      </h3>
      <div role="radiogroup" aria-label="Default diff view" className="mt-2 flex gap-1.5">
        {(
          [
            ["unified", "Unified"],
            ["split", "Split"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={diffViewMode === value}
            onClick={() => setDiffViewMode(value)}
            className={`rounded-(--radius-sm) border px-3 py-1 text-xs transition ${
              diffViewMode === value
                ? "border-accent/50 bg-accent/10 text-text-primary"
                : "border-border-subtle bg-surface text-text-tertiary hover:bg-hover"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="mt-1 text-xs text-text-tertiary">
        Switching the view inside the diff panel also updates this default.
      </p>
    </div>
  );
}
