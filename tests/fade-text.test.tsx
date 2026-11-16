import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { FadeText } from "../src/components/ui/FadeText";

type ObserverEntry = {
  callback: ResizeObserverCallback;
  targets: Set<Element>;
  disconnected: boolean;
};

const observers: ObserverEntry[] = [];

class FakeResizeObserver {
  private entry: ObserverEntry;

  constructor(callback: ResizeObserverCallback) {
    this.entry = { callback, targets: new Set(), disconnected: false };
    observers.push(this.entry);
  }

  observe(target: Element) {
    this.entry.targets.add(target);
  }

  unobserve(target: Element) {
    this.entry.targets.delete(target);
  }

  disconnect() {
    this.entry.disconnected = true;
    this.entry.targets.clear();
  }
}

function triggerResize() {
  act(() => {
    for (const entry of observers) {
      if (entry.disconnected) continue;
      entry.callback([], {} as ResizeObserver);
    }
  });
}

describe("FadeText", () => {
  const original = globalThis.ResizeObserver;

  beforeEach(() => {
    observers.length = 0;
    globalThis.ResizeObserver = FakeResizeObserver as never;
  });

  afterEach(() => {
    globalThis.ResizeObserver = original;
    vi.restoreAllMocks();
  });

  it("adds fade-truncate only when scrollWidth > clientWidth + 1", () => {
    const { rerender } = render(<FadeText text="short" className="min-w-0" />);
    const span = screen.getByText("short");

    Object.defineProperty(span, "clientWidth", { value: 100, configurable: true });
    Object.defineProperty(span, "scrollWidth", { value: 50, configurable: true });
    rerender(<FadeText text="short2" className="min-w-0" />);
    expect(span).not.toHaveClass("fade-truncate");
    expect(span).toHaveClass("overflow-hidden", "whitespace-nowrap", "min-w-0");

    // 1px subpixel rounding tolerance must not trigger fade-truncate.
    Object.defineProperty(span, "scrollWidth", { value: 101, configurable: true });
    rerender(<FadeText text="edge case" className="min-w-0" />);
    expect(span).not.toHaveClass("fade-truncate");

    Object.defineProperty(span, "scrollWidth", { value: 102, configurable: true });
    rerender(<FadeText text="much longer text" className="min-w-0" />);
    expect(span).toHaveClass("fade-truncate", "overflow-hidden", "whitespace-nowrap", "min-w-0");

    Object.defineProperty(span, "scrollWidth", { value: 100, configurable: true });
    rerender(<FadeText text="fits again" className="min-w-0" />);
    expect(span).not.toHaveClass("fade-truncate");
    expect(span).toHaveClass("overflow-hidden", "whitespace-nowrap");
  });

  it("toggles fade-truncate dynamically via ResizeObserver and disconnects on unmount", () => {
    const { unmount } = render(<FadeText text="Sidebar project name" />);
    const span = screen.getByText("Sidebar project name");

    let clientWidth = 200;
    Object.defineProperty(span, "scrollWidth", { get: () => 140, configurable: true });
    Object.defineProperty(span, "clientWidth", { get: () => clientWidth, configurable: true });

    triggerResize();
    expect(span).not.toHaveClass("fade-truncate");

    clientWidth = 80;
    triggerResize();
    expect(span).toHaveClass("fade-truncate", "overflow-hidden", "whitespace-nowrap");

    clientWidth = 160;
    triggerResize();
    expect(span).not.toHaveClass("fade-truncate");
    expect(span).toHaveClass("overflow-hidden", "whitespace-nowrap");

    expect(observers.some((entry) => !entry.disconnected)).toBe(true);
    unmount();
    expect(observers.every((entry) => entry.disconnected)).toBe(true);
  });

  it("falls back cleanly when ResizeObserver is unavailable", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).ResizeObserver;
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(220);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(100);

    render(<FadeText text="Overflow without ResizeObserver" />);
    const span = screen.getByText("Overflow without ResizeObserver");

    expect(span).toHaveClass("fade-truncate", "overflow-hidden", "whitespace-nowrap");
  });
});
