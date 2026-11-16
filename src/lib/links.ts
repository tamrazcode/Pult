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

/** Absolute drive-qualified path from a raw href, or null. */
export function localFilePath(rawHref: string | null | undefined): string | null {
  const raw = (rawHref ?? "").trim();
  if (!raw) return null;
  if (/(^|[\\/])\.\.([\\/?#]|$)/.test(raw.replace(/%2e/gi, "."))) return null;
  let path = raw;
  if (/^file:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.host && url.host !== "localhost") return null;
      path = decodeURIComponent(url.pathname);
      if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1);
    } catch {
      return null;
    }
  } else {
    path = path.split("#")[0].split("?")[0];
  }
  if (path.split(/[\\/]/).some((part) => part === "..")) return null;
  path = path.replace(/\\/g, "/").replace(/^([a-zA-Z]):\/+/, "$1:/");
  return /^[a-zA-Z]:\//.test(path) ? path.replace(/\//g, "\\") : null;
}

/** Classifies a raw Markdown href without letting the browser resolve it. */
export function classifyMarkdownHref(
  rawHref: string | null | undefined,
  workspaceRoot: string | null | undefined,
  platform?: "windows" | "posix",
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
  // `file:///C:/%5CUsers` decodes to `C://Users`; collapse the drive slash.
  path = path.replace(/^([a-zA-Z]):\/+/, "$1:/");
  if (!path) return { kind: "unsupported", raw };
  if (path.split("/").some((part) => part === "..")) {
    return { kind: "unsupported", raw };
  }

  const root = workspaceRoot?.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  // A root that starts with a single slash is a POSIX workspace; Windows
  // roots are drive-qualified (C:/…). UNC paths are not workspace roots.
  const posix =
    platform === "posix" ||
    (platform !== "windows" && !!root && root.startsWith("/") && !root.startsWith("//"));

  let relative: string;
  if (/^[a-zA-Z]:\//.test(path)) {
    if (!root) return { kind: "unsupported", raw };
    const normalized = path.toLowerCase();
    const normalizedRoot = root.toLowerCase();
    if (normalized !== normalizedRoot && !normalized.startsWith(`${normalizedRoot}/`)) {
      return { kind: "unsupported", raw };
    }
    relative = path.slice(root.length).replace(/^\/+/, "");
  } else if (posix && path.startsWith("/")) {
    if (!root || (path !== root && !path.startsWith(`${root}/`))) {
      return { kind: "unsupported", raw };
    }
    relative = path.slice(root.length).replace(/^\/+/, "");
  } else if (path.startsWith("/") || path.startsWith("//")) {
    return { kind: "unsupported", raw };
  } else {
    relative = path.replace(/^\.\//, "");
  }
  if (!relative) return { kind: "unsupported", raw };

  const isDir = relative.endsWith("/");
  relative = relative.replace(/\/+$/, "");
  if (!relative) return { kind: "unsupported", raw };
  const fullPath = root
    ? posix
      ? `${root}/${relative}`
      : `${root.replace(/\//g, "\\")}\\${relative.replace(/\//g, "\\")}`
    : relative;
  return { kind: "workspace", relativePath: relative, fullPath, isDir };
}
