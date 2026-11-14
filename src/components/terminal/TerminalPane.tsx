import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { terminalPtyResize, terminalPtyWrite } from "../../lib/ipc";
import { useTerminalsStore } from "../../stores/terminals";

function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * One live xterm.js pane wired to a backend PTY: user input goes out as
 * base64 (`terminal_pty_write`), output streams in via the terminals store
 * (coalesced backend events; buffered chunks replay on attach). ConPTY's
 * session-start cursor-position request is answered HERE through the same
 * write path — xterm knows the true cursor position.
 */
export function TerminalPane({ terminalId }: { terminalId: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new XTerm({
      fontFamily: "Katagami Mono, ui-monospace, monospace",
      fontSize: 12,
      cursorBlink: true,
      scrollback: 5000,
      convertEol: false,
      theme: {
        background: "#0a0a0a",
        foreground: "#f5f5f5",
        cursor: "#f5f5f5",
        selectionBackground: "#346bf166",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    // font-display: swap means the first measure can use a fallback face;
    // re-fit once Katagami Mono is actually available.
    const refit = () => {
      try {
        fit.fit();
      } catch {
        // terminal was disposed while the font loaded
      }
    };
    void document.fonts
      ?.load("12px Katagami Mono")
      .then(refit)
      .catch(() => {});

    // Replay chunks that arrived before the pane attached, then subscribe.
    for (const chunk of useTerminalsStore.getState().consumeBackfill(terminalId)) {
      term.write(chunk);
    }
    const unsubscribe = useTerminalsStore
      .getState()
      .subscribeData(terminalId, (data) => term.write(data));

    const sendResize = () => {
      void terminalPtyResize(terminalId, term.rows, term.cols).catch(() => {});
    };
    // Initial size + follow container resizes (panel width, maximization).
    sendResize();
    const observer = new ResizeObserver(() => {
      fit.fit();
    });
    observer.observe(host);
    const resizeSub = term.onResize(sendResize);

    term.onData((data) => {
      void terminalPtyWrite(terminalId, toBase64Utf8(data)).catch(() => {});
    });

    // Copy/paste: Ctrl+Shift+C copies, Ctrl+C copies when a selection
    // exists (otherwise the shell gets ^C), Ctrl+V pastes.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || !(event.ctrlKey || event.metaKey)) return true;
      const key = event.key.toLowerCase();
      if (key === "c" && (event.shiftKey || term.hasSelection())) {
        const selection = term.getSelection();
        if (selection) void navigator.clipboard.writeText(selection).catch(() => {});
        return false;
      }
      if (key === "v") {
        navigator.clipboard
          .readText()
          .then((text) => term.paste(text))
          .catch(() => {});
        return false;
      }
      return true;
    });

    term.focus();
    return () => {
      unsubscribe();
      resizeSub.dispose();
      observer.disconnect();
      term.dispose();
    };
  }, [terminalId]);

  return (
    <div className="min-h-0 flex-1 overflow-hidden px-1 pb-1">
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}
