import { createFileRoute } from "@tanstack/react-router";
import { useSettingsStore } from "../stores/settings";
import { useT } from "../lib/i18n";

export const Route = createFileRoute("/settings/diffs")({ component: DiffSettings });

function DiffSettings() {
  const t = useT();
  const diffViewMode = useSettingsStore((s) => s.diffViewMode);
  const setDiffViewMode = useSettingsStore((s) => s.setDiffViewMode);
  const modes = [
    ["unified", t("settings.diffs.unified")],
    ["split", t("settings.diffs.split")],
  ] as const;

  return (
    <div className="mx-auto max-w-2xl">
      <h2 className="text-lg font-medium text-text-primary">{t("settings.diffs.title")}</h2>
      <p className="mt-1 text-sm text-text-tertiary">{t("settings.diffs.subtitle")}</p>

      <h3 className="mt-6 text-xs font-semibold tracking-wider text-text-tertiary uppercase">
        {t("settings.diffs.defaultView")}
      </h3>
      <div
        role="radiogroup"
        aria-label={t("settings.diffs.defaultView")}
        className="mt-2 flex gap-1.5"
      >
        {modes.map(([value, label]) => (
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
      <p className="mt-1 text-xs text-text-tertiary">{t("settings.diffs.hint")}</p>
    </div>
  );
}
