import { describe, expect, it } from "vitest";
import { pickProjectColor, projectInitials, projectMonogram } from "../src/lib/projectColor";

describe("projectColor", () => {
  it("extracts two-character uppercase initials", () => {
    expect(projectInitials("manimaDocs")).toBe("MA");
    expect(projectInitials("pult")).toBe("PU");
    expect(projectInitials("  my  cool app ")).toBe("MC");
    expect(projectInitials("")).toBe("?");
  });

  it("builds a tinted monogram style from the project color", () => {
    const monogram = projectMonogram("#10b981");
    expect(monogram.color).toBe("#10b981");
    expect(monogram.background).toContain("color-mix");
    expect(monogram.background).toContain("22%");

    const fallback = projectMonogram(null);
    expect(fallback.color).toBeTruthy();
    expect(fallback.background).toContain("color-mix");
  });

  it("picks a deterministic project color from a palette", () => {
    expect(pickProjectColor(["#a", "#b", "#c"], () => 0.5)).toBe("#b");
    expect(pickProjectColor(["#a", "#b", "#c"], () => 0)).toBe("#a");
    expect(pickProjectColor(["#a", "#b", "#c"], () => 0.99)).toBe("#c");
    expect(pickProjectColor(["#only"])).toBe("#only");
  });
});
