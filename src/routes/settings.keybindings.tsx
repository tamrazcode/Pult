import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { RotateCcw } from "lucide-react";
import { useSettingsStore } from "../stores/settings";
import { DEFAULT_BINDINGS, eventToBinding, formatBindingParts, MOD_KEY } from "../lib/hotkeys";
import { Kbd } from "../components/ui/kbd";
import { useT } from "../lib/i18n";

export const Route = createFileRoute("/settings/keybindings")({ component: KeybindingsSettings });

const BINDING_LABEL_KEYS: Record<string, string> = {
  "settings.open": "common.commands.openSettings",
  "palette.open": "common.commands.openPalette",
  "chat.new": "common.commands.newThread",
  "view.sidebar": "common.commands.toggleSidebar",
  "view.panel.diff": "common.commands.showDiffPanel",
  "view.panel.terminal": "common.commands.showTerminalPanel",
  "view.panel.browser": "common.commands.showBrowserPanel",
  "view.panel.files": "common.commands.showFilesPanel",
};

/**
 * Rebindable keyboard shortcuts (§6.7). Click a row, press the new combo,
 * Esc cancels; overrides persist with the rest of §4.5 settings.
 */
function KeybindingsSettings() {
  const t = useT();
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

  const rows = Object.keys(BINDING_LABEL_KEYS);
  const label = (id: string) => t(BINDING_LABEL_KEYS[id] ?? id);

  return (
    <div className="mx-auto max-w-2xl">
      <h2 className="text-lg font-medium text-text-primary">{t("settings.keybindings.title")}</h2>
      <p className="mt-1 text-sm text-text-tertiary">
        {t("settings.keybindings.subtitle", { mod: MOD_KEY })}
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
              <p className="min-w-0 flex-1 truncate text-sm text-text-primary">{label(id)}</p>
              {overridden && (
                <span className="text-xs text-text-tertiary">
                  {t("settings.keybindings.custom")}
                </span>
              )}
              <button
                onClick={() => setCapturing(id)}
                aria-label={t("settings.keybindings.rebind", { name: label(id) })}
                className="flex min-w-[92px] items-center justify-center gap-1 rounded-(--radius-sm) border border-border-subtle px-2 py-1 font-mono text-xs text-text-secondary transition hover:bg-hover"
              >
                {capturing === id
                  ? t("settings.keybindings.pressKeys")
                  : formatBindingParts(current).map((part, index) => (
                      <span key={`${part}-${index}`} className="inline-flex items-center gap-1">
                        {index > 0 && (
                          <span aria-hidden className="text-text-tertiary">
                            +
                          </span>
                        )}
                        <Kbd>{part}</Kbd>
                      </span>
                    ))}
              </button>
              {overridden && (
                <button
                  onClick={() => {
                    setKeybinding(id, DEFAULT_BINDINGS[id]);
                    setCapturing(null);
                  }}
                  aria-label={t("settings.keybindings.reset", { name: label(id) })}
                  className="text-text-tertiary transition hover:text-text-secondary"
                  title={t("settings.keybindings.resetTitle")}
                >
                  <RotateCcw size={13} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-4 text-xs text-text-tertiary">{t("settings.keybindings.fixedHint")}</p>
    </div>
  );
}
