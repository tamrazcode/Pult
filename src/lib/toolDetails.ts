import type { ToolChatItem } from "../stores/runs";

export interface LineRange {
  start: number;
  end: number;
}

export interface ExcerptLine {
  n: number;
  text: string;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

const firstString = (record: Record<string, unknown>, keys: string[]): string | null => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
};

const firstNumber = (record: Record<string, unknown>, keys: string[]): number | null => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
};

/** File path for a tool call, from locations, payload, or the title. */
export function toolPath(item: ToolChatItem): string | null {
  if (item.locations.length > 0 && item.locations[0].trim()) return item.locations[0];
  const input = asRecord(item.rawInput);
  const fromPayload = firstString(input, [
    "path",
    "file_path",
    "filePath",
    "target_file",
    "filename",
    "file",
  ]);
  if (fromPayload) return fromPayload;
  const match =
    /(?:[A-Za-z]:\\[^\s"']+|\/[^\s"']+|[A-Za-z0-9_.@-]+(?:[/\\][A-Za-z0-9_.@-]+)+|[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,8})/.exec(
      item.title,
    );
  return match ? match[0] : null;
}

/** Requested line range, either explicit or encoded in the title. */
export function toolLineRange(item: ToolChatItem): LineRange | null {
  const input = asRecord(item.rawInput);
  const start = firstNumber(input, ["start_line", "startLine", "line", "offset"]);
  if (start !== null && start > 0) {
    const end =
      firstNumber(input, ["end_line", "endLine"]) ??
      (firstNumber(input, ["limit"]) ?? 0) + start - 1;
    return { start, end: Math.max(start, end) };
  }
  const match = /lines?\s+(\d+)(?:\s*[-–]\s*(\d+))?/i.exec(item.title);
  if (match) {
    const from = Number(match[1]);
    const to = match[2] ? Number(match[2]) : from;
    return { start: from, end: Math.max(from, to) };
  }
  return null;
}

/** Command text for shell/execute tools. */
export function toolCommand(item: ToolChatItem): string | null {
  const input = asRecord(item.rawInput);
  return firstString(input, ["command", "cmd", "script", "commandLine"]) ?? item.title;
}

/** Search query for search/grep tools. */
export function toolQuery(item: ToolChatItem): string | null {
  const input = asRecord(item.rawInput);
  return firstString(input, ["query", "pattern", "regex", "q", "search", "glob"]) ?? item.title;
}

const stripGutter = (text: string): string => {
  const lines = text.split("\n");
  const numbered = lines.filter((line) => /^\s*\d+[→\t]/.test(line)).length;
  if (numbered === 0 || numbered < lines.length / 2) return text;
  return lines.map((line) => line.replace(/^\s*\d+[→\t]\s?/, "")).join("\n");
};

const textFromValue = (value: unknown, depth = 0): string => {
  if (value === null || value === undefined || depth > 5) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => textFromValue(entry, depth + 1))
      .filter(Boolean)
      .join("\n");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    for (const key of ["stdout", "stderr", "output", "result", "content", "data", "items"]) {
      const text = textFromValue(record[key], depth + 1);
      if (text) return text;
    }
  }
  return "";
};

/** Human-readable output for a tool call; empty when the agent sent none. */
export function toolOutputText(item: ToolChatItem): string {
  const raw = item.rawOutput ?? item.content;
  const text = textFromValue(raw).trim();
  if (text) return stripGutter(text);
  if (raw !== undefined) return JSON.stringify(raw, null, 2);
  return "";
}

/** Numbered excerpt for read tools, capped so a huge file cannot flood the chat. */
export function numberedExcerpt(
  text: string,
  start: number,
  maxLines = 40,
): { lines: ExcerptLine[]; truncated: number } {
  const all = text.split("\n");
  while (all.length > 0 && all[all.length - 1] === "") all.pop();
  const lines = all
    .slice(0, maxLines)
    .map((line, index) => ({ n: Math.max(1, start) + index, text: line }));
  return { lines, truncated: Math.max(0, all.length - maxLines) };
}
