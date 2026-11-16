import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { LivingAscii } from "../src/components/chat/LivingAscii";

interface DrawCall {
  glyph: string;
  x: number;
  y: number;
  fillStyle: string;
  globalAlpha: number;
}

function parseRgb(fillStyle: string): [number, number, number] {
  const match = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(fillStyle);
  if (!match) throw new Error(`Unexpected fillStyle: ${fillStyle}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

describe("LivingAscii", () => {
  let draws: DrawCall[] = [];
  let reducedMotion = true;
  let rafQueue: Array<{ id: number; cb: FrameRequestCallback }> = [];
  let nextRafId = 1;
  let getContextSpy: ReturnType<typeof vi.spyOn>;
  let rectSpy: ReturnType<typeof vi.spyOn>;
  let rafSpy: ReturnType<typeof vi.spyOn>;
  let cafSpy: ReturnType<typeof vi.spyOn>;
  let origMatchMedia: typeof window.matchMedia;
  let origResizeObserver: typeof globalThis.ResizeObserver;

  beforeEach(() => {
    draws = [];
    reducedMotion = true;
    rafQueue = [];
    nextRafId = 1;

    delete document.documentElement.dataset.theme;
    document.documentElement.style.setProperty("--accent", "#346bf1");

    origMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("prefers-reduced-motion") ? reducedMotion : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    origResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    } as never;

    rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 120,
      height: 80,
      top: 0,
      left: 0,
      right: 120,
      bottom: 80,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    getContextSpy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      const ctx = {
        fillStyle: "#000000",
        globalAlpha: 1,
        font: "",
        textBaseline: "top",
        clearRect: vi.fn(() => {
          draws = [];
        }),
        setTransform: vi.fn(),
        fillText: vi.fn((glyph: string, x: number, y: number) => {
          draws.push({
            glyph,
            x,
            y,
            fillStyle: String(ctx.fillStyle),
            globalAlpha: ctx.globalAlpha,
          });
        }),
      };
      return ctx as never;
    });

    rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      const id = nextRafId++;
      rafQueue.push({ id, cb });
      return id;
    });
    cafSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      rafQueue = rafQueue.filter((item) => item.id !== id);
    });
  });

  afterEach(() => {
    delete document.documentElement.dataset.theme;
    document.documentElement.style.removeProperty("--accent");
    window.matchMedia = origMatchMedia;
    globalThis.ResizeObserver = origResizeObserver;
    getContextSpy.mockRestore();
    rectSpy.mockRestore();
    rafSpy.mockRestore();
    cafSpy.mockRestore();
    vi.restoreAllMocks();
  });

  function stepFrame(nowMs: number) {
    const batch = rafQueue.splice(0, rafQueue.length);
    act(() => {
      for (const item of batch) item.cb(nowMs);
    });
  }

  it("renders idle base glyphs in neutral gray independent of theme and accent", () => {
    reducedMotion = true;

    // Dark theme with blue accent -> base glyphs remain gray [168, 168, 168]
    document.documentElement.style.setProperty("--accent", "#346bf1");
    const darkRender = render(<LivingAscii />);
    expect(draws.length).toBeGreaterThan(0);
    for (const call of draws) {
      expect(parseRgb(call.fillStyle)).toEqual([168, 168, 168]);
      expect(call.globalAlpha).toBeLessThanOrEqual(0.78);
    }
    darkRender.unmount();

    // Liquid theme with green accent -> base glyphs still neutral gray [168, 168, 168]
    document.documentElement.dataset.theme = "liquid";
    document.documentElement.style.setProperty("--accent", "#10b981");
    const liquidRender = render(<LivingAscii />);
    expect(draws.length).toBeGreaterThan(0);
    for (const call of draws) {
      expect(parseRgb(call.fillStyle)).toEqual([168, 168, 168]);
    }
    liquidRender.unmount();

    // Light theme -> base glyphs use darker neutral gray [110, 110, 110], independent of accent
    document.documentElement.dataset.theme = "light";
    document.documentElement.style.setProperty("--accent", "#e11d48");
    const lightRender = render(<LivingAscii />);
    expect(draws.length).toBeGreaterThan(0);
    for (const call of draws) {
      expect(parseRgb(call.fillStyle)).toEqual([110, 110, 110]);
    }
    lightRender.unmount();
  });

  it("tints active ripple/pulse glyphs with theme --accent and uses white for graphite, keeping alpha <= 0.78", () => {
    reducedMotion = false;
    vi.spyOn(performance, "now").mockReturnValue(1000);

    document.documentElement.style.setProperty("--accent", "#346bf1");
    const { container, unmount } = render(<LivingAscii />);
    const wrap = container.firstElementChild as HTMLElement;

    // Trigger pointer ripple + click bloom at (50, 40)
    fireEvent.pointerMove(window, { clientX: 50, clientY: 40 });
    fireEvent.click(wrap);

    // Advance past the 600ms pulse bloom ramp so glow is strong
    stepFrame(1600);
    expect(draws.length).toBeGreaterThan(0);

    const tintedBlue = draws.filter((d) => {
      const [r, g, b] = parseRgb(d.fillStyle);
      return b > r && b > g;
    });
    expect(tintedBlue.length).toBeGreaterThan(0);
    for (const call of draws) {
      expect(call.globalAlpha).toBeLessThanOrEqual(0.78);
    }

    // Switch to graphite theme: even with blue --accent in CSS, graphite effects use white [245, 245, 245]
    act(() => {
      document.documentElement.dataset.theme = "graphite";
    });
    // MutationObserver runs microtask; wait a tick and draw next frame
    return Promise.resolve().then(() => {
      stepFrame(1700);
      expect(draws.length).toBeGreaterThan(0);
      const whitened = draws.filter((d) => {
        const [r, g, b] = parseRgb(d.fillStyle);
        return r === g && g === b && r > 168;
      });
      expect(whitened.length).toBeGreaterThan(0);
      for (const call of draws) {
        const [r, g, b] = parseRgb(call.fillStyle);
        expect(r).toBe(g);
        expect(g).toBe(b);
        expect(call.globalAlpha).toBeLessThanOrEqual(0.78);
      }
      unmount();
    });
  });
});
