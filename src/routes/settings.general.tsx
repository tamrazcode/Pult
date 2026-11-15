import { createFileRoute } from "@tanstack/react-router";
import { useSettingsStore } from "../stores/settings";

export const Route = createFileRoute("/settings/general")({ component: GeneralSettings });

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-text-primary">{label}</p>
        <p className="mt-0.5 text-xs text-text-tertiary">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full border transition ${
          checked ? "border-accent bg-accent" : "border-border-strong bg-surface"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-all ${
            checked ? "left-[18px]" : "left-0.5"
          }`}
        />
      </button>
    </div>
  );
}

function GeneralSettings() {
  const confirmDeleteThread = useSettingsStore((s) => s.confirmDeleteThread);
  const setConfirmDeleteThread = useSettingsStore((s) => s.setConfirmDeleteThread);

  return (
    <div className="mx-auto max-w-2xl">
      <h2 className="text-lg font-medium text-text-primary">General</h2>
      <p className="mt-1 text-sm text-text-tertiary">Everyday behaviour of the app.</p>
      <div className="mt-4 divide-y divide-border-subtle border-y border-border-subtle">
        <Toggle
          label="Confirm before deleting threads"
          description="Ask before a transcript and its worktree are removed."
          checked={confirmDeleteThread}
          onChange={setConfirmDeleteThread}
        />
      </div>
    </div>
  );
}
