import type { Project, Thread } from "./types";

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

/** Route-aware breadcrumbs: `pult / <project?> / <what you look at>`. */
export function resolveBreadcrumbs(
  pathname: string,
  threads: Thread[],
  projects: Project[] = [],
  selectedProjectId: string | null = null,
): Crumb[] {
  const root: Crumb = { label: "pult", to: "/chat" };
  const projectCrumb = (id: string | null | undefined): Crumb | null => {
    if (!id) return null;
    const project = projects.find((candidate) => candidate.id === id);
    return project ? { label: project.name, to: "/chat" } : null;
  };
  if (pathname.startsWith("/thread/")) {
    const id = pathname.slice("/thread/".length);
    const thread = threads.find((t) => t.id === id);
    return [
      root,
      ...(projectCrumb(thread?.projectId) ? [projectCrumb(thread?.projectId)!] : []),
      { label: thread?.title || "Thread" },
    ];
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
  const selected = projectCrumb(selectedProjectId);
  return [root, ...(selected ? [selected] : []), { label: "New thread" }];
}
