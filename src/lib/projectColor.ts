/** Dark monogram tile: same hue as the project swatch, bright initials. */
export interface ProjectMonogram {
  background: string;
  color: string;
  border: string;
}

/** "manimaDocs" -> "MA"; "pult" -> "PU"; falls back to the first char. */
export function projectInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length >= 2
      ? words[0][0] + words[1][0]
      : (words[0] ?? "?").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2);
  return (letters || "?").toUpperCase();
}

/** Pick a palette entry; `random` is injectable so creation is testable. */
export function pickProjectColor(
  palette: readonly string[],
  random: () => number = Math.random,
): string {
  if (palette.length === 0) return "#346bf1";
  return palette[Math.min(palette.length - 1, Math.floor(random() * palette.length))];
}

/**
 * T3-style project tile: a dark tint of the project hue with bright initials in
 * the same hue. Projects without a stored swatch fall back to the accent blue.
 */
export function projectMonogram(color: string | null | undefined): ProjectMonogram {
  const base = color ?? "#346bf1";
  return {
    background: `color-mix(in oklab, ${base} 22%, #0b0b0d)`,
    color: base,
    border: `color-mix(in oklab, ${base} 30%, transparent)`,
  };
}
