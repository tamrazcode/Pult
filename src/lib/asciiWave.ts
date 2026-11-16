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

const smoothstep = (edge0: number, edge1: number, value: number) => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * Slow, uneven breathing around a still pointer. Two waves with unrelated
 * speeds never repeat the same ring, so the field feels alive rather than
 * mechanically pulsing.
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
  const wave =
    0.58 +
    0.28 * Math.sin(distance * 0.045 - timeMs * 0.0011) +
    0.14 * Math.sin(distance * 0.09 - timeMs * 0.0017 + 1.7);
  const breathing = 0.78 + 0.22 * Math.sin(timeMs * 0.0007 + 1.3);
  const falloff = Math.exp(-distance / 170);
  return Math.max(0, wave) * breathing * falloff * strength;
}

/** Soft fading spot left behind a moving pointer. */
export function trailValue(
  x: number,
  y: number,
  point: Ripple,
  nowMs: number,
  radius = 52,
): number {
  const age = nowMs - point.startedAt;
  if (age < 0 || age > 900) return 0;
  const dx = x - point.x;
  const dy = y - point.y;
  const limit = radius * 3;
  if (dx * dx + dy * dy > limit * limit) return 0;
  const life = 1 - age / 900;
  return Math.exp(-(dx * dx + dy * dy) / (2 * radius * radius)) * life * point.strength;
}

/**
 * Click bloom: grows in over ~600 ms instead of appearing as a full disk on
 * the first frame, keeps an uneven edge, then fades out over ~2.6 s.
 */
export function pulseValue(x: number, y: number, pulse: Ripple, nowMs: number): number {
  const age = nowMs - pulse.startedAt;
  if (age < 0 || age > 2600) return 0;
  const distance = Math.hypot(x - pulse.x, y - pulse.y);
  const radius = 10 + age * 0.055;
  const width = 26 + age * 0.045;
  if (distance > radius + width * 4) return 0;
  const grow = smoothstep(0, 600, age);
  const life = 1 - smoothstep(1700, 2600, age);
  const band = Math.exp(-((distance - radius) ** 2) / (2 * width ** 2));
  const angle = Math.atan2(y - pulse.y, x - pulse.x);
  const uneven =
    0.82 + 0.18 * Math.sin(angle * 3 + age * 0.0016) * Math.sin(angle * 5 - age * 0.0011);
  return band * grow * life * pulse.strength * uneven * 0.75;
}

/** Effects-only brightness (pointer, trail, click), 0..1. */
export function effectValue(
  x: number,
  y: number,
  nowMs: number,
  pointer: Ripple | null,
  pulses: Ripple[],
  trail: Ripple[] = [],
): number {
  let value = 0;
  if (pointer) value += rippleValue(x, y, pointer.x, pointer.y, nowMs, pointer.strength) * 0.55;
  for (const pulse of pulses) value += pulseValue(x, y, pulse, nowMs) * 0.8;
  for (const point of trail) value += trailValue(x, y, point, nowMs) * 0.35;
  return Math.min(1, value);
}

/** Combined 0..1 brightness for one character cell. */
export function cellBrightness(
  x: number,
  y: number,
  nowMs: number,
  pointer: Ripple | null,
  pulses: Ripple[],
  trail: Ripple[] = [],
): number {
  const base = 0.2 + ambientValue(x, y, nowMs) * 0.3;
  return Math.min(1, base + effectValue(x, y, nowMs, pointer, pulses, trail));
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
