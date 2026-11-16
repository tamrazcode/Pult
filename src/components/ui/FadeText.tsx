import { useEffect, useRef, useState } from "react";

/**
 * One-line text that fades out on the right only when it actually overflows.
 * ResizeObserver keeps the mask honest while the sidebar/panel is resized.
 */
export function FadeText({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const check = () => setOverflowing(element.scrollWidth > element.clientWidth + 1);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return (
    <span
      ref={ref}
      className={`block min-w-0 overflow-hidden whitespace-nowrap ${
        overflowing ? "fade-truncate" : ""
      } ${className ?? ""}`}
    >
      {text}
    </span>
  );
}
