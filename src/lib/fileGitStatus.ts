import type { GitStatus, GitStatusEntry } from "./types";

export type FileGitCode = "M" | "A" | "D" | "R" | "U" | "?";

export interface FileGitDecoration {
  code: FileGitCode;
  label: string;
  colorClass: string;
}

const DECORATIONS: Record<FileGitCode, FileGitDecoration> = {
  U: { code: "U", label: "Unmerged", colorClass: "text-danger" },
  D: { code: "D", label: "Deleted", colorClass: "text-danger" },
  M: { code: "M", label: "Modified", colorClass: "text-warning" },
  A: { code: "A", label: "Added", colorClass: "text-success" },
  R: { code: "R", label: "Renamed", colorClass: "text-info" },
  "?": { code: "?", label: "Untracked", colorClass: "text-text-tertiary" },
};

const PRIORITY: FileGitCode[] = ["U", "D", "M", "A", "R", "?"];

const UNMERGED = new Set(["AA", "DD", "AU", "UA", "DU", "UD"]);

/** One porcelain status pair to the single letter the tree shows. */
export function classifyGitEntry(entry: GitStatusEntry): FileGitCode | null {
  const pair = `${entry.indexStatus}${entry.worktreeStatus}`;
  const chars = new Set([entry.indexStatus, entry.worktreeStatus]);
  if (UNMERGED.has(pair) || chars.has("U")) return "U";
  if (chars.has("?")) return "?";
  if (chars.has("D")) return "D";
  if (chars.has("R")) return "R";
  if (chars.has("A") || chars.has("C")) return "A";
  if (chars.has("M") || chars.has("T")) return "M";
  return null;
}

/** Decorations by path, including ancestors that contain a changed file. */
export function buildFileGitStatusMap(
  status: GitStatus | null | undefined,
): Map<string, FileGitDecoration> {
  const codes = new Map<string, FileGitCode>();
  const promote = (path: string, code: FileGitCode) => {
    const current = codes.get(path);
    if (!current || PRIORITY.indexOf(code) < PRIORITY.indexOf(current)) {
      codes.set(path, code);
    }
  };

  for (const entry of status?.entries ?? []) {
    const code = classifyGitEntry(entry);
    if (!code) continue;
    codes.set(entry.path, code);
    let parent = entry.path.split("/").slice(0, -1).join("/");
    while (parent) {
      promote(parent, code);
      parent = parent.split("/").slice(0, -1).join("/");
    }
  }

  return new Map([...codes].map(([path, code]) => [path, DECORATIONS[code]] as const));
}
