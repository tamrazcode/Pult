import { useEffect, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Minus, PanelLeft, PanelRight, Square, X } from "lucide-react";
import { isTauri } from "../../lib/tauri";
import { useUiStore } from "../../stores/ui";

/** Panel toggles live in each route's single header (T3-style chrome). */
export function PanelToggleButtons(): ReactElement {
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleRightPanel = useUiStore((s) => s.toggleRightPanel);

  return (
    <>
      <HeaderToggle
        active={sidebarOpen}
        onClick={toggleSidebar}
        label="Toggle sidebar"
        icon={<PanelLeft size={15} />}
      />
      <HeaderToggle
        active={rightPanelOpen}
        onClick={toggleRightPanel}
        label="Toggle right panel"
        icon={<PanelRight size={15} />}
      />
    </>
  );
}

function HeaderToggle({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-(--radius-sm) transition-colors duration-150 ${
        active
          ? "bg-active text-text-primary"
          : "text-text-tertiary hover:bg-hover hover:text-text-secondary"
      }`}
    >
      {icon}
    </button>
  );
}

/** Native window buttons are only meaningful inside the Tauri shell. */
export function WindowControls(): ReactElement | null {
  return isTauri() ? <TauriWindowControls /> : null;
}

function TauriWindowControls() {
  const [maximized, setMaximized] = useState(false);
  const [win] = useState(() => {
    try {
      return getCurrentWindow();
    } catch {
      // Test shells can report isTauri without Tauri internals; hide chrome.
      return null;
    }
  });

  useEffect(() => {
    if (!win) return;
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

  if (!win) return null;

  const base =
    "flex h-10 w-11 shrink-0 items-center justify-center text-text-secondary transition-colors duration-150";
  return (
    <div className="flex h-10 items-center pl-1">
      <button
        type="button"
        aria-label="Minimize window"
        className={`${base} hover:bg-hover`}
        onClick={() => void win.minimize()}
      >
        <Minus size={15} />
      </button>
      <button
        type="button"
        aria-label={maximized ? "Restore window" : "Maximize window"}
        className={`${base} hover:bg-hover`}
        onClick={() => void win.toggleMaximize()}
      >
        {maximized ? <Copy size={13} /> : <Square size={12} />}
      </button>
      <button
        type="button"
        aria-label="Close window"
        className={`${base} hover:bg-danger hover:text-white`}
        onClick={() => void win.close()}
      >
        <X size={16} />
      </button>
    </div>
  );
}

/** One header for routes without a thread (settings, usage, welcome). */
export function RouteHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}): ReactElement {
  return (
    <header
      data-tauri-drag-region
      className="flex h-10 shrink-0 select-none items-center gap-2 border-b border-border-subtle bg-canvas pr-0 pl-4"
    >
      <h1 className="shrink-0 truncate text-base font-medium text-text-primary">{title}</h1>
      {subtitle && (
        <>
          <span aria-hidden className="shrink-0 text-text-tertiary">
            /
          </span>
          <span className="truncate text-sm text-text-secondary">{subtitle}</span>
        </>
      )}
      <div data-tauri-drag-region className="min-w-2 flex-1" />
      {actions}
      <PanelToggleButtons />
      <WindowControls />
    </header>
  );
}
