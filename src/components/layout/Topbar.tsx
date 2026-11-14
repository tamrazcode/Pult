import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useRouter } from "@tanstack/react-router";
import { Copy, Minus, PanelLeft, PanelRight, Settings, Square, X } from "lucide-react";
import { useUiStore } from "../../stores/ui";
import { appVersion } from "../../lib/ipc";
import { isTauri } from "../../lib/tauri";

export function Topbar() {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const version = useUiStore((s) => s.appVersion);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);
  const setAppVersion = useUiStore((s) => s.setAppVersion);
  const router = useRouter();

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    appVersion()
      .then((v) => {
        if (!cancelled) setAppVersion(v);
      })
      .catch((err) => console.error("app_version failed", err));
    return () => {
      cancelled = true;
    };
  }, [setAppVersion]);

  return (
    <header
      data-tauri-drag-region
      className="flex h-12 shrink-0 select-none items-center gap-3 border-b border-border-subtle bg-chrome pr-0 pl-4"
    >
      {/* breadcrumbs "project / thread" — static for M0, wired to routes in M2 */}
      <div data-tauri-drag-region className="flex items-center gap-1.5 text-sm">
        <span className="font-semibold text-text-primary">pult</span>
        <span className="text-text-tertiary">/</span>
        <span className="text-text-secondary">chat</span>
      </div>

      <div data-tauri-drag-region className="flex-1" />

      {version && <span className="tnum text-xs text-text-tertiary">v{version}</span>}

      <button
        onClick={() => void router.navigate({ to: "/settings/appearance" })}
        title="Settings (Ctrl+,)"
        aria-label="Settings"
        className="flex h-8 w-8 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition-colors duration-150 hover:bg-hover hover:text-text-secondary"
      >
        <Settings size={15} />
      </button>
      <TopbarToggle active={sidebarOpen} onClick={toggleSidebar} label="Toggle sidebar">
        <PanelLeft size={15} />
      </TopbarToggle>
      <TopbarToggle active={rightPanelOpen} onClick={toggleRightPanel} label="Toggle right panel">
        <PanelRight size={15} />
      </TopbarToggle>

      {isTauri() && <WindowControls />}
    </header>
  );
}

function TopbarToggle({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`flex h-8 w-8 items-center justify-center rounded-(--radius-sm) transition-colors duration-150 ${
        active
          ? "bg-active text-text-primary"
          : "text-text-tertiary hover:bg-hover hover:text-text-secondary"
      }`}
    >
      {children}
    </button>
  );
}

function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const [win] = useState(() => getCurrentWindow());

  useEffect(() => {
    const unlistenPromise = win.onResized(async () => {
      try {
        setMaximized(await win.isMaximized());
      } catch {
        /* window gone */
      }
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [win]);

  const base =
    "flex h-12 w-11 items-center justify-center text-text-secondary transition-colors duration-150";
  return (
    <div className="ml-1 flex items-center">
      <button
        aria-label="Minimize window"
        className={`${base} hover:bg-hover`}
        onClick={() => void win.minimize()}
      >
        <Minus size={15} />
      </button>
      <button
        aria-label={maximized ? "Restore window" : "Maximize window"}
        className={`${base} hover:bg-hover`}
        onClick={() => void win.toggleMaximize()}
      >
        {maximized ? <Copy size={13} /> : <Square size={12} />}
      </button>
      <button
        aria-label="Close window"
        className={`${base} hover:bg-danger hover:text-white`}
        onClick={() => void win.close()}
      >
        <X size={16} />
      </button>
    </div>
  );
}
