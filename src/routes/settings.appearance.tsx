import { createFileRoute } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useSettingsStore } from "../stores/settings";
import { ACCENT_STOPS, THEMES } from "../lib/theme";

export const Route = createFileRoute("/settings/appearance")({ component: AppearanceSettings });

/** Theme cards + accent hue picker (§6.6). Every choice applies live. */
function AppearanceSettings() {
  const theme = useSettingsStore((s) => s.theme);
  const accentHue = useSettingsStore((s) => s.accentHue);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setAccentHue = useSettingsStore((s) => s.setAccentHue);

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-lg font-medium text-text-primary">Appearance</h1>
      <p className="mt-1 text-sm text-text-tertiary">
        Themes swap the token palette; the accent recolors buttons, mentions, and monograms.
      </p>

      <h2 className="mt-6 text-xs font-semibold tracking-wider text-text-tertiary uppercase">
        Theme
      </h2>
      <div
        className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4"
        role="radiogroup"
        aria-label="Theme"
      >
        {THEMES.map(({ id, label }) => (
          <button
            key={id}
            role="radio"
            aria-checked={theme === id}
            onClick={() => setTheme(id)}
            className={`rounded-(--radius-md) border p-3 text-left transition ${
              theme === id
                ? "border-accent bg-surface"
                : "border-border-subtle hover:border-border-strong hover:bg-hover"
            }`}
          >
            {/* miniature app window rendered with this theme's own tokens */}
            <span
              data-theme={id}
              aria-hidden
              className={`block h-16 overflow-hidden rounded-(--radius-sm) border border-border-subtle bg-canvas ${
                id === "liquid" ? "glass-surface" : ""
              }`}
              style={
                id === "liquid"
                  ? {
                      backgroundImage:
                        "radial-gradient(circle at 82% 18%, rgba(52,107,241,0.30), transparent 62%)",
                    }
                  : undefined
              }
            >
              <span className={`flex h-full ${id === "liquid" ? "glass-surface" : ""}`}>
                <span className="flex w-9 flex-col gap-1 border-r border-border-subtle bg-panel p-1">
                  <span className="h-1.5 w-5 rounded-full bg-text-secondary/80" />
                  <span className="h-1 w-6 rounded-full bg-text-tertiary/50" />
                  <span className="mt-auto flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-accent" />
                    <span className="h-1 w-3 rounded-full bg-text-tertiary/40" />
                  </span>
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex h-3.5 items-center gap-1 border-b border-border-subtle bg-chrome px-1.5">
                    <span className="h-1 w-7 rounded-full bg-text-tertiary/60" />
                    <span className="ml-auto h-1 w-3 rounded-full bg-text-tertiary/40" />
                  </span>
                  <span className="flex flex-1 flex-col gap-1 p-1.5">
                    <span className="flex items-center gap-1 rounded-[3px] border border-border-subtle bg-surface p-1">
                      <span className="h-1.5 w-1/2 rounded-full bg-text-primary/80" />
                      <span className="ml-auto h-1.5 w-2 rounded-sm bg-surface-raised" />
                    </span>
                    <span className="h-1 w-2/3 rounded-full bg-text-tertiary/60" />
                    <span className="mt-auto flex items-center gap-1">
                      <span className="h-2 w-10 rounded-sm bg-surface-raised" />
                      <span className="h-2 w-4 rounded-sm bg-accent" />
                    </span>
                  </span>
                </span>
              </span>
            </span>
            <span className="mt-2 flex items-center gap-1.5 text-sm text-text-primary">
              {label}
              {theme === id && <Check size={13} className="text-accent" />}
            </span>
          </button>
        ))}
      </div>

      <h2 className="mt-6 text-xs font-semibold tracking-wider text-text-tertiary uppercase">
        Accent
      </h2>
      <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label="Accent color">
        {ACCENT_STOPS.map(({ label, hue }) => (
          <button
            key={label}
            role="radio"
            aria-checked={accentHue === hue}
            title={label}
            onClick={() => setAccentHue(hue)}
            className={`flex h-8 w-8 items-center justify-center rounded-full border-2 transition ${
              accentHue === hue
                ? "border-text-primary"
                : "border-transparent hover:border-border-strong"
            }`}
            style={{
              background:
                hue === null
                  ? "var(--accent)"
                  : `hsl(${hue} 72% ${hue >= 40 && hue <= 100 ? 42 : 57}%)`,
            }}
          >
            {accentHue === hue && (
              <Check size={13} style={{ color: "var(--accent-fg)" }} aria-hidden />
            )}
            {accentHue !== hue && <span className="sr-only">{label}</span>}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-text-tertiary">
        "Stock blue" keeps the theme's built-in accent; every other pick recolors the UI in place
        and survives restarts.
      </p>
    </div>
  );
}
