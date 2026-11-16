import { describe, expect, it } from "vitest";
import type { ToolChatItem } from "../src/stores/runs";
import {
  numberedExcerpt,
  toolCommand,
  toolLineRange,
  toolOutputText,
  toolPath,
  toolQuery,
} from "../src/lib/toolDetails";

const tool = (patch: Partial<ToolChatItem>): ToolChatItem => ({
  type: "tool",
  toolCallId: "t1",
  title: "Tool",
  kind: "other",
  status: "completed",
  locations: [],
  ...patch,
});

describe("toolDetails", () => {
  it("prefers locations, then payload keys, then a path in the title", () => {
    expect(toolPath(tool({ locations: ["src/a.ts"], rawInput: { path: "src/b.ts" } }))).toBe(
      "src/a.ts",
    );
    expect(toolPath(tool({ rawInput: { file_path: "src/b.ts" } }))).toBe("src/b.ts");
    expect(toolPath(tool({ title: "Read pult/src/main.ts" }))).toBe("pult/src/main.ts");
  });

  it("reads line ranges from offset/limit, start/end, or the title", () => {
    expect(toolLineRange(tool({ rawInput: { offset: 925, limit: 40 } }))).toEqual({
      start: 925,
      end: 964,
    });
    expect(toolLineRange(tool({ rawInput: { start_line: 10, end_line: 12 } }))).toEqual({
      start: 10,
      end: 12,
    });
    expect(toolLineRange(tool({ title: "Read file C:\\repo\\a.ts, lines 925-964" }))).toEqual({
      start: 925,
      end: 964,
    });
  });

  it("extracts commands and queries", () => {
    expect(toolCommand(tool({ rawInput: { command: "pnpm test" } }))).toBe("pnpm test");
    expect(toolCommand(tool({ title: "Run checks" }))).toBe("Run checks");
    expect(toolQuery(tool({ rawInput: { pattern: "TODO" } }))).toBe("TODO");
  });

  it("flattens ACP content blocks and strips numeric gutters", () => {
    const output = toolOutputText(
      tool({
        rawOutput: {
          content: [
            { type: "text", text: "1→const a = 1;" },
            { type: "text", text: "2→const b = 2;" },
          ],
        },
      }),
    );
    expect(output).toBe("const a = 1;\nconst b = 2;");
  });

  it("numbers excerpt lines from the requested start and reports truncation", () => {
    const { lines, truncated } = numberedExcerpt("a\nb\nc", 925, 2);
    expect(lines).toEqual([
      { n: 925, text: "a" },
      { n: 926, text: "b" },
    ]);
    expect(truncated).toBe(1);
  });
});
