import { describe, expect, it } from "vitest";
import type { ToolChatItem } from "../src/stores/runs";
import {
  deriveToolTitle,
  normalizeToolKind,
  numberedExcerpt,
  isRawToolName,
  thoughtPreview,
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

  it("derives human titles for raw tool names, missing rawInput, unknown tools, and long commands", () => {
    expect(
      deriveToolTitle(
        tool({ title: "shell", kind: "shell", rawInput: { command: "pnpm test" } }),
        "past",
      ),
    ).toBe("Ran pnpm test");
    expect(deriveToolTitle(tool({ title: "shell", kind: "shell" }), "past")).toBe("Ran command");
    expect(
      deriveToolTitle(tool({ title: "grep", kind: "grep", rawInput: { pattern: "TODO" } }), "past"),
    ).toBe("Searched “TODO”");
    expect(deriveToolTitle(tool({ title: "delete", kind: "delete" }), "past")).toBe("Deleted file");
    expect(deriveToolTitle(tool({ title: "delete", kind: "delete" }), "present")).toBe(
      "Deleting file",
    );
    expect(deriveToolTitle(tool({ title: "move", kind: "move" }), "present")).toBe("Moving file");
    expect(
      deriveToolTitle(tool({ title: "grep", kind: "grep", locations: ["src/a.ts"] }), "present"),
    ).toBe("Searching files");
    expect(
      deriveToolTitle(tool({ title: "grep", kind: "grep", locations: ["src/a.ts"] }), "past"),
    ).toBe("Searched in src/a.ts");
    expect(
      deriveToolTitle(
        tool({ title: "move", kind: "move", rawInput: { path: "src/a.ts" } }),
        "past",
      ),
    ).toBe("Moved src/a.ts");
    expect(deriveToolTitle(tool({ title: "fetch", kind: "fetch" }), "past")).toBe(
      "Fetched resource",
    );
    expect(
      deriveToolTitle(
        tool({ title: "fetch", kind: "fetch", rawInput: { url: "https://x.dev/a" } }),
        "past",
      ),
    ).toBe("Fetched https://x.dev/a");
    expect(
      deriveToolTitle(
        tool({ title: "shell", kind: "shell", rawInput: { command: "a".repeat(90) } }),
        "past",
      ),
    ).toMatch(/…$/);
    expect(deriveToolTitle(tool({ title: "mcp__git__status", kind: "other" }), "past")).toBe(
      "Git status",
    );
    // An agent-written phrase survives untouched.
    expect(
      deriveToolTitle(tool({ title: "Gemini review delivered findings", kind: "other" }), "past"),
    ).toBe("Gemini review delivered findings");
  });

  it("extracts single-line thought preview and strips markdown", () => {
    expect(thoughtPreview("# Создам четвёртый файл\nДетали")).toBe("Создам четвёртый файл");
    expect(thoughtPreview("   \n\n")).toBeNull();
  });

  it("derives a readable title from a path, URL, or command line in the title", () => {
    expect(
      deriveToolTitle(
        tool({
          title: "Read C:\\Users\\dev\\Desktop\\pult\\src\\lib\\de.ts 750-820",
          kind: "read",
        }),
        "past",
      ),
    ).toBe("Read de.ts");
    expect(
      deriveToolTitle(tool({ title: "Read /Users/dev/pult/de.ts 750-820", kind: "read" }), "past"),
    ).toBe("Read de.ts");
    expect(
      deriveToolTitle(tool({ title: "Get-ChildItem -Path src -Recurse", kind: "execute" }), "past"),
    ).toBe("Searched files");
    expect(
      deriveToolTitle(
        tool({ title: "Select-String -Pattern TODO -Path src", kind: "execute" }),
        "present",
      ),
    ).toBe("Searching files");
    expect(
      deriveToolTitle(tool({ title: "fetch https://example.com/docs", kind: "fetch" }), "past"),
    ).toBe("Fetched https://example.com/docs");
    // A human sentence that merely contains words like "read" survives.
    expect(
      deriveToolTitle(
        tool({ title: "Gemini review delivered findings: read the diff", kind: "other" }),
        "past",
      ),
    ).toBe("Gemini review delivered findings: read the diff");
  });

  it("normalizes kind synonyms and spots machine identifiers", () => {
    expect(normalizeToolKind(tool({ title: "shell", kind: "shell" }))).toBe("execute");
    expect(normalizeToolKind(tool({ title: "grep", kind: "grep" }))).toBe("search");
    expect(normalizeToolKind(tool({ title: "Get-ChildItem src", kind: "execute" }))).toBe("search");
    expect(isRawToolName("shell")).toBe(true);
    expect(isRawToolName("mcp__git__status")).toBe(true);
    expect(isRawToolName("Run tests", "execute")).toBe(false);
    expect(isRawToolName("Read C:\\repo\\a.ts", "read")).toBe(true);
    expect(isRawToolName("Get-ChildItem -Path src", "execute")).toBe(true);
    expect(isRawToolName("Gemini review delivered findings", "other")).toBe(false);
  });
});
