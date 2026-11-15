import { create } from "zustand";
import type { PtyInfo, PtyOutputPayload } from "../lib/types";

export interface PtyTerminal {
  terminalId: string;
  title: string;
  exit: number | null;
}

type DataListener = (data: string) => void;

interface TerminalsState {
  byThread: Record<string, PtyTerminal[]>;
  /** threadId → id of the terminal shown in the pane. */
  activeByThread: Record<string, string | null>;
  /**
   * Decoded output chunks that arrived before a pane subscribed (or while
   * it was unmounted) — replayed to the xterm on attach, then dropped.
   */
  backfill: Record<string, string[]>;
  pushChunk: (payload: PtyOutputPayload) => void;
  consumeBackfill: (terminalId: string) => string[];
  markExit: (terminalId: string, exitCode: number | null) => void;
  setList: (threadId: string, list: PtyInfo[]) => void;
  addTerminal: (threadId: string, terminal: PtyTerminal) => void;
  removeTerminal: (threadId: string, terminalId: string) => void;
  setActive: (threadId: string, terminalId: string | null) => void;
  subscribeData: (terminalId: string, listener: DataListener) => () => void;
}

/** Live data subscribers — xterm panes register per terminal id. */
const dataListeners = new Map<string, Set<DataListener>>();

/** One decoder per terminal: a UTF-8 codepoint can straddle two chunks. */
const decoders = new Map<string, TextDecoder>();

function decodeChunk(terminalId: string, b64: string): string {
  let decoder = decoders.get(terminalId);
  if (!decoder) {
    decoder = new TextDecoder("utf-8", { fatal: false });
    decoders.set(terminalId, decoder);
  }
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return decoder.decode(bytes, { stream: true });
}

export const useTerminalsStore = create<TerminalsState>((set, get) => ({
  byThread: {},
  activeByThread: {},
  backfill: {},

  pushChunk: (payload) => {
    const text = decodeChunk(payload.terminalId, payload.data);
    // A split codepoint is buffered inside the decoder; nothing to deliver yet.
    if (text === "") return;
    const listeners = dataListeners.get(payload.terminalId);
    if (listeners && listeners.size > 0) {
      for (const listener of listeners) listener(text);
      return;
    }
    // No live pane: keep for backfill (cap ~512 KiB per terminal).
    set((s) => {
      const chunks = [...(s.backfill[payload.terminalId] ?? []), text];
      let size = chunks.reduce((acc, c) => acc + c.length, 0);
      while (size > 512 * 1024 && chunks.length > 1) {
        size -= (chunks.shift() ?? "").length;
      }
      return { backfill: { ...s.backfill, [payload.terminalId]: chunks } };
    });
  },

  consumeBackfill: (terminalId) => {
    const chunks = get().backfill[terminalId];
    if (!chunks || chunks.length === 0) return [];
    set((s) => ({ backfill: { ...s.backfill, [terminalId]: [] } }));
    return chunks;
  },

  markExit: (terminalId, exitCode) =>
    set((s) => ({
      byThread: Object.fromEntries(
        Object.entries(s.byThread).map(([threadId, list]) => [
          threadId,
          list.map((t) =>
            t.terminalId === terminalId ? { ...t, exit: t.exit ?? exitCode ?? -1 } : t,
          ),
        ]),
      ),
    })),

  setList: (threadId, list) =>
    set((s) => ({
      byThread: {
        ...s.byThread,
        [threadId]: list.map((t) => ({
          terminalId: t.terminalId,
          title: t.title,
          exit: t.exit,
        })),
      },
      activeByThread: s.activeByThread[threadId]
        ? s.activeByThread
        : { ...s.activeByThread, [threadId]: list[0]?.terminalId ?? null },
    })),

  addTerminal: (threadId, terminal) =>
    set((s) => ({
      byThread: {
        ...s.byThread,
        [threadId]: [...(s.byThread[threadId] ?? []), terminal],
      },
      activeByThread: { ...s.activeByThread, [threadId]: terminal.terminalId },
    })),

  removeTerminal: (threadId, terminalId) =>
    set((s) => {
      decoders.delete(terminalId);
      const list = (s.byThread[threadId] ?? []).filter((t) => t.terminalId !== terminalId);
      const active =
        s.activeByThread[threadId] === terminalId
          ? (list[list.length - 1]?.terminalId ?? null)
          : s.activeByThread[threadId];
      const { [terminalId]: _dropped, ...backfill } = s.backfill;
      void _dropped;
      return {
        byThread: { ...s.byThread, [threadId]: list },
        activeByThread: { ...s.activeByThread, [threadId]: active },
        backfill,
      };
    }),

  setActive: (threadId, terminalId) =>
    set((s) => ({
      activeByThread: { ...s.activeByThread, [threadId]: terminalId },
    })),

  subscribeData: (terminalId, listener) => {
    let listeners = dataListeners.get(terminalId);
    if (!listeners) {
      listeners = new Set();
      dataListeners.set(terminalId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (listeners!.size === 0) dataListeners.delete(terminalId);
    };
  },
}));
