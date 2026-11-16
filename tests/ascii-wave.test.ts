import { describe, expect, it } from "vitest";
import {
  cellBrightness,
  cellGlyph,
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
