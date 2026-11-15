import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

export interface VirtualItem {
  index: number;
  key: string;
  offsetTop: number;
  height: number;
}

export interface UseVirtualRowsOptions {
  count: number;
  getItemKey: (index: number) => string;
  scrollRef: RefObject<HTMLDivElement | null>;
  estimateHeight: (index: number) => number;
  overscan?: number;
  /** JSDOM has no layout; this keeps the first slice mounted. */
  fallbackViewportHeight?: number;
}

/** Fixed-list virtualizer with dynamic row measurement (ResizeObserver). */
export function useVirtualRows({
  count,
  getItemKey,
  scrollRef,
  estimateHeight,
  overscan = 4,
  fallbackViewportHeight = 600,
}: UseVirtualRowsOptions) {
  const heights = useRef(new Map<string, number>());
  const elements = useRef(new Map<string, HTMLElement>());
  const observer = useRef<ResizeObserver | null>(null);
  const keyByElement = useRef(new WeakMap<Element, string>());
  const [, forceRender] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(fallbackViewportHeight);

  const estimateRef = useRef(estimateHeight);
  estimateRef.current = estimateHeight;
  const keyRef = useRef(getItemKey);
  keyRef.current = getItemKey;

  useEffect(
    () => () => {
      observer.current?.disconnect();
      observer.current = null;
    },
    [],
  );

  const applyHeight = useCallback(
    (key: string, next: number) => {
      if (next <= 0) return;
      let index = -1;
      for (let i = 0; i < count; i += 1) {
        if (keyRef.current(i) === key) {
          index = i;
          break;
        }
      }
      if (index < 0) return;
      const previous = heights.current.get(key) ?? estimateRef.current(index);
      const delta = next - previous;
      if (Math.abs(delta) < 0.5) return;
      heights.current.set(key, next);

      const scrollElement = scrollRef.current;
      if (scrollElement) {
        let offset = 0;
        for (let i = 0; i < index; i += 1) {
          const itemKey = keyRef.current(i);
          offset += heights.current.get(itemKey) ?? estimateRef.current(i);
        }
        // A row above the viewport changed size: keep the visible content still.
        if (offset < scrollElement.scrollTop) {
          scrollElement.scrollTop += delta;
          setScrollTop(scrollElement.scrollTop);
        }
      }
      forceRender((value) => value + 1);
    },
    [count, scrollRef],
  );
  // The observer is created once; it must always call the current closure
  // (count/rows change when directories expand).
  const applyHeightRef = useRef(applyHeight);
  applyHeightRef.current = applyHeight;

  const measureElement = useCallback(
    (key: string, element: HTMLElement | null) => {
      if (!element) {
        const previous = elements.current.get(key);
        if (previous) observer.current?.unobserve(previous);
        elements.current.delete(key);
        return;
      }
      elements.current.set(key, element);
      keyByElement.current.set(element, key);

      if (typeof ResizeObserver !== "undefined" && !observer.current) {
        observer.current = new ResizeObserver((entries) => {
          for (const entry of entries) {
            const entryKey = keyByElement.current.get(entry.target);
            if (entryKey) {
              applyHeightRef.current(
                entryKey,
                (entry.target as HTMLElement).getBoundingClientRect().height,
              );
            }
          }
        });
      }
      observer.current?.observe(element);
      applyHeight(key, element.getBoundingClientRect().height);
    },
    [applyHeight],
  );

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    setScrollTop(element.scrollTop);
    if (element.clientHeight > 0) setViewportHeight(element.clientHeight);
  }, [scrollRef]);

  const keys: string[] = [];
  const rowHeights: number[] = [];
  const offsets: number[] = [];
  let totalHeight = 0;
  for (let i = 0; i < count; i += 1) {
    const key = keyRef.current(i);
    keys.push(key);
    const height = heights.current.get(key) ?? estimateRef.current(i);
    rowHeights.push(height);
    offsets.push(totalHeight);
    totalHeight += height;
  }

  // First item whose offset is below the viewport bottom.
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (offsets[mid] < scrollTop + viewportHeight) low = mid + 1;
    else high = mid;
  }
  const end = Math.min(count, low + overscan);
  let start = 0;
  while (start < end && offsets[start] + rowHeights[start] <= scrollTop) start += 1;
  start = Math.max(0, start - overscan);

  const virtualItems: VirtualItem[] = [];
  for (let i = start; i < end; i += 1) {
    virtualItems.push({
      index: i,
      key: keys[i],
      offsetTop: offsets[i],
      height: rowHeights[i],
    });
  }

  return { totalHeight, virtualItems, measureElement, onScroll };
}
