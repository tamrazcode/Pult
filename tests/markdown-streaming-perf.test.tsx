import type { ComponentProps } from "react";
import type ReactMarkdownType from "react-markdown";
import type * as ReactMarkdownModule from "react-markdown";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

const { mockCodeToHtml, mockCreateHighlighter, markdownRenders } = vi.hoisted(() => {
  const mockCodeToHtml = vi.fn(
    (_code: string, _options?: { lang: string; theme: string }) => "<pre>highlighted</pre>",
  );
  const mockLoadLanguage = vi.fn(async () => {});
  const mockCreateHighlighter = vi.fn(async () => ({
    codeToHtml: mockCodeToHtml,
    loadLanguage: mockLoadLanguage,
  }));
  const markdownRenders = { count: 0 };
  return { mockCodeToHtml, mockCreateHighlighter, markdownRenders };
});

vi.mock("react-markdown", async (importOriginal) => {
  const actual = await importOriginal<typeof ReactMarkdownModule>();
  const RealReactMarkdown = actual.default;
  return {
    ...actual,
    default: (props: ComponentProps<typeof ReactMarkdownType>) => {
      markdownRenders.count += 1;
      return <RealReactMarkdown {...props} />;
    },
  };
});

vi.mock("shiki/core", () => ({ createHighlighterCore: mockCreateHighlighter }));
vi.mock("shiki/engine/javascript", () => ({ createJavaScriptRegexEngine: vi.fn(() => ({})) }));
vi.mock("shiki/langs/ts.mjs", () => ({ default: { name: "ts" } }));
vi.mock("shiki/themes/github-dark-default.mjs", () => ({
  default: { name: "github-dark-default" },
}));

import { Markdown } from "../src/components/chat/Markdown";

/** ~20 KB stream with paragraphs, GFM tables, fenced code and KaTeX. */
function longMarkdown(): string {
  const paragraphs = Array.from(
    { length: 40 },
    (_, i) =>
      `Paragraph ${i + 1}: the agent keeps writing while the transcript grows, and the ` +
      `renderer must stay responsive instead of repainting every token. ` +
      `A second sentence adds realistic prose weight so the stream carries about twenty ` +
      `kilobytes by the end of the turn, the size where naive per-delta parsing starts to ` +
      `show up as dropped frames on a laptop. A third sentence keeps the fixture honest ` +
      `while a fourth sentence fills out realistic markdown paragraph density for testing.`,
  );
  const table = (n: number) =>
    `\n| step | state | note |\n| --- | --- | --- |\n| ${n} | done | checked |\n| ${n + 1} | wip | streaming |\n`;
  const code = (n: number) =>
    `\n\`\`\`ts\nfunction block${n}(value: number) {\n  return value * ${n};\n}\n\`\`\`\n`;
  const math = (n: number) =>
    `\nInline $a_${n} + b_${n} = c_${n}$ and display:\n\n$$\n\\sum_{i=1}^{${n}} i\n$$\n`;
  const parts: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    parts.push(paragraphs[i]);
    if (i % 13 === 4) parts.push(table(i));
    if (i % 10 === 3) parts.push(code(i));
    if (i % 20 === 7) parts.push(math(i));
  }
  return parts.join("\n\n");
}

/** Simulates 500 SSE deltas at ~16 ms each through fake timers. */
async function stream(
  rerender: (text: string, streaming: boolean) => void,
  full: string,
  deltas: number,
): Promise<void> {
  const step = Math.ceil(full.length / deltas);
  for (let i = 1; i <= deltas; i += 1) {
    rerender(full.slice(0, Math.min(full.length, i * step)), true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  markdownRenders.count = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("markdown streaming performance", () => {
  it(
    "throttles re-renders across 500 deltas and renders tables, math and code",
    { timeout: 120_000 },
    async () => {
      const full = longMarkdown();
      expect(full.length).toBeGreaterThan(18_000);
      const { rerender } = render(<Markdown text="" streaming />);
      const view = (text: string, streaming: boolean) =>
        rerender(<Markdown text={text} streaming={streaming} />);

      const startedAt = Date.now();
      await stream(view, full, 500);
      const streamedMs = Date.now() - startedAt;

      // One parse per STREAM_PARSE_MS (32 ms) plus leading/trailing flushes.
      const budget = Math.ceil(streamedMs / 32) + 4;
      console.info(
        `vitest streaming perf: renders=${markdownRenders.count} budget=${budget} streamedMs=${streamedMs} bytes=${full.length}`,
      );
      expect(markdownRenders.count).toBeLessThanOrEqual(budget);
      expect(markdownRenders.count).toBeGreaterThan(1);

      view(full, false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      expect(document.querySelectorAll("table")).toHaveLength(3);
      expect(document.querySelectorAll(".katex")).toHaveLength(4);
      expect(document.querySelectorAll(".md-code")).toHaveLength(4);
    },
  );

  it(
    "never highlights an open fence and highlights each closed block once after the stream",
    { timeout: 120_000 },
    async () => {
      const tail = "\n```ts\nfunction stillStreaming(x: number) {\n  return x + 1;\n}\n```\n";
      const full = longMarkdown() + tail;
      // Hold the last fence open: everything before it is already closed.
      const openTail = full.slice(0, -4);
      const { rerender } = render(<Markdown text="" streaming />);
      const view = (text: string, streaming: boolean) =>
        rerender(<Markdown text={text} streaming={streaming} />);

      await stream(view, openTail, 500);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });

      const highlightedWhileStreaming = mockCodeToHtml.mock.calls.map((call) => call[0]);
      expect(highlightedWhileStreaming.some((code) => code.includes("stillStreaming"))).toBe(
        false,
      );
      const callsBeforeEnd = mockCodeToHtml.mock.calls.length;

      view(full, false);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });

      const allCodes = mockCodeToHtml.mock.calls.map((call) => call[0]);
      const postStreamCodes = allCodes.slice(callsBeforeEnd);
      const counts = Object.fromEntries(
        [3, 13, 23, 33].map((n) => [
          `block${n}`,
          allCodes.filter((code) => code.includes(`function block${n}(`)).length,
        ]),
      );
      console.info(
        `vitest shiki highlights: total=${allCodes.length} postStream=${postStreamCodes.length} blocks=${JSON.stringify(counts)}`,
      );
      for (let n = 3; n < 40; n += 10) {
        const matches = allCodes.filter((code) => code.includes(`function block${n}(`));
        expect(matches.length, `total highlights for block${n}`).toBe(1);
        expect(
          postStreamCodes.filter((code) => code.includes(`function block${n}(`)),
          `post-stream re-highlights for block${n}`,
        ).toHaveLength(0);
      }
      expect(postStreamCodes.filter((code) => code.includes("stillStreaming("))).toHaveLength(1);
    },
  );
});
