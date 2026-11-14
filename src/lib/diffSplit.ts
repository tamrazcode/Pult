/**
 * Unified-diff parsing + split-view pairing (M4 diff panel, own renderer —
 * no heavyweight diff component, §5).
 */

export type DiffLineKind = "add" | "del" | "context" | "hunk" | "meta";

export interface DiffLine {
  text: string;
  kind: DiffLineKind;
  oldNo: number | null;
  newNo: number | null;
}

export interface SplitRow {
  left: DiffLine | null;
  right: DiffLine | null;
}

function isMetaLine(text: string): boolean {
  return (
    text.startsWith("diff --git ") ||
    text.startsWith("index ") ||
    text.startsWith("--- ") ||
    text.startsWith("+++ ") ||
    text.startsWith("new file mode") ||
    text.startsWith("deleted file mode") ||
    text.startsWith("old mode") ||
    text.startsWith("new mode") ||
    text.startsWith("similarity index") ||
    text.startsWith("rename from") ||
    text.startsWith("rename to") ||
    text.startsWith("Binary files") ||
    text.startsWith("GIT binary patch")
  );
}

/** Classifies every line of one `diff --git` section, tracking line numbers. */
export function parseDiffLines(raw: string): DiffLine[] {
  const lines = raw.split("\n");
  // A trailing "\n" produces a final empty element — it is not a diff line.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  const out: DiffLine[] = [];
  for (const text of lines) {
    if (isMetaLine(text)) {
      inHunk = false;
      out.push({ text, kind: "meta", oldNo: null, newNo: null });
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      inHunk = true;
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      out.push({ text, kind: "hunk", oldNo: null, newNo: null });
      continue;
    }
    if (!inHunk) {
      out.push({ text, kind: "meta", oldNo: null, newNo: null });
      continue;
    }
    if (text.startsWith("+")) {
      out.push({ text: text.slice(1), kind: "add", oldNo: null, newNo });
      newNo += 1;
    } else if (text.startsWith("-")) {
      out.push({ text: text.slice(1), kind: "del", oldNo, newNo: null });
      oldNo += 1;
    } else {
      out.push({
        text: text.startsWith(" ") ? text.slice(1) : text,
        kind: "context",
        oldNo,
        newNo,
      });
      oldNo += 1;
      newNo += 1;
    }
  }
  return out;
}

/**
 * Pairs lines into split rows: context lines stay side by side, runs of
 * deletions and additions zip together, leftovers get an empty side.
 */
export function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      i += 1;
      continue;
    }
    if (line.kind !== "del" && line.kind !== "add") {
      // hunk/meta spans both columns.
      rows.push({ left: line, right: line });
      i += 1;
      continue;
    }
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].kind === "del") {
      dels.push(lines[i]);
      i += 1;
    }
    while (i < lines.length && lines[i].kind === "add") {
      adds.push(lines[i]);
      i += 1;
    }
    const paired = Math.max(dels.length, adds.length);
    for (let k = 0; k < paired; k += 1) {
      rows.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    }
  }
  return rows;
}

/** Stable short hash for reviewed-state comparison (djb2, hex). */
export function diffHash(raw: string): string {
  let h = 5381;
  for (let i = 0; i < raw.length; i += 1) {
    h = (h * 33) ^ raw.charCodeAt(i);
    h >>>= 0;
  }
  return h.toString(16).padStart(8, "0");
}
