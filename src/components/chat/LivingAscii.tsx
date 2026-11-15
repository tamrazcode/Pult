import { useEffect, useRef } from "react";
import { cellBrightness, cellGlyph, type Ripple } from "../../lib/asciiWave";

const CELL_W = 10;
const CELL_H = 16;
const FPS = 30;
const FRAME_MS = 1000 / FPS;

/**
 * T3-like living ASCII backdrop: theme-colored, brighter than the old static
 * texture, with a smooth uneven ripple that follows the pointer and a stronger
 * pulse on background clicks. Canvas keeps 2k+ glyphs at 30 fps cheaply.
 */
export function LivingAscii() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<Ripple | null>(null);
  const pulsesRef = useRef<Ripple[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let cols = 0;
    let rows = 0;
    let accent = "#346bf1";
    let frame = 0;
    let last = 0;
    let stopped = false;

    const readAccent = () => {
      const value = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
      if (value) accent = value;
    };

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(width / CELL_W);
      rows = Math.ceil(height / CELL_H);
      readAccent();
    };

    const draw = (now: number) => {
      ctx.clearRect(0, 0, width, height);
      ctx.font = `11px "JetBrains Mono", ui-monospace, monospace`;
      ctx.textBaseline = "top";
      ctx.fillStyle = accent;
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const x = col * CELL_W + CELL_W / 2;
          const y = row * CELL_H;
          const brightness = cellBrightness(x, y, now, pointerRef.current, pulsesRef.current);
          const glyph = cellGlyph(col, row, brightness);
          if (glyph === " ") continue;
          ctx.globalAlpha = Math.min(0.9, 0.12 + brightness * 1.25);
          ctx.fillText(glyph, x - CELL_W / 2, y);
        }
      }
      ctx.globalAlpha = 1;
    };

    const loop = (now: number) => {
      if (stopped) return;
      frame = requestAnimationFrame(loop);
      if (now - last < FRAME_MS) return;
      last = now;
      pulsesRef.current = pulsesRef.current.filter((pulse) => now - pulse.startedAt < 1400);
      draw(now);
    };

    resize();
    if (reduced) {
      draw(performance.now());
      return;
    }
    frame = requestAnimationFrame(loop);

    const onPointer = (event: PointerEvent) => {
      const rect = wrap.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (x < 0 || y < 0 || x > width || y > height) return;
      const previous = pointerRef.current;
      pointerRef.current = {
        x,
        y,
        startedAt: event.timeStamp,
        strength: Math.min(1, (previous?.strength ?? 0.6) + 0.25),
      };
    };
    const onLeave = () => {
      pointerRef.current = null;
    };
    const onClick = (event: MouseEvent) => {
      if (event.target !== wrap) return;
      const rect = wrap.getBoundingClientRect();
      pulsesRef.current.push({
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        startedAt: performance.now(),
        strength: 1,
      });
    };
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(frame);
      } else {
        last = 0;
        frame = requestAnimationFrame(loop);
      }
    };

    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    window.addEventListener("pointermove", onPointer, { passive: true });
    wrap.addEventListener("pointerleave", onLeave);
    wrap.addEventListener("click", onClick);
    document.addEventListener("visibilitychange", onVisibility);
    const themeObserver = new MutationObserver(readAccent);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      themeObserver.disconnect();
      window.removeEventListener("pointermove", onPointer);
      wrap.removeEventListener("pointerleave", onLeave);
      wrap.removeEventListener("click", onClick);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return (
    <div ref={wrapRef} aria-hidden className="absolute inset-0 overflow-hidden">
      <canvas ref={canvasRef} className="pointer-events-none h-full w-full" />
    </div>
  );
}
