import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { Markdown } from "../src/components/chat/Markdown";

// Loading 19 grammars on first highlight is slow; give it headroom.
const HIGHLIGHT_TIMEOUT = 30_000;
const WAIT_FOR_HIGHLIGHT = 20_000;

describe("Markdown", () => {
  it("renders headings and paragraphs", () => {
    render(<Markdown text={"# Title\n\nBody paragraph.\n\n## Section"} />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Title");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Section");
    expect(screen.getByText("Body paragraph.")).toBeInTheDocument();
  });

  it("renders GFM tables", () => {
    render(<Markdown text={"| A | B |\n| --- | --- |\n| 1 | 2 |"} />);
    const table = screen.getByRole("table");
    expect(table.querySelector("th")?.textContent).toContain("A");
    expect(table.querySelector("td")?.textContent).toContain("1");
  });

  it(
    "highlights fenced code blocks and falls back for unknown languages",
    async () => {
      const known = render(<Markdown text={"```ts\nconst x = 1;\n```"} />);
      // Language label from the code fence shows up immediately.
      expect(screen.getByText("ts")).toBeInTheDocument();
      // Shiki (or the stubbed equivalent) eventually swaps in highlighted markup.
      await waitFor(
        () => {
          const highlighted = known.container.querySelector("[class*='shiki'], [class*='hljs']");
          expect(highlighted).not.toBeNull();
        },
        { timeout: WAIT_FOR_HIGHLIGHT },
      );

      const unknown = render(<Markdown text={"```foo\nweird code\n```"} />);
      expect(screen.getByText("foo")).toBeInTheDocument();
      expect(screen.getByText("weird code")).toBeInTheDocument();
      // Unknown language keeps the plain fallback: no crash, no highlighted markup.
      expect(unknown.container.querySelector("[class*='shiki']")).toBeNull();
    },
    HIGHLIGHT_TIMEOUT,
  );

  it("renders inline and display math with KaTeX", () => {
    const { container } = render(<Markdown text={"Inline $x^2$ math.\n\n$$\n\\frac{a}{b}\n$$"} />);
    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector(".katex-display")).not.toBeNull();
  });

  it("renders GFM task list checkboxes", () => {
    render(<Markdown text={"- [x] done\n- [ ] todo"} />);
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).not.toBeChecked();
  });
});
