import { describe, expect, it } from "vitest";
import { useRef } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useVirtualRows } from "../src/components/diff/useVirtualRows";

type Api = {
  measureElement: (key: string, el: HTMLElement | null) => void;
  virtualItems: { index: number; key: string; offsetTop: number; height: number }[];
  totalHeight: number;
};

function Harness({ api, count = 50 }: { api: { current: Api | null }; count?: number }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualRows({
    count,
    getItemKey: (index) => `row-${index}`,
    scrollRef,
    estimateHeight: () => 34,
    fallbackViewportHeight: 600,
  });
  api.current = virtualizer;
  return (
    <div
      ref={scrollRef}
      data-testid="scroll"
      style={{ height: 600, overflow: "auto" }}
      onScroll={virtualizer.onScroll}
    >
      <div style={{ height: virtualizer.totalHeight, position: "relative" }}>
        {virtualizer.virtualItems.map((item) => (
          <div
            key={item.key}
            ref={(el) => virtualizer.measureElement(item.key, el)}
            data-row={item.key}
            style={{ position: "absolute", top: item.offsetTop, height: item.height }}
          >
            {item.index}
          </div>
        ))}
      </div>
    </div>
  );
}

describe("useVirtualRows", () => {
  it("measures dynamic heights, anchors scroll, and slices on scroll", () => {
    const api: { current: Api | null } = { current: null };
    render(<Harness api={api} />);

    expect(api.current?.totalHeight).toBe(1700);
    expect(api.current?.virtualItems.length).toBeLessThan(30);

    const row5 = screen.getByText("5");
    row5.getBoundingClientRect = () =>
      ({
        height: 400,
        width: 100,
        top: 0,
        left: 0,
        bottom: 400,
        right: 100,
        x: 0,
        y: 0,
      }) as DOMRect;
    act(() => api.current?.measureElement("row-5", row5));
    expect(api.current?.totalHeight).toBe(2066);
    const row6 = api.current?.virtualItems.find((item) => item.index === 6);
    expect(row6?.offsetTop).toBe(570);

    const scroll = screen.getByTestId("scroll");
    scroll.scrollTop = 500;
    fireEvent.scroll(scroll);
    const row2 = screen.getByText("2");
    row2.getBoundingClientRect = () =>
      ({
        height: 200,
        width: 100,
        top: 0,
        left: 0,
        bottom: 200,
        right: 100,
        x: 0,
        y: 0,
      }) as DOMRect;
    act(() => api.current?.measureElement("row-2", row2));
    expect(scroll.scrollTop).toBe(666);

    scroll.scrollTop = 2000;
    fireEvent.scroll(scroll);
    expect(api.current?.virtualItems[0].index).toBeGreaterThan(0);
  });

  it("measures rows added after the list grew through the ResizeObserver", () => {
    const instances: Array<(entries: Array<{ target: Element }>) => void> = [];
    class FakeResizeObserver {
      constructor(cb: (entries: Array<{ target: Element }>) => void) {
        instances.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = FakeResizeObserver as never;

    try {
      const api: { current: Api | null } = { current: null };
      const { rerender } = render(<Harness api={api} />);
      const row5 = document.createElement("div");
      row5.getBoundingClientRect = () =>
        ({
          height: 34,
          width: 100,
          top: 0,
          left: 0,
          bottom: 34,
          right: 100,
          x: 0,
          y: 0,
        }) as DOMRect;
      act(() => api.current?.measureElement("row-5", row5));
      expect(api.current?.totalHeight).toBe(1700);

      rerender(<Harness api={api} count={60} />);
      const row55 = document.createElement("div");
      row55.getBoundingClientRect = () =>
        ({
          height: 34,
          width: 100,
          top: 0,
          left: 0,
          bottom: 34,
          right: 100,
          x: 0,
          y: 0,
        }) as DOMRect;
      act(() => api.current?.measureElement("row-55", row55));
      expect(api.current?.totalHeight).toBe(60 * 34);

      row55.getBoundingClientRect = () =>
        ({
          height: 400,
          width: 100,
          top: 0,
          left: 0,
          bottom: 400,
          right: 100,
          x: 0,
          y: 0,
        }) as DOMRect;
      act(() => instances[0]([{ target: row55 }]));
      expect(api.current?.totalHeight).toBe(60 * 34 - 34 + 400);

      row55.getBoundingClientRect = () =>
        ({
          height: 34,
          width: 100,
          top: 0,
          left: 0,
          bottom: 34,
          right: 100,
          x: 0,
          y: 0,
        }) as DOMRect;
      act(() => instances[0]([{ target: row55 }]));
      expect(api.current?.totalHeight).toBe(60 * 34);
    } finally {
      globalThis.ResizeObserver = original;
    }
  });
});
