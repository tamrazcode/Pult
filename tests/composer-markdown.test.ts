import { describe, expect, it } from "vitest";
import {
  handleMarkdownBackspace,
  handleMarkdownNewline,
  handleMarkdownSpace,
  isInsideCodeFence,
} from "../src/lib/composerMarkdown";

describe("composer markdown", () => {
  it("normalizes 1) plus space into 1. ", () => {
    const result = handleMarkdownSpace("1)", 2, 2)!;
    expect(result.nextText).toBe("1. ");
    expect(result.selectionStart).toBe(3);
    expect(handleMarkdownSpace("1.", 2, 2)).toBeNull();
  });

  it("continues bullets, numbers, quotes and checkboxes", () => {
    const bullet = "- one";
    expect(handleMarkdownNewline(bullet, bullet.length, bullet.length)!.nextText).toBe("- one\n- ");
    const numbered = "2. two";
    expect(handleMarkdownNewline(numbered, numbered.length, numbered.length)!.nextText).toBe(
      "2. two\n3. ",
    );
    const quote = "> quote";
    expect(handleMarkdownNewline(quote, quote.length, quote.length)!.nextText).toBe("> quote\n> ");
    const checkbox = "- [x] done";
    expect(handleMarkdownNewline(checkbox, checkbox.length, checkbox.length)!.nextText).toBe(
      "- [x] done\n- [ ] ",
    );
  });

  it("ends a list or quote on an empty item", () => {
    const text = "- one\n- ";
    const result = handleMarkdownNewline(text, text.length, text.length)!;
    expect(result.nextText).toBe("- one\n");
    expect(result.selectionStart).toBe(6);
  });

  it("does not touch headings or lines inside a code fence", () => {
    expect(handleMarkdownNewline("# title", 7, 7)).toBeNull();
    const fenced = "```\n- item";
    expect(isInsideCodeFence(fenced, fenced.length)).toBe(true);
    expect(handleMarkdownNewline(fenced, fenced.length, fenced.length)).toBeNull();
  });

  it("removes or outdents a marker on Backspace", () => {
    expect(handleMarkdownBackspace("- ", 2, 2)!.nextText).toBe("");
    const indented = "  - ";
    expect(handleMarkdownBackspace(indented, indented.length, indented.length)!.nextText).toBe(
      "- ",
    );
    expect(handleMarkdownBackspace("2. ", 3, 3)!.nextText).toBe("");
  });
});
