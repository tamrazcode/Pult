import type { ToolChatItem } from "../stores/runs";
import { translate } from "./i18n";

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
  return match ? match[0].replace(/[,.;:]+$/, "") : null;
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
  return lines.map((line) => line.replace(/^\s*\d+[→\t]/, "")).join("\n");
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
  const text = textFromValue(raw).trimEnd();
  if (text) return stripGutter(text);
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string" || (Array.isArray(raw) && raw.length === 0)) return "";
  if (typeof raw === "object" && Object.keys(raw as Record<string, unknown>).length === 0)
    return "";
  return JSON.stringify(raw, null, 2);
}

/** Technical tool names an agent may leak into the collapsed row. */
const RAW_TOOL_NAMES = new Set([
  "shell",
  "bash",
  "sh",
  "pwsh",
  "powershell",
  "cmd",
  "execute",
  "exec",
  "run",
  "run_command",
  "read",
  "read_file",
  "view_file",
  "cat",
  "grep",
  "rg",
  "search",
  "glob",
  "find",
  "edit",
  "edit_file",
  "write",
  "write_file",
  "create_file",
  "patch",
  "multi_edit",
  "delete",
  "remove",
  "rm",
  "move",
  "rename",
  "mv",
  "fetch",
  "web_search",
  "curl",
  "think",
  "thought",
  "other",
  "tool",
]);

/** First word of a title, lowercased and stripped of a shell prompt. */
function firstWord(text: string): string {
  const value = text
    .trim()
    .toLowerCase()
    .replace(/^[$>]+\s*/, "");
  return value.split(/[\s:]+/)[0] ?? "";
}

/** Verbs and commands that mean the title is the tool call, not a sentence. */
const RAW_TITLE_PREFIXES = new Set([
  "read",
  "search",
  "ran",
  "edit",
  "write",
  "delete",
  "move",
  "get-childitem",
  "select-string",
  "powershell",
  "shell",
  "grep",
]);

const ABSOLUTE_PATH =
  /(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\/C:\/|\/(?:Users|home|root|opt|usr|var|tmp|etc|mnt|private)\/)/;

/** True when the title is a tool call, a machine path/URL, or a command line. */
export function isRawToolName(title: string, kind?: string): boolean {
  const value = title.trim();
  if (!value) return true;
  if (kind && value.toLowerCase() === kind.trim().toLowerCase()) return true;
  if (RAW_TOOL_NAMES.has(value.toLowerCase())) return true;
  if (value.startsWith("mcp__")) return true;
  if (ABSOLUTE_PATH.test(value)) return true;
  if (/https?:\/\//i.test(value)) return true;
  if (RAW_TITLE_PREFIXES.has(firstWord(value))) return true;
  return /^[a-z0-9_.-]+$/i.test(value);
}

export type ToolKind =
  "read" | "edit" | "delete" | "move" | "execute" | "search" | "fetch" | "think" | "other";

const KIND_ALIASES: Record<string, ToolKind> = {
  shell: "execute",
  bash: "execute",
  sh: "execute",
  pwsh: "execute",
  powershell: "execute",
  cmd: "execute",
  exec: "execute",
  execute: "execute",
  run: "execute",
  run_command: "execute",
  grep: "search",
  rg: "search",
  glob: "search",
  find: "search",
  search: "search",
  "get-childitem": "search",
  "select-string": "search",
  findstr: "search",
  read: "read",
  read_file: "read",
  view_file: "read",
  cat: "read",
  "get-content": "read",
  edit: "edit",
  edit_file: "edit",
  write: "edit",
  write_file: "edit",
  create_file: "edit",
  patch: "edit",
  multi_edit: "edit",
  "set-content": "edit",
  "add-content": "edit",
  "out-file": "edit",
  delete: "delete",
  remove: "delete",
  rm: "delete",
  "remove-item": "delete",
  move: "move",
  rename: "move",
  mv: "move",
  "move-item": "move",
  fetch: "fetch",
  web_search: "fetch",
  curl: "fetch",
  http: "fetch",
  "invoke-webrequest": "fetch",
  think: "think",
  thought: "think",
};

/** Canonical kind; a command-looking title wins over a generic declared kind. */
export function normalizeToolKind(item: ToolChatItem): ToolKind {
  const fromTitle = KIND_ALIASES[firstWord(item.title)];
  if (fromTitle) return fromTitle;
  const fromKind = KIND_ALIASES[item.kind.trim().toLowerCase()];
  if (fromKind) return fromKind;
  return "other";
}

/** One line, capped, so a label cannot wrap or flood the row. */
export function truncateInline(text: string, maxChars = 72): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, maxChars).trimEnd()}…`;
}

/** First line of a command without the shell prompt prefix. */
export function shortCommandLabel(cmd: string): string {
  const line = cmd
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return "";
  return truncateInline(line.replace(/^[$>]\s*/, ""), 64);
}

/** First URL in the payload, or one embedded in the title. */
export function toolUrl(item: ToolChatItem): string | null {
  const fromInput = firstString(asRecord(item.rawInput), ["url", "uri", "href"]);
  if (fromInput) return fromInput;
  return item.title.match(/https?:\/\/[^\s"']+/)?.[0] ?? null;
}

/** First sentence of a thought, stripped of markdown noise. */
export function thoughtPreview(text: string, maxChars = 80): string | null {
  const line = text
    .slice(0, 200)
    .replace(/^#+\s*/gm, "")
    .replace(/[*_`~]/g, "")
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return null;
  const sentence = line.split(/(?<=[.!?。！？])\s+/)[0] ?? line;
  return truncateInline(sentence, maxChars);
}

