import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useT } from "../../lib/i18n";

const ALL_KEY = "pult-search";
const ACTIVE_KEY = "pult-search-active";

/** The Custom Highlight API is optional: absent engines just skip the paint. */
function highlightSupport(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

function clearHighlights() {
  if (!highlightSupport()) return;
  CSS.highlights.delete(ALL_KEY);
  CSS.highlights.delete(ACTIVE_KEY);
}

/** Reading-order text nodes, minus controls and surfaces that opt out. */
function searchableTextNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.data.trim()) continue;
    if (text.parentElement?.closest("button, [data-search-ignore]")) continue;
    nodes.push(text);
  }
  return nodes;
}

function findMatches(root: Node, query: string): Range[] {
  const needle = query.toLowerCase();
  const matches: Range[] = [];
  for (const node of searchableTextNodes(root)) {
    const haystack = node.data.toLowerCase();
    let at = haystack.indexOf(needle);
    while (at !== -1) {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      matches.push(range);
      at = haystack.indexOf(needle, at + needle.length);
    }
  }
  return matches;
}

/** Floating in-thread find bar: counts matches, paints them, walks them. */
export function ThreadSearchBar({
  containerRef,
  onClose,
}: {
  containerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Range[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const root = containerRef.current;
    const trimmed = query.trim();
    if (!root || !trimmed) {
      setMatches([]);
      setActiveIndex(0);
      return;
    }
    setMatches(findMatches(root, trimmed));
    setActiveIndex(0);
  }, [containerRef, query]);

  // Highlights follow the match set; every exit path clears them.
  useEffect(() => {
    if (!highlightSupport() || matches.length === 0) {
      clearHighlights();
      return;
    }
    CSS.highlights.set(ALL_KEY, new Highlight(...matches));
    const active = matches[Math.min(activeIndex, matches.length - 1)];
    if (active) CSS.highlights.set(ACTIVE_KEY, new Highlight(active));
    else CSS.highlights.delete(ACTIVE_KEY);
    return clearHighlights;
  }, [matches, activeIndex]);

  const current = matches.length === 0 ? 0 : Math.min(activeIndex, matches.length - 1);

  useEffect(() => {
    const range = matches[current];
    // The start container is a text node: its parent paints the line to centre on.
    const el = range?.startContainer.parentElement;
    el?.scrollIntoView?.({ block: "center", behavior: "smooth" });
  }, [matches, current]);

  const step = (delta: number) => {
    setActiveIndex((index) => {
      if (matches.length === 0) return 0;
      return (Math.min(index, matches.length - 1) + delta + matches.length) % matches.length;
    });
  };

  return (
    <div className="absolute top-3 right-10 z-20 flex items-center gap-1.5 rounded-(--radius-md) border border-border-strong bg-surface-raised px-2.5 py-1.5 shadow-lg">
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "Enter") {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          }
        }}
        aria-label={t("chat.search.label")}
        placeholder={t("chat.search.placeholder")}
        className="w-44 min-w-0 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
      />
      {query.trim() && (
        <span className="shrink-0 text-right text-xs whitespace-nowrap text-text-tertiary tabular-nums">
          {matches.length > 0
            ? t("chat.search.matches", { current: current + 1, total: matches.length })
            : t("chat.search.noMatches")}
        </span>
      )}
      <button
        type="button"
        aria-label={t("chat.search.previous")}
        onClick={() => step(-1)}
        disabled={matches.length === 0}
        className="flex size-6 shrink-0 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary disabled:opacity-40"
      >
        <ChevronUp size={13} />
      </button>
      <button
        type="button"
        aria-label={t("chat.search.next")}
        onClick={() => step(1)}
        disabled={matches.length === 0}
        className="flex size-6 shrink-0 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary disabled:opacity-40"
      >
        <ChevronDown size={13} />
      </button>
      <button
        type="button"
        aria-label={t("chat.search.close")}
        onClick={onClose}
        className="flex size-6 shrink-0 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
      >
        <X size={13} />
      </button>
    </div>
  );
}
