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
  Puzzle,
  Search,
  Settings2,
  UserRound,
} from "lucide-react";
import { RouteHeader } from "../components/layout/WindowChrome";
import { ProfileAvatar } from "../components/profile/ProfileCard";
import { useT } from "../lib/i18n";
import { useSettingsStore } from "../stores/settings";

export const Route = createFileRoute("/settings")({ component: SettingsLayout });

interface NavItem {
  to: string;
  labelKey: string;
  icon: typeof Bot;
}

const NAV_GROUPS: { titleKey?: string; items: NavItem[] }[] = [
  {
    items: [
      { to: "/settings/profile", labelKey: "settings.nav.profile", icon: UserRound },
      { to: "/settings/general", labelKey: "settings.nav.general", icon: Settings2 },
      { to: "/settings/appearance", labelKey: "settings.nav.appearance", icon: Palette },
      { to: "/settings/chat", labelKey: "settings.nav.chat", icon: MessageSquare },
      { to: "/settings/diffs", labelKey: "settings.nav.diffs", icon: FileDiff },
      { to: "/settings/keybindings", labelKey: "settings.nav.keybindings", icon: Keyboard },
    ],
  },
  {
    titleKey: "settings.nav.agents",
    items: [{ to: "/settings/providers", labelKey: "settings.nav.providers", icon: Bot }],
  },
  {
    titleKey: "settings.nav.code",
    items: [
      { to: "/settings/projects", labelKey: "settings.nav.projects", icon: FolderTree },
      { to: "/settings/plugins", labelKey: "settings.nav.plugins", icon: Puzzle },
    ],
  },
  {
    titleKey: "settings.nav.advanced",
    items: [
      { to: "/settings/diagnostics", labelKey: "settings.nav.diagnostics", icon: HeartPulse },
      { to: "/settings/about", labelKey: "settings.nav.about", icon: Info },
    ],
  },
];

/** Two-pane settings shell (§6.4: nav left, content right). */
export function SettingsLayout() {
  const t = useT();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const activeItem = NAV_GROUPS.flatMap((group) => group.items).find(
    (item) => item.to === pathname,
  );
  const profile = useSettingsStore((s) => s.profile);

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
    items: group.items.filter((item) => t(item.labelKey).toLowerCase().includes(filter)),
  })).filter((group) => group.items.length > 0);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RouteHeader
        title={t("settings.title")}
        subtitle={activeItem ? t(activeItem.labelKey) : undefined}
      />
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={t("settings.title")}
          className="flex w-48 shrink-0 flex-col border-r border-border-subtle bg-canvas px-2 py-4 min-[1120px]:w-60 min-[1120px]:px-3"
        >
          <div className="relative mb-3 px-0">
            <Search
              size={13}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-tertiary"
            />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("common.search")}
              aria-label={t("settings.search")}
              className="h-8 w-full rounded-(--radius-sm) border border-border-subtle bg-surface pr-7 pl-7 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-strong focus:outline-none"
            />
            <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border border-border-subtle px-1 text-xs text-text-tertiary">
              /
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {groups.length === 0 && (
              <p className="px-2 py-3 text-xs text-text-tertiary">
                {t("settings.nothingMatches", { query })}
              </p>
            )}
            {groups.map((group, index) => (
              <div key={group.titleKey ?? `group-${index}`} className="mb-2">
                {group.titleKey && (
                  <p className="px-2 pt-2 pb-1 text-xs font-semibold tracking-wider text-text-tertiary">
                    {t(group.titleKey)}
                  </p>
                )}
                {group.items.map(({ to, labelKey, icon: Icon }) => (
                  <Link
                    key={to}
                    to={to}
                    aria-current={pathname === to ? "page" : undefined}
                    className={`mb-1 flex items-center gap-2 rounded-(--radius-sm) px-3 py-2 text-sm transition ${
                      pathname === to
                        ? "bg-active text-text-primary"
                        : "text-text-secondary hover:bg-hover"
                    }`}
                  >
                    <Icon size={15} className="text-text-tertiary" />
                    {t(labelKey)}
                  </Link>
                ))}
              </div>
            ))}
          </div>

          <div className="border-t border-border-subtle px-1 pt-2">
            <Link
              to="/settings/profile"
              className="flex items-center gap-2 rounded-(--radius-sm) px-1 py-1 text-text-secondary transition hover:bg-hover"
            >
              {profile ? (
                <ProfileAvatar profile={profile} size={24} />
              ) : (
                <span
                  aria-hidden
                  className="flex h-6 w-6 items-center justify-center rounded-full bg-active text-xs font-semibold text-text-secondary"
                >
                  P
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-text-primary">
                  {profile?.nickname ?? t("settings.footer.localUser")}
                </span>
                <span className="block truncate text-xs text-text-tertiary">
                  {profile ? `@${profile.handle}` : t("settings.footer.onThisComputer")}
                </span>
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
