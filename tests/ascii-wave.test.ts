import { describe, expect, it } from "vitest";
import {
  ambientValue,
  cellBrightness,
  cellGlyph,
  effectValue,
  pulseValue,
  rippleValue,
  trailValue,
} from "../src/lib/asciiWave";

describe("asciiWave", () => {
  it("makes cellBrightness at a ripple crest brighter than a far point", () => {
    const pointer = { x: 100, y: 100, startedAt: 0, strength: 1 };
    const crestDistance = 35;
    const crestBrightness = cellBrightness(100 + crestDistance, 100, 0, pointer, []);
    const farBrightness = cellBrightness(2000, 2000, 0, pointer, []);

    expect(crestBrightness).toBeGreaterThan(farBrightness);
  });

  it("falls off rippleValue with distance", () => {
    const near = rippleValue(20, 0, 0, 0, 0, 1);
    const far = rippleValue(900, 0, 0, 0, 0, 1);

    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThanOrEqual(0);
  });

  it("keeps the still-pointer pulse slow: a short interval changes it only slightly", () => {
    const a = rippleValue(40, 20, 0, 0, 1_000, 1);
    const b = rippleValue(40, 20, 0, 0, 1_200, 1);
    const c = rippleValue(40, 20, 0, 0, 3_000, 1);

    expect(Math.abs(a - b)).toBeLessThan(Math.abs(a - c) + 0.05);
  });

  it("blooms a click gradually instead of drawing an instant disk", () => {
    const pulse = { x: 50, y: 50, startedAt: 1000, strength: 1 };

    expect(pulseValue(50, 50, pulse, 1000)).toBe(0);
    expect(pulseValue(50, 50, pulse, 1600)).toBeGreaterThan(0);
    expect(pulseValue(50, 50, pulse, 3601)).toBe(0);
  });

  it("fades a pointer trail spot with age and distance", () => {
    const point = { x: 50, y: 50, startedAt: 1000, strength: 1 };

    expect(trailValue(50, 50, point, 1000)).toBeGreaterThan(0);
    expect(trailValue(50, 50, point, 1800)).toBeLessThan(trailValue(50, 50, point, 1200));
    expect(trailValue(50, 50, point, 1900)).toBe(0);
    expect(trailValue(500, 500, point, 1000)).toBe(0);
  });

  it("lifts cellBrightness where the trail passes", () => {
    const point = { x: 100, y: 100, startedAt: 0, strength: 1 };
    const lit = cellBrightness(100, 100, 0, null, [], [point]);
    const plain = cellBrightness(100, 100, 0, null, [], []);

    expect(lit).toBeGreaterThan(plain);
  });

  it("separates effectValue from ambient base brightness and keeps idle effectValue at zero", () => {
    for (let x = 0; x <= 300; x += 75) {
      for (let y = 0; y <= 300; y += 75) {
        const effect = effectValue(x, y, 5000, null, [], []);
        const base = 0.2 + ambientValue(x, y, 5000) * 0.3;
        const total = cellBrightness(x, y, 5000, null, [], []);
        expect(effect).toBe(0);
        expect(base).toBeGreaterThanOrEqual(0.2);
        expect(base).toBeLessThanOrEqual(0.5);
        expect(total).toBeCloseTo(base, 10);
      }
    }
  });

  it("combines pointer, pulse, and trail in effectValue independently of ambient and clamps to 1", () => {
    const pointer = { x: 100, y: 100, startedAt: 0, strength: 0.9 };
    const pulse = { x: 100, y: 100, startedAt: 0, strength: 0.9 };
    const trail = [{ x: 100, y: 100, startedAt: 500, strength: 0.8 }];

    const onlyPointer = effectValue(100, 100, 600, pointer, [], []);
    const onlyPulse = effectValue(100, 100, 600, null, [pulse], []);
    const onlyTrail = effectValue(100, 100, 600, null, [], trail);
    const combined = effectValue(100, 100, 600, pointer, [pulse], trail);

    expect(onlyPointer).toBeCloseTo(rippleValue(100, 100, 100, 100, 600, 0.9) * 0.55, 10);
    expect(onlyPulse).toBeCloseTo(pulseValue(100, 100, pulse, 600) * 0.8, 10);
    expect(onlyTrail).toBeCloseTo(trailValue(100, 100, trail[0]!, 600) * 0.35, 10);
    expect(combined).toBeCloseTo(Math.min(1, onlyPointer + onlyPulse + onlyTrail), 10);

    // Extremely strong stacked pulses still clamp effectValue and cellBrightness to 1.
    const overloaded = Array.from({ length: 6 }, () => ({
      x: 100,
      y: 100,
      startedAt: 0,
      strength: 2,
    }));
    expect(effectValue(100, 100, 600, pointer, overloaded, trail)).toBe(1);
    expect(cellBrightness(100, 100, 600, pointer, overloaded, trail)).toBe(1);

    // Far from active effects, effectValue drops to ~0 while ambient cellBrightness remains >= 0.2.
    expect(effectValue(5000, 5000, 600, pointer, [pulse], trail)).toBeLessThan(1e-6);
    expect(cellBrightness(5000, 5000, 600, pointer, [pulse], trail)).toBeGreaterThanOrEqual(0.2);
  });

  it("returns a space for dim cells and a non-space glyph for bright cells", () => {
    // At (0, 0), deterministic noise pick is 0 <= 0.55, so dim cells yield " ".
    expect(cellGlyph(0, 0, 0.1)).toBe(" ");
    expect(cellGlyph(0, 0, 0.5)).not.toBe(" ");
    expect(cellGlyph(0, 0, 0.8)).not.toBe(" ");

    for (let x = 0; x < 10; x += 1) {
      for (let y = 0; y < 10; y += 1) {
        expect(cellGlyph(x, y, 0.5)).not.toBe(" ");
        expect(cellGlyph(x, y, 0.8)).not.toBe(" ");
      }
    }
  });
});
