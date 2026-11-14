import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { Markdown } from "../src/components/chat/Markdown";

const { mockCodeToHtml, mockLoadLanguage, mockCreateHighlighter } = vi.hoisted(() => {
  const mockCodeToHtml = vi.fn(
    (_code: string, _options?: { lang: string; theme: string }) => "<pre>hi</pre>",
  );
  const mockLoadLanguage = vi.fn(async () => {});
  const mockCreateHighlighter = vi.fn(async () => ({
    codeToHtml: mockCodeToHtml,
    loadLanguage: mockLoadLanguage,
  }));
  return { mockCodeToHtml, mockLoadLanguage, mockCreateHighlighter };
});

vi.mock("shiki", () => ({
  createHighlighter: mockCreateHighlighter,
  createJavaScriptRegexEngine: vi.fn(() => ({})),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Markdown", () => {
  it("never constructs a highlighter for ordinary inline text", async () => {
    render(<Markdown text={"Hello **world** with `inline` code."} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(mockCreateHighlighter).not.toHaveBeenCalled();
  });

  it("does not call codeToHtml for an open fenced code block while streaming", async () => {
    render(<Markdown text={"```ts\nconst x = 1"} streaming />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(mockCodeToHtml).not.toHaveBeenCalled();
  });

  it("still does not call codeToHtml when re-rendering the same open fence with more text", async () => {
    const { rerender } = render(<Markdown text={"```ts\nconst x = 1"} streaming />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    rerender(<Markdown text={"```ts\nconst x = 1\nconst y = 2"} streaming />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(mockCodeToHtml).not.toHaveBeenCalled();
  });

  it("calls loadLanguage('ts') and codeToHtml once with the full block when the fence closes", async () => {
    const { rerender } = render(<Markdown text={"```ts\nconst x = 1"} streaming />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });

    rerender(<Markdown text={"```ts\nconst x = 1\nconst y = 2\n```"} streaming={false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(mockLoadLanguage).toHaveBeenCalledWith("ts");
    expect(mockCodeToHtml).toHaveBeenCalledTimes(1);
    expect(mockCodeToHtml.mock.calls[0]?.[0]).toContain("const x = 1\nconst y = 2");
  });
});
