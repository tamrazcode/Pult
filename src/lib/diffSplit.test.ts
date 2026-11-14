import { describe, expect, it } from "vitest";
import { diffHash, parseDiffLines, toSplitRows } from "./diffSplit";

const UNIFIED = [
  "diff --git a/f.txt b/f.txt",
  "index 83db48f..55e69cd 100644",
  "--- a/f.txt",
  "+++ b/f.txt",
  "@@ -1,3 +1,3 @@",
  " line1",
  "-line2",
  "+CHANGED",
  " line3",
].join("\n");

describe("parseDiffLines", () => {
  it("classifies meta, hunk, context, add and del lines", () => {
    const lines = parseDiffLines(UNIFIED);
    expect(lines.map((l) => l.kind)).toEqual([
      "meta",
      "meta",
      "meta",
      "meta",
      "hunk",
      "context",
      "del",
      "add",
      "context",
    ]);
    expect(lines[6].text).toBe("line2");
    expect(lines[7].text).toBe("CHANGED");
  });

  it("tracks old and new line numbers", () => {
    const lines = parseDiffLines(UNIFIED);
    expect(lines[5]).toMatchObject({ kind: "context", oldNo: 1, newNo: 1 });
    expect(lines[6]).toMatchObject({ kind: "del", oldNo: 2, newNo: null });
    expect(lines[7]).toMatchObject({ kind: "add", oldNo: null, newNo: 2 });
    expect(lines[8]).toMatchObject({ kind: "context", oldNo: 3, newNo: 3 });
  });

  it("treats new-file diffs as all adds", () => {
    const raw = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..214dbfc",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+first",
      "+second",
    ].join("\n");
    const lines = parseDiffLines(raw);
    expect(lines.slice(6).map((l) => l.kind)).toEqual(["add", "add"]);
    expect(lines[6]).toMatchObject({ newNo: 1, oldNo: null });
    expect(lines[7]).toMatchObject({ newNo: 2, oldNo: null });
  });

  it("splits raw text on newlines without inventing a trailing line", () => {
    expect(parseDiffLines(UNIFIED)).toHaveLength(9);
    expect(parseDiffLines("")).toHaveLength(0);
  });
});

describe("toSplitRows", () => {
  it("pairs a del/add run into one row", () => {
    const lines = parseDiffLines(UNIFIED);
    const rows = toSplitRows(lines);
    const change = rows.find((r) => r.left?.kind === "del");
    expect(change).not.toBeUndefined();
    expect(change!.right?.kind).toBe("add");
    expect(change!.right?.text).toBe("CHANGED");
    // context rows share the same line object on both sides
    const ctx = rows.find((r) => r.left?.kind === "context");
    expect(ctx!.right).toBe(ctx!.left);
  });

  it("leaves unmatched dels on the left only", () => {
    const raw = ["@@ -1,3 +1,1 @@", "-a", "-b", "-c", "+only"].join("\n");
    const rows = toSplitRows(parseDiffLines(raw));
    expect(rows).toHaveLength(4); // hunk header + 3 paired rows
    expect(rows[1]).toMatchObject({ left: { text: "a" }, right: { text: "only" } });
    expect(rows[2].left?.text).toBe("b");
    expect(rows[2].right).toBeNull();
    expect(rows[3].left?.text).toBe("c");
    expect(rows[3].right).toBeNull();
  });

  it("renders hunk headers spanning both columns", () => {
    const rows = toSplitRows(parseDiffLines(UNIFIED));
    // 4 meta rows + 1 hunk row + 1 context + 1 del/add pair + 1 context
    expect(rows).toHaveLength(8);
    expect(rows[0].left?.kind).toBe("meta");
    expect(rows[4].left?.kind).toBe("hunk");
    expect(rows[4].left).toBe(rows[4].right);
  });
});

describe("diffHash", () => {
  it("is stable and distinguishes different texts", () => {
    expect(diffHash("abc")).toBe(diffHash("abc"));
    expect(diffHash("abc")).not.toBe(diffHash("abd"));
  });
});
