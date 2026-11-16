import type { ThemeName } from "../stores/settings";
import type { TranslationKey } from "./i18n";

/** Valid themes, in picker order (§6.6). */
export const THEMES: { id: ThemeName; labelKey: TranslationKey }[] = [
  { id: "dark", labelKey: "settings.appearance.theme.dark" },
  { id: "light", labelKey: "settings.appearance.theme.light" },
  { id: "graphite", labelKey: "settings.appearance.theme.graphite" },
];

/** Accent presets (hue values for `hsl(h s% l%)`) plus the "stock" reset. */
export const ACCENT_STOPS: { labelKey: TranslationKey; hue: number | null }[] = [
  { labelKey: "settings.appearance.accent.stock", hue: null },
  { labelKey: "settings.appearance.accent.cyan", hue: 190 },
  { labelKey: "settings.appearance.accent.green", hue: 150 },
  { labelKey: "settings.appearance.accent.lime", hue: 90 },
  { labelKey: "settings.appearance.accent.yellow", hue: 45 },
  { labelKey: "settings.appearance.accent.orange", hue: 25 },
  { labelKey: "settings.appearance.accent.red", hue: 355 },
  { labelKey: "settings.appearance.accent.pink", hue: 320 },
  { labelKey: "settings.appearance.accent.purple", hue: 270 },
  { labelKey: "settings.appearance.accent.indigo", hue: 235 },
];

/** Relative luminance (WCAG 2.x) of an sRGB hex color, 0..1. */
export function relativeLuminance(hex: string): number {
  const raw = hex.replace("#", "");
  const value =
    raw.length === 3
      ? raw
          .split("")
          .map((c) => c + c)
          .join("")
      : raw;
  const channel = (i: number) => {
    const c = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/**
 * HSL(h, s%, l%) → relative luminance, via sRGB conversion. Used to pick an
 * accent foreground that keeps ≥ 4.5:1 on every accent hue (§6.6).
 */
export function hslLuminance(h: number, s: number, l: number): number {
  const rgb = hslToHex(h, s, l);
  return relativeLuminance(rgb);
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const to255 = (v: number) =>
    Math.round(255 * v)
      .toString(16)
      .padStart(2, "0");
  return `#${to255(f(0))}${to255(f(8))}${to255(f(4))}`;
}

/**
 * Applies the theme + accent to the document: themes swap the token block via
 * `data-theme`, the accent hue regenerates accent/mention/monogram tokens via
 * HSL (§6.6). `hue === null` restores the theme's stock accent.
 */
export function applyTheme(theme: ThemeName, hue: number | null): void {
  const root = document.documentElement;
  if (theme === "dark") delete root.dataset.theme;
  else root.dataset.theme = theme;
  if (hue === null) {
    for (const prop of [
      "--accent",
      "--accent-hover",
      "--mention-bg",
      "--monogram-bg",
      "--monogram-fg",
    ]) {
      root.style.removeProperty(prop);
    }
    return;
  }
  // Accent lightness stays mid so white text keeps ≥ 4.5:1 on most hues;
  // bright hues (yellow/lime) flip the foreground to the canvas ink instead.
  const lightness = hue >= 40 && hue <= 100 ? 42 : 57;
  const accent = `hsl(${hue} 72% ${lightness}%)`;
  const hover = `hsl(${hue} 72% ${Math.max(lightness - 6, 20)}%)`;
  const fg = hslLuminance(hue, 72, lightness) > 0.35 ? "var(--canvas)" : "#ffffff";
  root.style.setProperty("--accent", accent);
  root.style.setProperty("--accent-hover", hover);
  root.style.setProperty("--mention-bg", `color-mix(in oklab, ${accent} 16%, transparent)`);
  root.style.setProperty("--monogram-bg", `color-mix(in oklab, ${accent} 28%, var(--canvas))`);
  root.style.setProperty("--monogram-fg", fg);
}
