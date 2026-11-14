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
  const preview = ticks.find((tick) => tick.key === previewKey);
  return (
    <nav
      aria-label="Message history"
      className="pointer-events-none absolute top-1/2 right-4 z-10 -translate-y-1/2"
    >
      {preview && (
        <span className="pointer-events-none absolute top-1/2 right-5 max-w-[40ch] -translate-y-1/2 truncate rounded-(--radius-sm) border border-border-subtle bg-surface px-2 py-1 text-xs text-text-secondary shadow">
          {preview.label}
        </span>
      )}
      <div className="pointer-events-auto flex max-h-[70vh] flex-col items-end gap-1.5 overflow-y-auto py-2">
        {ticks.map((tick) => (
          <button
            key={tick.key}
            type="button"
            aria-label={tick.label}
            aria-current={activeKey === tick.key ? "location" : undefined}
            onClick={() => onJump(tick)}
            onMouseEnter={() => setPreviewKey(tick.key)}
            onMouseLeave={() => setPreviewKey((key) => (key === tick.key ? null : key))}
            onFocus={() => setPreviewKey(tick.key)}
            onBlur={() => setPreviewKey((key) => (key === tick.key ? null : key))}
            className={`h-0.5 shrink-0 rounded-full transition-all ${
              activeKey === tick.key
                ? "w-4 bg-accent"
                : "w-2.5 bg-text-tertiary/60 hover:w-4 hover:bg-accent"
            }`}
          />
        ))}
      </div>
    </nav>
  );
}
