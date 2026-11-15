import { describe, expect, it } from "vitest";
import { cellBrightness, cellGlyph, pulseValue, rippleValue } from "../src/lib/asciiWave";

describe("asciiWave", () => {
  it("makes cellBrightness at a ripple crest brighter than a far point", () => {
    const pointer = { x: 100, y: 100, startedAt: 0, strength: 1 };
    const crestDistance = Math.PI / (2 * 0.085);
    const crestBrightness = cellBrightness(100 + crestDistance, 100, 0, pointer, []);
    const farBrightness = cellBrightness(2000, 2000, 0, pointer, []);

    expect(crestBrightness).toBeGreaterThan(farBrightness);
  });

  it("falls off rippleValue with distance", () => {
    const nearCrestDist = Math.PI / (2 * 0.085);
    const farCrestDist = nearCrestDist + (6 * Math.PI) / 0.085;

    const nearValue = rippleValue(nearCrestDist, 0, 0, 0, 0, 1);
    const farValue = rippleValue(farCrestDist, 0, 0, 0, 0, 1);

    expect(nearValue).toBeGreaterThan(farValue);
    expect(farValue).toBeGreaterThan(0);
  });

  it("decays pulseValue to 0 after 1400ms", () => {
    const pulse = { x: 50, y: 50, startedAt: 1000, strength: 1 };

    const active = pulseValue(50 + 84, 50, pulse, 1200);
    expect(active).toBeGreaterThan(0);

    expect(pulseValue(50 + 348, 50, pulse, 2400)).toBe(0);
    expect(pulseValue(50 + 350, 50, pulse, 2401)).toBe(0);
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
