import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { RotateCcw } from "lucide-react";
import { useSettingsStore } from "../stores/settings";
import { DEFAULT_BINDINGS, eventToBinding, formatBinding, MOD_KEY } from "../lib/hotkeys";

export const Route = createFileRoute("/settings/keybindings")({ component: KeybindingsSettings });

const BINDING_LABELS: Record<string, string> = {
  "settings.open": "Open settings",
  "palette.open": "Open command palette",
  "chat.new": "New thread",
  "view.sidebar": "Toggle sidebar",
  "view.panel.diff": "Show diff panel",
  "view.panel.terminal": "Show terminal panel",
};

/**
 * Rebindable keyboard shortcuts (§6.7). Click a row, press the new combo,
 * Esc cancels; overrides persist with the rest of §4.5 settings.
 */
function KeybindingsSettings() {
  const keybindings = useSettingsStore((s) => s.keybindings);
  const setKeybinding = useSettingsStore((s) => s.setKeybinding);
  const [capturing, setCapturing] = useState<string | null>(null);

  useEffect(() => {
    if (!capturing) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      // Pressing a modifier fires its own keydown ("Control", "Shift", …) —
      // wait for the real key riding on the modifiers instead.
      if (e.key === "Control" || e.key === "Shift" || e.key === "Alt" || e.key === "Meta") {
        return;
      }
      const binding = eventToBinding(e);
      // A bare key with no modifiers would hijack typing — require Mod/Alt.
      if (!binding.startsWith("Mod+") && !binding.startsWith("Alt+")) return;
      setKeybinding(capturing, binding);
      setCapturing(null);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [capturing, setKeybinding]);

  const rows = Object.keys(BINDING_LABELS);

  return (
    <div className="mx-auto max-w-2xl">
      <h2 className="text-lg font-medium text-text-primary">Keybindings</h2>
      <p className="mt-1 text-sm text-text-tertiary">
        Press a row, then the new combination (needs {MOD_KEY} or Alt so typing stays safe). Esc
        cancels.
      </p>

      <div className="mt-4 overflow-hidden rounded-(--radius-md) border border-border-subtle">
        {rows.map((id) => {
          const current = keybindings[id] ?? DEFAULT_BINDINGS[id];
          const overridden =
            keybindings[id] !== undefined && keybindings[id] !== DEFAULT_BINDINGS[id];
          return (
            <div
              key={id}
              className={`flex items-center gap-3 border-b border-border-subtle px-3.5 py-2.5 last:border-b-0 ${
                capturing === id ? "bg-active" : ""
              }`}
            >
              <p className="min-w-0 flex-1 truncate text-sm text-text-primary">
                {BINDING_LABELS[id]}
              </p>
              {overridden && <span className="text-xs text-text-tertiary">custom</span>}
              <button
                onClick={() => setCapturing(id)}
                aria-label={`Rebind ${BINDING_LABELS[id]}`}
                className="min-w-[92px] rounded-(--radius-sm) border border-border-subtle px-2 py-1 font-mono text-xs text-text-secondary transition hover:bg-hover"
              >
                {capturing === id ? "Press keys…" : formatBinding(current)}
              </button>
              {overridden && (
                <button
                  onClick={() => {
                    setKeybinding(id, DEFAULT_BINDINGS[id]);
                    setCapturing(null);
                  }}
                  aria-label={`Reset ${BINDING_LABELS[id]} to default`}
                  className="text-text-tertiary transition hover:text-text-secondary"
                  title="Reset to default"
                >
                  <RotateCcw size={13} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-4 text-xs text-text-tertiary">
        Composer keys are fixed by design: Enter sends (Shift+Enter adds a newline), Esc stops the
        run, A/S/D answer an approval.
      </p>
    </div>
  );
}
