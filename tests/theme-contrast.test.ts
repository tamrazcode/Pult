import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { relativeLuminance } from "../src/lib/theme";

/** WCAG 2.x contrast ratio between two opaque hex colors. */
function contrast(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

type Tokens = Record<string, string>;

/** Parses the `--x: value` pairs of the first `:root` or `[data-theme="..."]` block. */
function parseTokens(css: string): Tokens {
  const rootMatch = css.match(/(?::root(?:\[[^\]]*\])?|\[data-theme="[^"]+"\])[^{]*\{([^}]*)\}/);
  const body = rootMatch?.[1] ?? "";
  const tokens: Tokens = {};
  for (const [, name, value] of body.matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)) {
    tokens[name] = value.trim();
  }
  return tokens;
}

const ROOT = join(import.meta.dirname ?? ".", "..");
const DARK = parseTokens(readFileSync(join(ROOT, "src/styles/tokens.css"), "utf8"));
const LIGHT = parseTokens(readFileSync(join(ROOT, "src/styles/themes/light.css"), "utf8"));
const GRAPHITE = parseTokens(readFileSync(join(ROOT, "src/styles/themes/graphite.css"), "utf8"));

const THEMES: [string, Tokens][] = [
  ["dark", DARK],
  ["light", LIGHT],
  ["graphite", GRAPHITE],
];

describe("theme contrast (§6.6: all text ≥ 4.5:1)", () => {
  for (const [name, tokens] of THEMES) {
    it(`${name}: text tokens read ≥ 4.5:1 on canvas and surface`, () => {
      for (const text of ["--text-primary", "--text-secondary", "--text-tertiary"]) {
        for (const bg of ["--canvas", "--panel-bg", "--surface", "--surface-raised", "--chrome"]) {
          expect(tokens[text], `${name} missing ${text}`).toBeTruthy();
          expect(tokens[bg], `${name} missing ${bg}`).toBeTruthy();
          const ratio = contrast(tokens[text], tokens[bg]);
          expect(ratio, `${name} ${text} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`${name}: accent foreground reads ≥ 4.5:1 on the accent`, () => {
      expect(tokens["--accent-fg"], `${name} missing --accent-fg`).toBeTruthy();
      expect(tokens["--accent"], `${name} missing --accent`).toBeTruthy();
      expect(contrast(tokens["--accent-fg"], tokens["--accent"])).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: diff foregrounds read ≥ 4.5:1 on canvas`, () => {
      expect(tokens["--diff-add-fg"], `${name} missing --diff-add-fg`).toBeTruthy();
      expect(tokens["--diff-del-fg"], `${name} missing --diff-del-fg`).toBeTruthy();
      expect(tokens["--canvas"], `${name} missing --canvas`).toBeTruthy();
      expect(contrast(tokens["--diff-add-fg"], tokens["--canvas"])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokens["--diff-del-fg"], tokens["--canvas"])).toBeGreaterThanOrEqual(4.5);
    });
  }

  for (const [name, tokens] of [
    ["dark", DARK],
    ["graphite", GRAPHITE],
  ] as const) {
    it(`${name}: --panel-bg has higher relative luminance than --canvas`, () => {
      expect(tokens["--panel-bg"], `${name} missing --panel-bg`).toBeTruthy();
      expect(tokens["--canvas"], `${name} missing --canvas`).toBeTruthy();
      expect(relativeLuminance(tokens["--panel-bg"])).toBeGreaterThan(
        relativeLuminance(tokens["--canvas"]),
      );
    });
  }

  it("every theme only overrides tokens that exist (no typo'd names)", () => {
    const darkKeys = new Set(Object.keys(DARK));
    for (const [name, tokens] of THEMES.slice(1)) {
      const unknown = Object.keys(tokens).filter((k) => !darkKeys.has(k));
      expect(unknown, name).toEqual([]);
    }
  });

  it("scopes every theme selector with [data-theme=...] (not :root[...]) for nested preview cards", () => {
    const themeFiles: Array<[string, string]> = [
      ["dark", "src/styles/tokens.css"],
      ["light", "src/styles/themes/light.css"],
      ["graphite", "src/styles/themes/graphite.css"],
    ];

    for (const [id, relPath] of themeFiles) {
      const css = readFileSync(join(ROOT, relPath), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(css, `${relPath} must not scope with :root[data-theme=...]`).not.toMatch(
        /:root\[data-theme=/,
      );
      expect(css, `${relPath} must define [data-theme="${id}"]`).toMatch(
        new RegExp(`(?:^|[\\s,{])\\[data-theme="${id}"\\]`),
      );
      if (id === "dark") {
        expect(css, `${relPath} should keep :root alongside [data-theme="dark"]`).toMatch(
          /(?:^|[\s,}]):root\b/,
        );
      }
    }
  });

  it("defines corner radius tokens at or above minimum pixel sizes", () => {
    const mins: Array<[string, number]> = [
      ["--radius-sm", 8],
      ["--radius-md", 12],
      ["--radius-lg", 18],
    ];
    for (const [token, minPx] of mins) {
      const raw = DARK[token];
      expect(raw, `tokens.css missing ${token}`).toBeTruthy();
      const match = /^(\d+(?:\.\d+)?)px$/.exec(raw);
      expect(match, `${token} should be in px, got ${raw}`).not.toBeNull();
      expect(Number(match![1])).toBeGreaterThanOrEqual(minPx);
    }
  });
});
