import { useState } from "react";

export interface HistoryTick {
  key: string;
  label: string; // trimmed first 80 chars of user message
  globalIndex: number; // index in unwindowed merged timeline
}

/**
 * Right-edge tick rail: one hairline per user message, expanding on hover.
 * Kept presentational — the scroll container owns windowing and jump state.
 */
export function HistoryTicks({
  ticks,
  activeKey,
  onJump,
}: {
  ticks: HistoryTick[];
  activeKey: string | null;
  onJump: (tick: HistoryTick) => void;
}) {
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  if (ticks.length === 0) return null;
  return (
    <div className="pointer-events-none absolute top-1/2 right-1.5 z-10 flex max-h-[70vh] -translate-y-1/2 flex-col items-end gap-1.5 overflow-y-auto py-2">
      {ticks.map((tick) => (
        <div key={tick.key} className="pointer-events-auto relative flex items-center">
          <button
            type="button"
            aria-label={tick.label}
            title={tick.label}
            onClick={() => onJump(tick)}
            onMouseEnter={() => setPreviewKey(tick.key)}
            onMouseLeave={() => setPreviewKey((key) => (key === tick.key ? null : key))}
            onFocus={() => setPreviewKey(tick.key)}
            onBlur={() => setPreviewKey((key) => (key === tick.key ? null : key))}
            className={`h-0.5 rounded-full transition-all ${
              activeKey === tick.key
                ? "w-4 bg-accent"
                : "w-2.5 bg-text-tertiary/60 hover:w-4 hover:bg-accent"
            }`}
          />
          {previewKey === tick.key && (
            <span className="absolute right-5 max-w-[40ch] truncate rounded-(--radius-sm) border border-border-subtle bg-surface px-2 py-1 text-xs text-text-secondary shadow">
              {tick.label}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
