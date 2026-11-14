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
      <div className="mt-2 grid grid-cols-3 gap-2" role="radiogroup" aria-label="Theme">
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
            {/* mini preview: canvas/chrome/surface/accent swatches */}
            <span
              className="flex h-10 items-end gap-1 rounded-(--radius-sm) p-1.5"
              style={{ background: "var(--canvas)" }}
            >
              <Swatch var="--chrome" />
              <Swatch var="--surface" />
              <Swatch var="--surface-raised" />
              <Swatch var="--accent" />
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

function Swatch({ var: name }: { var: string }) {
  return (
    <span
      className="h-6 flex-1 rounded-[4px] border border-border-subtle"
      style={{ background: `var(${name})` }}
      aria-hidden
    />
  );
}
