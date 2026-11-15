import { Outlet, createFileRoute, Link, useRouterState } from "@tanstack/react-router";
import { Bot, HeartPulse, Keyboard, Palette, Info } from "lucide-react";
import { RouteHeader } from "../components/layout/WindowChrome";

export const Route = createFileRoute("/settings")({ component: SettingsLayout });

/** Two-pane settings shell (§6.4: nav left, content right). */
export function SettingsLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const NAV: { to: string; label: string; icon: typeof Bot }[] = [
    { to: "/settings/appearance", label: "Appearance", icon: Palette },
    { to: "/settings/providers", label: "Providers", icon: Bot },
    { to: "/settings/keybindings", label: "Keybindings", icon: Keyboard },
    { to: "/settings/diagnostics", label: "Diagnostics", icon: HeartPulse },
    { to: "/settings/about", label: "About", icon: Info },
  ];
  const activeLabel = NAV.find((item) => item.to === pathname)?.label;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RouteHeader title="Settings" subtitle={activeLabel} />
      <div className="flex min-h-0 flex-1">
        <nav
          aria-label="Settings"
          className="w-56 shrink-0 border-r border-border-subtle bg-canvas px-2 py-4"
        >
          <p className="px-2 pb-2 text-xs font-semibold tracking-wider text-text-tertiary uppercase">
            Settings
          </p>
          {NAV.map(({ to, label, icon: Icon }) => (
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
        </nav>
        <div className="min-w-0 flex-1 overflow-y-auto p-6">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
