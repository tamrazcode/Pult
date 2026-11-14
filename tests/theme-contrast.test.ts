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

/** Parses the `--x: value` pairs of the first `:root[...] { }` block. */
function parseTokens(css: string): Tokens {
  const body = css.slice(css.indexOf("{"), css.lastIndexOf("}"));
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
        for (const bg of ["--canvas", "--surface", "--surface-raised", "--chrome"]) {
          const ratio = contrast(tokens[text], tokens[bg]);
          expect(ratio, `${name} ${text} on ${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    });

    it(`${name}: accent foreground reads ≥ 4.5:1 on the accent`, () => {
      expect(contrast(tokens["--accent-fg"], tokens["--accent"])).toBeGreaterThanOrEqual(4.5);
    });

    it(`${name}: diff foregrounds read ≥ 4.5:1 on canvas`, () => {
      expect(contrast(tokens["--diff-add-fg"], tokens["--canvas"])).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokens["--diff-del-fg"], tokens["--canvas"])).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("every theme only overrides tokens that exist (no typo'd names)", () => {
    const darkKeys = new Set(Object.keys(DARK));
    for (const [name, tokens] of THEMES.slice(1)) {
      const unknown = Object.keys(tokens).filter((k) => !darkKeys.has(k));
      expect(unknown, name).toEqual([]);
    }
  });
});
