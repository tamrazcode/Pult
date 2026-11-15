/** Deterministic ASCII field + pointer ripples (pure math, testable). */

export interface Ripple {
  x: number;
  y: number;
  startedAt: number;
  strength: number;
}

/** Slow ambient drift of the resting field, roughly 0..1. */
export function ambientValue(x: number, y: number, timeMs: number): number {
  const t = timeMs / 1000;
  const wave = Math.sin(x * 0.11 + y * 0.17 + t * 0.35) + Math.cos(x * 0.07 - y * 0.23 + t * 0.22);
  return (wave + 2) / 4;
}

/**
 * Ring around a point: brightest at the moving crest, fading with distance.
 * `timeMs` drives the outward motion so a still pointer still pulses.
 */
export function rippleValue(
  x: number,
  y: number,
  cx: number,
  cy: number,
  timeMs: number,
  strength: number,
): number {
  const distance = Math.hypot(x - cx, y - cy);
  const crest = 0.5 + 0.5 * Math.sin(distance * 0.085 - timeMs * 0.006);
  const falloff = Math.exp(-distance / 190);
  return crest * falloff * strength;
}

/** Click pulses expand and decay over ~1.4 s. */
export function pulseValue(x: number, y: number, pulse: Ripple, nowMs: number): number {
  const age = nowMs - pulse.startedAt;
  if (age < 0 || age > 1400) return 0;
  const life = 1 - age / 1400;
  const distance = Math.hypot(x - pulse.x, y - pulse.y);
  const radius = 40 + age * 0.22;
  const band = Math.exp(-((distance - radius) ** 2) / (2 * 90 ** 2));
  return band * life * pulse.strength;
}

/** Combined 0..1 brightness for one character cell. */
export function cellBrightness(
  x: number,
  y: number,
  nowMs: number,
  pointer: Ripple | null,
  pulses: Ripple[],
): number {
  let value = 0.2 + ambientValue(x, y, nowMs) * 0.3;
  if (pointer) value += rippleValue(x, y, pointer.x, pointer.y, nowMs, pointer.strength) * 0.55;
  for (const pulse of pulses) value += pulseValue(x, y, pulse, nowMs) * 0.8;
  return Math.min(1, value);
}

/** Character for a cell: sparse noise, denser where the field is bright. */
export function cellGlyph(x: number, y: number, brightness: number): string {
  const noise = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  const pick = Math.abs(noise - Math.floor(noise));
  if (brightness > 0.62) return pick > 0.5 ? "+" : "*";
  if (brightness > 0.46) return pick > 0.5 ? "·" : "⋅";
  if (brightness > 0.3) return pick > 0.4 ? "." : "·";
  return pick > 0.7 ? "." : " ";
}
