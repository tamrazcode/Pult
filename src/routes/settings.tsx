import { useEffect, useRef, useState } from "react";
import { Outlet, createFileRoute, Link, useRouterState } from "@tanstack/react-router";
import {
  Bot,
  FileDiff,
  FolderTree,
  HeartPulse,
  Info,
  Keyboard,
  MessageSquare,
  Palette,
  Search,
  Settings2,
} from "lucide-react";
import { RouteHeader } from "../components/layout/WindowChrome";

export const Route = createFileRoute("/settings")({ component: SettingsLayout });

interface NavItem {
  to: string;
  label: string;
  icon: typeof Bot;
}

const NAV_GROUPS: { title?: string; items: NavItem[] }[] = [
  {
    items: [
      { to: "/settings/general", label: "General", icon: Settings2 },
      { to: "/settings/appearance", label: "Appearance", icon: Palette },
      { to: "/settings/chat", label: "Chat", icon: MessageSquare },
      { to: "/settings/diffs", label: "Diffs & pull requests", icon: FileDiff },
      { to: "/settings/keybindings", label: "Keybindings", icon: Keyboard },
    ],
  },
  {
    title: "Agents",
    items: [{ to: "/settings/providers", label: "Providers", icon: Bot }],
  },
  {
    title: "Code",
    items: [{ to: "/settings/projects", label: "Projects", icon: FolderTree }],
  },
  {
    title: "Advanced",
    items: [
      { to: "/settings/diagnostics", label: "Diagnostics", icon: HeartPulse },
      { to: "/settings/about", label: "About", icon: Info },
    ],
  },
];

/** Two-pane settings shell (§6.4: nav left, content right). */
export function SettingsLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const activeLabel = NAV_GROUPS.flatMap((group) => group.items).find(
    (item) => item.to === pathname,
  )?.label;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const filter = query.trim().toLowerCase();
  const groups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.label.toLowerCase().includes(filter)),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RouteHeader title="Settings" subtitle={activeLabel} />
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Settings"
          className="flex w-60 shrink-0 flex-col border-r border-border-subtle bg-canvas px-2 py-3"
        >
          <div className="relative mb-2 px-1">
            <Search
              size={13}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-tertiary"
            />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
              aria-label="Search settings"
              className="h-8 w-full rounded-(--radius-sm) border border-border-subtle bg-surface pr-7 pl-7 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-strong focus:outline-none"
            />
            <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border border-border-subtle px-1 text-xs text-text-tertiary">
              /
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {groups.length === 0 && (
              <p className="px-2 py-3 text-xs text-text-tertiary">Nothing matches “{query}”.</p>
            )}
            {groups.map((group, index) => (
              <div key={group.title ?? `group-${index}`} className="mb-1">
                {group.title && (
                  <p className="px-2 pt-2 pb-1 text-xs font-semibold tracking-wider text-text-tertiary">
                    {group.title}
                  </p>
                )}
                {group.items.map(({ to, label, icon: Icon }) => (
                  <Link
                    key={to}
                    to={to}
                    aria-current={pathname === to ? "page" : undefined}
                    className={`mb-0.5 flex items-center gap-2 rounded-(--radius-sm) px-2 py-1.5 text-sm transition ${
                      pathname === to
                        ? "bg-active text-text-primary"
                        : "text-text-secondary hover:bg-hover"
                    }`}
                  >
                    <Icon size={15} className="text-text-tertiary" />
                    {label}
                  </Link>
                ))}
              </div>
            ))}
          </div>

          <div className="border-t border-border-subtle px-1 pt-2">
            <Link
              to="/settings/general"
              className="flex items-center gap-2 rounded-(--radius-sm) px-1 py-1 text-text-secondary transition hover:bg-hover"
            >
              <span
                aria-hidden
                className="flex h-6 w-6 items-center justify-center rounded-full bg-active text-xs font-semibold text-text-secondary"
              >
                P
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-text-primary">Local user</span>
                <span className="block truncate text-xs text-text-tertiary">On this computer</span>
              </span>
            </Link>
          </div>
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto p-6">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
