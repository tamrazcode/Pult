import { useEffect, useState } from "react";

/**
 * Dev FPS overlay (§6.5: "a dev FPS overlay behind a flag"). Off by default;
 * enable with `?fps=1` or `localStorage["pult.fps"] = "1"`. Shows rolling
 * FPS + worst frame time so the 60 fps streaming budget is measurable.
 */
export function FpsOverlay() {
  const [enabled, setEnabled] = useState(false);
  const [stats, setStats] = useState({ fps: 0, worst: 0 });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setEnabled(params.has("fps") || window.localStorage.getItem("pult.fps") === "1");
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let frames = 0;
    let windowStart = performance.now();
    let worst = 0;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const delta = now - last;
      last = now;
      frames += 1;
      if (delta > worst) worst = delta;
      if (now - windowStart >= 500) {
        const fps = Math.round((frames * 1000) / (now - windowStart));
        setStats({ fps, worst: Math.round(worst) });
        frames = 0;
        windowStart = now;
        worst = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div className="pointer-events-none fixed top-1 right-1 z-50 rounded-(--radius-sm) border border-border-strong bg-surface-raised/90 px-2 py-1 font-mono text-[10px] text-text-tertiary tnum">
      {stats.fps} fps · worst {stats.worst} ms
    </div>
  );
}
