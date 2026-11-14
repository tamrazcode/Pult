import { useCallback, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent } from "react";

interface Props {
  /** Current panel width in px. */
  value: number;
  min: number;
  max: number;
  /** Which edge of the panel the handle sits on. */
  side: "left" | "right";
  onResize: (width: number) => void;
  /** Fired on pointer-up / keyboard change — the moment to persist. */
  onCommit: (width: number) => void;
  label: string;
}

const KEY_STEP = 24;

/**
 * Drag separator between panes (§6.1 "resizable"): pointer-driven with a
 * keyboard path (focus + Left/Right, Home/End) so the layout is adjustable
 * without a mouse. The handle is invisible until hovered or focused.
 */
export function ResizeHandle({ value, min, max, side, onResize, onCommit, label }: Props) {
  const [dragging, setDragging] = useState(false);
  const lastX = useRef<number | null>(null);

  const clamp = useCallback(
    (width: number) => Math.min(max, Math.max(min, Math.round(width))),
    [min, max],
  );

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    lastX.current = e.clientX;
    setDragging(true);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging || lastX.current === null) return;
    const delta = e.clientX - lastX.current;
    lastX.current = e.clientX;
    // Left-side handle grows the panel when dragged left (delta negative).
    onResize(clamp(value + (side === "right" ? delta : -delta)));
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    lastX.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    onCommit(value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      const dir = e.key === "ArrowLeft" ? -1 : 1;
      const next = clamp(value + dir * KEY_STEP * (side === "right" ? 1 : -1));
      e.preventDefault();
      onResize(next);
      onCommit(next);
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      onResize(min);
      onCommit(min);
      return;
    }
    if (e.key === "End") {
      e.preventDefault();
      onResize(max);
      onCommit(max);
    }
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      className={`group relative z-30 w-1 shrink-0 cursor-col-resize bg-transparent transition-colors duration-150 hover:bg-accent/40 focus-visible:bg-accent/60 focus-visible:outline-none ${
        dragging ? "bg-accent/60" : ""
      }`}
      title="Drag to resize"
    />
  );
}
