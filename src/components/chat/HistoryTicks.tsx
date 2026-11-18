import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";

export interface HistoryTick {
  key: string;
  label: string; // trimmed first 80 chars of user message
  globalIndex: number; // index in unwindowed merged timeline
}

/**
 * Keep the rail inside the viewport: preserve the first, last and active turn,
 * bucket the rest. Representatives keep their real `globalIndex`, so a jump
 * still lands on a user message.
 */
export function compressHistoryTicks(
  ticks: HistoryTick[],
  maxVisible: number,
  activeKey: string | null,
): HistoryTick[] {
  if (maxVisible <= 0 || ticks.length <= maxVisible) return ticks;
  const keep = new Set<number>([0, ticks.length - 1]);
  const activeIndex = ticks.findIndex((tick) => tick.key === activeKey);
  if (activeIndex >= 0) keep.add(activeIndex);
  const remaining = maxVisible - keep.size;
  if (remaining <= 0) {
    return [...keep]
      .sort((a, b) => a - b)
      .slice(0, Math.max(1, maxVisible))
      .map((index) => ticks[index]);
  }
  const pool = ticks.map((_, index) => index).filter((index) => !keep.has(index));
  const picked: number[] = [];
  for (let bucket = 0; bucket < remaining; bucket += 1) {
    const start = Math.floor((bucket * pool.length) / remaining);
    const end = Math.max(start + 1, Math.floor(((bucket + 1) * pool.length) / remaining));
    const slice = pool.slice(start, end);
    if (slice.length > 0) picked.push(slice[0]);
  }
  return [...keep, ...picked]
    .sort((a, b) => a - b)
    .slice(0, Math.max(1, maxVisible))
    .map((index) => ticks[index]);
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
  const t = useT();
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [available, setAvailable] = useState(() =>
    typeof window === "undefined" ? 480 : Math.floor(window.innerHeight * 0.7),
  );
  useEffect(() => {
    const update = () => setAvailable(Math.floor(window.innerHeight * 0.7));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  if (ticks.length === 0) return null;
  const maxVisible = Math.max(6, Math.floor((available - 16) / 13));
  const visible = compressHistoryTicks(ticks, maxVisible, activeKey);
  const preview = visible.find((tick) => tick.key === previewKey);
  return (
    <nav
      aria-label={t("chat.history.label")}
      className="pointer-events-none absolute top-1/2 right-4 z-10 -translate-y-1/2"
    >
      {preview && (
        <span className="pointer-events-none absolute top-1/2 right-5 max-w-[40ch] -translate-y-1/2 truncate rounded-(--radius-sm) border border-border-subtle bg-surface px-2 py-1 text-xs text-text-secondary shadow">
          {preview.label}
        </span>
      )}
      <div className="pointer-events-auto flex max-h-[70vh] flex-col items-end gap-px py-1">
        {visible.map((tick) => (
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
            className="group flex h-3 w-5 shrink-0 items-center justify-end"
          >
            <span
              className={`h-px rounded-full transition-all ${
                activeKey === tick.key
                  ? "w-3 bg-accent"
                  : "w-1.5 bg-text-tertiary/60 group-hover:w-3 group-hover:bg-accent"
              }`}
            />
          </button>
        ))}
      </div>
    </nav>
  );
}