/** `mcp__git__status` -> `Git status`. */
export function humanizeToolIdentifier(raw: string): string {
  const words = raw
    .replace(/^mcp__/, "")
    .split(/[_-]+/)
    .filter(Boolean)
    .join(" ");
  if (!words) return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Long absolute paths are unreadable in a row: show the file name. */
function displayPath(path: string): string {
  const absolute = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/") || path.startsWith("\\\\");
  if (!absolute) return path;
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Human, tense-aware label for a tool row; agent-written phrases win. */
export function deriveToolTitle(item: ToolChatItem, mode: "past" | "present"): string {
  const kind = normalizeToolKind(item);
  const raw = isRawToolName(item.title, item.kind);
  const path = /https?:\/\//i.test(item.title) ? null : toolPath(item);
  const fileKind = kind === "read" || kind === "edit" || kind === "delete" || kind === "move";
  if (!raw && !(fileKind && path !== null)) return truncateInline(item.title, 80);
  const present = mode === "present";
  const shownPath = path ? displayPath(path) : null;

  switch (kind) {
    case "execute": {
      const command =
        firstString(asRecord(item.rawInput), ["command", "cmd", "script", "commandLine"]) ??
        (raw ? null : item.title);
      if (command) {
        return translate(present ? "chat.action.runningCommand" : "chat.action.ranCommand", {
          command: shortCommandLabel(command),
        });
      }
      return translate(present ? "chat.action.running" : "chat.action.ranCommandGeneric");
    }
    case "read":
      return shownPath
        ? translate(present ? "chat.action.readingFile" : "chat.action.readFile", {
            path: shownPath,
          })
        : translate(present ? "chat.action.reading" : "chat.action.readFileGeneric");
    case "edit":
      return shownPath
        ? translate(present ? "chat.action.editingFile" : "chat.action.editedFile", {
            path: shownPath,
          })
        : translate(present ? "chat.action.editing" : "chat.action.editedFileGeneric");
    case "delete":
      return shownPath
        ? translate(present ? "chat.action.deletingFile" : "chat.action.deletedFile", {
            path: shownPath,
          })
        : translate(present ? "chat.action.deletingFileGeneric" : "chat.action.deletedFileGeneric");
    case "move":
      return shownPath
        ? translate(present ? "chat.action.movingFile" : "chat.action.movedFile", {
            path: shownPath,
          })
        : translate(present ? "chat.action.movingFileGeneric" : "chat.action.movedFileGeneric");
    case "search": {
      const query =
        firstString(asRecord(item.rawInput), [
          "query",
          "pattern",
          "regex",
          "q",
          "search",
          "glob",
        ]) ?? (raw ? null : item.title);
      if (query) {
        return translate(present ? "chat.action.searchingQuery" : "chat.action.searchedQuery", {
          query: truncateInline(query, 48),
        });
      }
      return shownPath
        ? translate(present ? "chat.action.searching" : "chat.action.searchedIn", {
            path: shownPath,
          })
        : translate(present ? "chat.action.searching" : "chat.action.searchedGeneric");
    }
    case "fetch": {
      const url = toolUrl(item);
      if (url) {
        return translate(present ? "chat.action.fetchingUrl" : "chat.action.fetchedUrl", {
          url: truncateInline(url, 56),
        });
      }
      return translate(present ? "chat.action.fetching" : "chat.action.fetchedGeneric");
    }
    case "think":
      return thoughtPreview(item.title) ?? translate("chat.thinking");
    default: {
      if (!raw) return truncateInline(item.title, 80);
      const name = humanizeToolIdentifier(item.title);
      // A title that is already a path reads best as the file name alone.
      if (shownPath && /[\\/]/.test(item.title)) return shownPath;
      if (shownPath) return `${name} · ${shownPath}`;
      return name || translate("chat.tool.actions");
    }
  }
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
