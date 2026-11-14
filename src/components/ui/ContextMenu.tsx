import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export interface ContextMenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  confirmLabel?: string; // two-step inline confirmation for Delete
  onSelect: () => void;
}

const ESTIMATED_WIDTH = 210;
const ROW_HEIGHT = 30;
const MARGIN = 8;

/**
 * Floating menu for right-click actions: viewport-clamped, outside-click and
 * scroll dismissible, keyboard navigable, with inline two-step confirmation.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: Array<ContextMenuItem | "separator">;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const rows = items.filter((item) => item !== "separator").length;

  const left = Math.max(MARGIN, Math.min(x, window.innerWidth - ESTIMATED_WIDTH - MARGIN));
  const top = Math.max(
    MARGIN,
    Math.min(y, window.innerHeight - Math.max(rows, 1) * ROW_HEIGHT - MARGIN),
  );

  useEffect(() => {
    const first = itemRefs.current.find((element) => element !== null);
    first?.focus();
  }, []);

  useEffect(() => {
    const onPointer = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  const enabled = items
    .map((item, index) => ({ item, index }))
    .filter(
      (entry): entry is { item: ContextMenuItem; index: number } =>
        entry.item !== "separator" && !entry.item.disabled,
    );

  const moveFocus = (from: HTMLElement, delta: 1 | -1) => {
    const buttons = enabled
      .map((entry) => itemRefs.current[entry.index])
      .filter((element): element is HTMLButtonElement => element !== null);
    if (buttons.length === 0) return;
    const index = buttons.indexOf(from as HTMLButtonElement);
    const next = (index + delta + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  const activate = (item: ContextMenuItem) => {
    if (item.disabled) return;
    if (item.confirmLabel && confirming !== item.id) {
      setConfirming(item.id);
      return;
    }
    item.onSelect();
    onClose();
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      data-escape-layer
      aria-label="Context menu"
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (event.target instanceof HTMLElement) {
            moveFocus(event.target, event.key === "ArrowDown" ? 1 : -1);
          }
        }
      }}
      className="fixed z-50 min-w-[200px] rounded-(--radius-md) border border-border-strong bg-surface-raised py-1 shadow-2xl"
      style={{ left, top }}
    >
      {items.map((item, index) => {
        if (item === "separator") {
          return (
            <div key={`sep-${index}`} role="separator" className="my-1 h-px bg-border-subtle" />
          );
        }
        const isConfirming = confirming === item.id;
        return (
          <button
            key={item.id}
            ref={(element) => {
              itemRefs.current[index] = element;
            }}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => activate(item)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                activate(item);
              }
            }}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition disabled:opacity-40 ${
              item.danger
                ? "text-danger hover:bg-danger/10"
                : "text-text-secondary hover:bg-hover hover:text-text-primary"
            }`}
          >
            {item.icon && <span className="shrink-0 text-text-tertiary">{item.icon}</span>}
            <span className="min-w-0 flex-1 truncate">
              {isConfirming ? item.confirmLabel : item.label}
            </span>
            {item.shortcut && !isConfirming && (
              <span className="shrink-0 text-[10px] text-text-tertiary">{item.shortcut}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
