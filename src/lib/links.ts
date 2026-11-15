export type ClassifiedLink =
  | { kind: "external"; url: string }
  | { kind: "workspace"; relativePath: string; fullPath: string; isDir: boolean }
  | { kind: "anchor"; id: string }
  | { kind: "unsupported"; raw: string };

function fileUrlToPath(raw: string): string {
  try {
    const url = new URL(raw);
    let path = decodeURIComponent(url.pathname);
    if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1);
    return path;
  } catch {
    return raw;
  }
}

/** Classifies a raw Markdown href without letting the browser resolve it. */
export function classifyMarkdownHref(
  rawHref: string | null | undefined,
  workspaceRoot: string | null | undefined,
): ClassifiedLink {
  const raw = (rawHref ?? "").trim();
  if (!raw) return { kind: "unsupported", raw };
  if (raw.startsWith("#")) return { kind: "anchor", id: raw.slice(1) };

  const drivePath = /^[a-zA-Z]:[\\/]/.test(raw);
  const scheme = drivePath
    ? undefined
    : /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw)?.[1]?.toLowerCase();
  if (scheme && scheme !== "http" && scheme !== "https" && scheme !== "file") {
    return { kind: "unsupported", raw };
  }

  if (scheme === "http" || scheme === "https") {
    try {
      const url = new URL(raw);
      if (url.hostname) return { kind: "external", url: raw };
    } catch {
      // fall through
    }
    return { kind: "unsupported", raw };
  }

  let path = raw;
  if (scheme === "file") {
    try {
      const url = new URL(raw);
      if (url.host && url.host !== "localhost") return { kind: "unsupported", raw };
    } catch {
      return { kind: "unsupported", raw };
    }
    path = fileUrlToPath(raw);
  }
  path = path.split("#")[0].split("?")[0].replace(/\\/g, "/");
  if (!path || path.startsWith("/") || path.startsWith("//")) {
    return { kind: "unsupported", raw };
  }
  if (path.split("/").some((part) => part === "..")) {
    return { kind: "unsupported", raw };
  }

  let relative: string;
  const root = workspaceRoot?.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  if (/^[a-zA-Z]:\//.test(path)) {
    if (!root) return { kind: "unsupported", raw };
    const normalized = path.toLowerCase();
    const normalizedRoot = root.toLowerCase();
    if (normalized !== normalizedRoot && !normalized.startsWith(`${normalizedRoot}/`)) {
      return { kind: "unsupported", raw };
    }
    relative = path.slice(root.length).replace(/^\/+/, "");
  } else {
    relative = path.replace(/^\.\//, "");
  }
  if (!relative) return { kind: "unsupported", raw };

  const isDir = relative.endsWith("/");
  relative = relative.replace(/\/+$/, "");
  if (!relative) return { kind: "unsupported", raw };
  const nativeRoot = workspaceRoot?.replace(/[\\/]+$/, "").replace(/\//g, "\\");
  const fullPath = nativeRoot ? `${nativeRoot}\\${relative.replace(/\//g, "\\")}` : relative;
  return { kind: "workspace", relativePath: relative, fullPath, isDir };
}
