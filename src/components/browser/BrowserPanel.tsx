import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from "lucide-react";
import {
  browserHistory,
  browserNavigate,
  browserSetBounds,
  browserState,
  onBrowserNavigated,
  openExternalUrl,
} from "../../lib/ipc";
import { isTauri } from "../../lib/tauri";
import { localizeIpcError, useT } from "../../lib/i18n";
import { useRunsStore } from "../../stores/runs";
import { useUiStore } from "../../stores/ui";

// Remembers the human-readable address across surface switches (the native
// webview outlives this component).
let lastInput = "";

/**
 * T3-style preview surface backed by a native child Webview. A real browser
 * context means no X-Frame-Options/CSP blocks; local files are served from a
 * token-scoped loopback server so ES modules and relative assets just work.
 */
export function BrowserPanel({ threadId }: { threadId: string | null }) {
  const t = useT();
  const [input, setInput] = useState("");
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const browserTarget = useUiStore((s) => s.browserTarget);
  const paletteOpen = useUiStore((s) => s.paletteOpen);
  const imagePreview = useUiStore((s) => s.imagePreview);
  const rightPanelOpen = useUiStore((s) => s.rightPanelOpen);
  const rightPanelTab = useUiStore((s) => s.rightPanelTab);
  const elicitation = useRunsStore((s) => s.activeElicitation);
  const hostRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(isTauri());

  // The native webview is a separate HWND: it paints over HTML/CSS, so it must
  // be hidden whenever a modal, the palette, a menu or another surface owns
  // the screen.
  const occluded =
    !isTauri() ||
    !rightPanelOpen ||
    rightPanelTab !== "browser" ||
    paletteOpen ||
    Boolean(imagePreview) ||
    Boolean(elicitation);

  const navigate = async (raw: string) => {
    const target = raw.trim();
    if (!target) return;
    if (!isTauri()) {
      setError(t("panels.browser.desktopOnly"));
      return;
    }
    setError(null);
    try {
      const url = await browserNavigate(target, threadId);
      lastInput = target;
      setInput(target);
      setCurrent(url);
      setReady(true);
    } catch (err) {
      setError(localizeIpcError(err));
    }
  };

  useEffect(() => {
    const target = useUiStore.getState().browserTarget;
    if (!target) return;
    useUiStore.getState().setBrowserTarget(null);
    void navigate(target);
    // The queued target is consumed once per click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserTarget]);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let unlisten: (() => void) | null = null;
    void onBrowserNavigated(({ url, event }) => {
      if (!alive || event !== "finished") return;
      // Token-scoped loopback URLs are an implementation detail; keep the
      // user's own path in the address bar.
      if (/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) return;
      setInput(url);
      setCurrent(url);
    }).then((off) => {
      if (!alive) off();
      else unlisten = off;
    });
    return () => {
      alive = false;
      unlisten?.();
      unlisten = null;
    };
  }, []);

  // Keep the child webview glued to the host div and hide it under overlays.
  // The native HWND paints over the WebView2 host, so DOM dialogs/menus must
  // hide it even when they belong to a different component.
  useEffect(() => {
    if (!isTauri()) return;
    const element = hostRef.current;
    if (!element) return;
    let frame = 0;
    let overlayOpen = false;
    let lastKey = "";
    const hasOverlay = () =>
      document.querySelector('[role="dialog"], [role="menu"], [data-escape-layer]') !== null;
    const apply = () => {
      frame = 0;
      const rect = element.getBoundingClientRect();
      const visible = !occluded && !overlayOpen && current !== null;
      const key = `${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(
        rect.width,
      )}:${Math.round(rect.height)}:${visible}`;
      if (key === lastKey) return;
      lastKey = key;
      void browserSetBounds({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible,
      }).catch(() => {});
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(apply);
    };
    overlayOpen = hasOverlay();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(element);
    // Menus/dialogs are mounted elsewhere: watch their presence, not every
    // streamed token. Attribute changes cover late role="dialog" mounts.
    const mutations =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver(() => {
            const next = hasOverlay();
            if (next === overlayOpen) return;
            overlayOpen = next;
            lastKey = "";
            schedule();
          });
    mutations?.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["role"],
    });
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      observer?.disconnect();
      mutations?.disconnect();
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
      void browserSetBounds({ x: 0, y: 0, width: 1, height: 1, visible: false }).catch(() => {});
    };
  }, [occluded, current]);

  // The webview survives panel switches; restore its page and address.
  useEffect(() => {
    if (!isTauri()) return;
    void browserState()
      .then((url) => {
        if (!url) return;
        setCurrent(url);
        setInput(/^http:\/\/127\.0\.0\.1:\d+\//.test(url) ? lastInput || url : url);
      })
      .catch(() => {});
  }, []);

  const openExternal = () => {
    if (!current || !/^https?:\/\//i.test(current)) return;
    void openExternalUrl(current).catch((err) => setError(localizeIpcError(err)));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex items-center gap-1 border-b border-border-subtle px-2 py-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          void navigate(input);
        }}
      >
        <button
          type="button"
          aria-label={t("panels.browser.back")}
          title={t("panels.browser.back")}
          onClick={() => void browserHistory("back").catch(() => {})}
          className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover disabled:opacity-40"
        >
          <ArrowLeft size={13} />
        </button>
        <button
          type="button"
          aria-label={t("panels.browser.forward")}
          title={t("panels.browser.forward")}
          onClick={() => void browserHistory("forward").catch(() => {})}
          className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover disabled:opacity-40"
        >
          <ArrowRight size={13} />
        </button>
        <button
          type="button"
          aria-label={t("panels.browser.reload")}
          title={t("panels.browser.reload")}
          onClick={() => void browserHistory("reload").catch(() => {})}
          className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover disabled:opacity-40"
        >
          <RotateCw size={13} />
        </button>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={t("panels.browser.placeholder")}
          aria-label={t("panels.browser.url")}
          className="h-7 min-w-0 flex-1 rounded-(--radius-sm) border border-border-subtle bg-surface px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-strong focus:outline-none"
        />
        <button
          type="button"
          aria-label={t("panels.browser.openExternally")}
          title={t("panels.browser.openExternal")}
          disabled={!current || !/^https?:\/\//i.test(current)}
          onClick={openExternal}
          className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover disabled:opacity-40"
        >
          <ExternalLink size={13} />
        </button>
      </form>

      {error && (
        <p
          role="alert"
          className="m-3 rounded-(--radius-md) border border-danger/40 px-3 py-2 text-xs text-danger"
        >
          {error}
        </p>
      )}

      <div className="relative min-h-0 flex-1">
        {/* The native webview is positioned over this box; the placeholder
            shows through only while nothing is open. */}
        <div ref={hostRef} className="absolute inset-0" />
        {!current && !error && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
            <p className="max-w-xs text-center text-xs text-text-tertiary">
              {ready ? t("panels.browser.hint") : t("panels.browser.desktopOnly")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
