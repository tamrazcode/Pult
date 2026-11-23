import { useRef, useState } from "react";
import { X } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { TerminalPanel } from "../terminal/TerminalPanel";

const MIN_HEIGHT = 150;
const MAX_HEIGHT = 420;
const DEFAULT_HEIGHT = 240;

/** Docked PTY under the chat; the top hairline drags its height. */
export function BottomTerminalDrawer({ threadId }: { threadId: string | null }) {
  const t = useT();
  const open = useUiStore((s) => s.bottomTerminalOpen);
  const setOpen = useUiStore((s) => s.setBottomTerminalOpen);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  if (!open) return null;

  const clamp = (value: number) => Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, value));

  return (
    <div
      data-bottom-terminal
      className="flex shrink-0 flex-col overflow-hidden border-t border-border-subtle"
      style={{ height }}
    >
      <div
        aria-hidden
        className="h-1 shrink-0 cursor-ns-resize touch-none hover:bg-accent/20"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { startY: event.clientY, startHeight: height };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag) return;
          setHeight(clamp(drag.startHeight + (drag.startY - event.clientY)));
        }}
        onPointerUp={(event) => {
          dragRef.current = null;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      />
      <div className="flex items-center justify-between px-2.5 pt-1 pb-0.5 text-xs text-text-secondary">
        <span className="truncate">{t("panels.terminal.bottomDrawer")}</span>
        <button
          type="button"
          aria-label={t("panels.terminal.closeDrawer")}
          title={t("panels.terminal.closeDrawer")}
          onClick={() => setOpen(false)}
          className="flex h-5 w-5 items-center justify-center text-text-tertiary transition hover:text-text-secondary"
        >
          <X size={11} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <TerminalPanel threadId={threadId} />
      </div>
    </div>
  );
}
