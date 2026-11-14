import type { Thread } from "./types";

const SETTINGS_TITLES: Record<string, string> = {
  appearance: "Appearance",
  providers: "Providers",
  keybindings: "Keybindings",
  diagnostics: "Diagnostics",
  about: "About",
};

export interface Crumb {
  label: string;
  /** Navigable crumbs only; the current page has no `to`. */
  to?: string;
}

/** Route-aware breadcrumbs: `pult / <what you are looking at>`. */
export function resolveBreadcrumbs(pathname: string, threads: Thread[]): Crumb[] {
  const root: Crumb = { label: "pult", to: "/chat" };
  if (pathname.startsWith("/thread/")) {
    const id = pathname.slice("/thread/".length);
    const thread = threads.find((t) => t.id === id);
    return [root, { label: thread?.title || "Thread" }];
  }
  if (pathname.startsWith("/settings")) {
    const section = pathname.split("/")[2] ?? "";
    return [
      root,
      { label: "Settings", to: "/settings/appearance" },
      { label: SETTINGS_TITLES[section] ?? "Settings" },
    ];
  }
  if (pathname.startsWith("/pull-requests")) return [root, { label: "Pull requests" }];
  if (pathname.startsWith("/usage")) return [root, { label: "Usage" }];
  if (pathname.startsWith("/welcome")) return [root, { label: "Setup" }];
  return [root, { label: "New thread" }];
}
