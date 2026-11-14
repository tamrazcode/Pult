import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function readProjectFile(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), "utf8");
}

describe("Katagami typography assets and configuration", () => {
  it("bundles OFL.txt and all four Katagami variable TTF files with non-zero size", () => {
    const fontFiles = [
      "src/assets/fonts/OFL.txt",
      "src/assets/fonts/KatagamiSans[wght].ttf",
      "src/assets/fonts/KatagamiSans-Italic[wght].ttf",
      "src/assets/fonts/KatagamiMono[wght].ttf",
      "src/assets/fonts/KatagamiMono-Italic[wght].ttf",
    ];

    for (const relPath of fontFiles) {
      const absPath = resolve(ROOT, relPath);
      expect(existsSync(absPath), `${relPath} should exist`).toBe(true);
      expect(statSync(absPath).size, `${relPath} should be > 0 bytes`).toBeGreaterThan(0);
    }
  });

  it("defines Katagami Sans and Katagami Mono in tokens.css without legacy variable fonts", () => {
    const tokensCss = readProjectFile("src/styles/tokens.css");

    expect(tokensCss).toMatch(/--font-family-ui:\s*["']Katagami Sans["']/);
    expect(tokensCss).toMatch(/--font-family-mono:\s*["']Katagami Mono["']/);
    expect(tokensCss).not.toContain("Inter Variable");
    expect(tokensCss).not.toContain("JetBrains Mono Variable");
  });

  it("removes @fontsource-variable/inter and @fontsource-variable/jetbrains-mono from src/main.tsx", () => {
    const mainTsx = readProjectFile("src/main.tsx");

    expect(mainTsx).not.toContain("@fontsource-variable/inter");
    expect(mainTsx).not.toContain("@fontsource-variable/jetbrains-mono");
  });

  it("removes @fontsource-variable/inter and @fontsource-variable/jetbrains-mono from package.json", () => {
    const pkg = JSON.parse(readProjectFile("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

    expect(allDeps).not.toHaveProperty("@fontsource-variable/inter");
    expect(allDeps).not.toHaveProperty("@fontsource-variable/jetbrains-mono");
  });

  it("configures TerminalPane.tsx fontFamily to use Katagami Mono", () => {
    const terminalPane = readProjectFile("src/components/terminal/TerminalPane.tsx");

    expect(terminalPane).toMatch(/fontFamily\s*:\s*["'`][^"'`]*Katagami Mono/);
    expect(terminalPane).not.toContain("JetBrains Mono");
  });

  it("defines @font-face rules for Sans and Mono (normal + italic) with pinned SHA in src/styles/fonts.css", () => {
    const fontsCssPath = resolve(ROOT, "src/styles/fonts.css");
    expect(existsSync(fontsCssPath), "src/styles/fonts.css should exist").toBe(true);

    const fontsCss = readFileSync(fontsCssPath, "utf8");

    // Pinned upstream commit SHA in header comment
    expect(fontsCss).toMatch(/\/\*[\s\S]*?\b[0-9a-f]{7,40}\b[\s\S]*?\*\//i);

    const blocks = fontsCss.match(/@font-face\s*\{[^}]*\}/g) ?? [];
    const expectedFaces = [
      {
        family: "Katagami Sans",
        style: "normal",
        file: "../assets/fonts/KatagamiSans[wght].woff2",
      },
      {
        family: "Katagami Sans",
        style: "italic",
        file: "../assets/fonts/KatagamiSans-Italic[wght].woff2",
      },
      {
        family: "Katagami Mono",
        style: "normal",
        file: "../assets/fonts/KatagamiMono[wght].woff2",
      },
      {
        family: "Katagami Mono",
        style: "italic",
        file: "../assets/fonts/KatagamiMono-Italic[wght].woff2",
      },
    ];

    for (const face of expectedFaces) {
      const match = blocks.some(
        (block) =>
          new RegExp(`font-family\\s*:\\s*["']${face.family}["']`).test(block) &&
          new RegExp(`font-style\\s*:\\s*${face.style}\\b`).test(block) &&
          block.includes(face.file),
      );
      expect(match, `Missing @font-face for ${face.family} (${face.style}) -> ${face.file}`).toBe(
        true,
      );
    }
  });
});
