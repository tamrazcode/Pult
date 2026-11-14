import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
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
  const rootMatch = css.match(/:root(?:\[[^\]]*\])?\s*\{([^}]*)\}/);
  const body = rootMatch?.[1] ?? "";
  const tokens: Tokens = {};
  for (const [, name, value] of body.matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)) {
    tokens[name] = value.trim();
  }
  return tokens;
}

function readOptionalCss(relativePath: string): string {
  const fullPath = join(ROOT, relativePath);
  return existsSync(fullPath) ? readFileSync(fullPath, "utf8") : "";
}

function inspectGlassCss(css: string) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const stack: string[] = [];
  let buf = "";
  let supportsBackdropCount = 0;
  let reducedTransparencyCount = 0;
  let wrappedBackdropDecls = 0;
  let unwrappedBackdropDecls = 0;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === "{") {
      const header = buf.trim();
      stack.push(header);
      if (/^@supports\b/i.test(header) && /backdrop-filter/i.test(header)) {
        supportsBackdropCount++;
      }
      if (/^@media\b/i.test(header) && /prefers-reduced-transparency/i.test(header)) {
        reducedTransparencyCount++;
      }
      buf = "";
    } else if (ch === ";" || ch === "}") {
      const decl = buf.trim();
      if (/^(?:-webkit-)?backdrop-filter\s*:/i.test(decl)) {
        const inSupports = stack.some((h) => /^@supports\b/i.test(h) && /backdrop-filter/i.test(h));
        const inReduced = stack.some(
          (h) => /^@media\b/i.test(h) && /prefers-reduced-transparency/i.test(h),
        );
        if (inSupports || inReduced) {
          wrappedBackdropDecls++;
        } else {
          unwrappedBackdropDecls++;
        }
      }
      if (ch === "}") stack.pop();
      buf = "";
    } else {
      buf += ch;
    }
  }

  return {
    supportsBackdropCount,
    reducedTransparencyCount,
    wrappedBackdropDecls,
    unwrappedBackdropDecls,
  };
}

const ROOT = join(import.meta.dirname ?? ".", "..");
const DARK = parseTokens(readFileSync(join(ROOT, "src/styles/tokens.css"), "utf8"));
const LIGHT = parseTokens(readFileSync(join(ROOT, "src/styles/themes/light.css"), "utf8"));
const GRAPHITE = parseTokens(readFileSync(join(ROOT, "src/styles/themes/graphite.css"), "utf8"));
const LIQUID_CSS = readOptionalCss("src/styles/themes/liquid.css");
const LIQUID = parseTokens(LIQUID_CSS);

const THEMES: [string, Tokens][] = [
  ["dark", DARK],
  ["light", LIGHT],
  ["graphite", GRAPHITE],
  ["liquid", LIQUID],
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
    ["liquid", LIQUID],
  ] as const) {
    it(`${name}: --panel-bg has higher relative luminance than --canvas`, () => {
      expect(tokens["--panel-bg"], `${name} missing --panel-bg`).toBeTruthy();
      expect(tokens["--canvas"], `${name} missing --canvas`).toBeTruthy();
      expect(relativeLuminance(tokens["--panel-bg"])).toBeGreaterThan(
        relativeLuminance(tokens["--canvas"]),
      );
    });
  }

  it("liquid: defines glass tokens and wraps backdrop-filter in @supports + prefers-reduced-transparency", () => {
    expect(LIQUID_CSS, "src/styles/themes/liquid.css must exist").not.toBe("");
    for (const token of ["--glass-blur", "--glass-border", "--glass-panel"]) {
      expect(LIQUID[token], `liquid missing ${token}`).toBeTruthy();
    }
    const glass = inspectGlassCss(LIQUID_CSS);
    expect(glass.supportsBackdropCount).toBeGreaterThan(0);
    expect(glass.reducedTransparencyCount).toBeGreaterThan(0);
    expect(glass.wrappedBackdropDecls).toBeGreaterThan(0);
    expect(glass.unwrappedBackdropDecls).toBe(0);
  });

  it("every theme only overrides tokens that exist (no typo'd names)", () => {
    const darkKeys = new Set(Object.keys(DARK));
    for (const [name, tokens] of THEMES.slice(1)) {
      const unknown = Object.keys(tokens).filter(
        (k) => !darkKeys.has(k) && !(name === "liquid" && k.startsWith("--glass-")),
      );
      expect(unknown, name).toEqual([]);
    }
  });
});
