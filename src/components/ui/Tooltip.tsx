import { useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * Styled label for icon-only controls (hover + keyboard focus). The native
 * `title` tooltip is too slow and cannot be themed, so every icon button that
 * has no visible text should be wrapped in this.
 */
export function Tooltip({
  label,
  children,
  align = "center",
}: {
  label: string;
  children: ReactNode;
  /** Right-align for controls at the panel edge so the label is not clipped. */
  align?: "center" | "right";
}) {
  const [open, setOpen] = useState(false);
  const timer = useRef<number | null>(null);

  const show = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOpen(true), 120);
  };
  const hide = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setOpen(false);
  };

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {open && (
        <span
          role="tooltip"
          className={`pointer-events-none absolute bottom-full z-50 mb-1.5 rounded-(--radius-sm) border border-border-strong bg-surface-raised px-2 py-0.5 text-xs whitespace-nowrap text-text-secondary shadow-(--shadow-composer) ${
            align === "right" ? "right-0" : "left-1/2 -translate-x-1/2"
          }`}
        >
          {label}
        </span>
      )}
    </span>
  );
}
