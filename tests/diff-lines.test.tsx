import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { SplitLines, UnifiedLines } from "../src/components/diff/DiffLines";

/** One hunk with `pairs` removed/added line pairs (2 rows per pair). */
function largePatch(pairs: number): string {
  const lines = [
    "diff --git a/big.txt b/big.txt",
    "index 1111111..2222222 100644",
    "--- a/big.txt",
    "+++ b/big.txt",
    `@@ -1,${pairs} +1,${pairs} @@`,
  ];
  for (let i = 0; i < pairs; i += 1) {
    lines.push(`-old ${i}`, `+new ${i}`);
  }
  return `${lines.join("\n")}\n`;
}

describe("DiffLines large patch cap", () => {
  it("caps UnifiedLines at 2,000 rows and reveals all on click", () => {
    const { container } = render(<UnifiedLines raw={largePatch(6000)} />);

    expect(container.querySelectorAll("[data-diff-line-row]").length).toBeLessThan(2100);
    const reveal = screen.getByRole("button", { name: /Show all 12,?00[0-9] lines/i });
    fireEvent.click(reveal);

    expect(container.querySelectorAll("[data-diff-line-row]").length).toBeGreaterThanOrEqual(12000);
  });

  it("caps SplitLines rows and reveals all on click", () => {
    const { container } = render(<SplitLines raw={largePatch(6000)} />);

    expect(container.querySelectorAll("[data-diff-line-row]").length).toBeLessThan(2100);
    fireEvent.click(screen.getByRole("button", { name: /Show all/i }));
    expect(container.querySelectorAll("[data-diff-line-row]").length).toBeGreaterThanOrEqual(6000);
  });
});
