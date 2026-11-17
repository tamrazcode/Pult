import { create } from "zustand";

const STORAGE_KEY = "pult:drafts:v1";
const HEIGHTS_KEY = "pult:draft-heights:v1";
const MAX_DRAFT = 100_000;

function readStored(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function readHeights(): Record<string, number> {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(HEIGHTS_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

let saveTimer: number | undefined;
let heightTimer: number | undefined;

function persist(byThread: Record<string, string>) {
  if (typeof window === "undefined") return;
  if (saveTimer !== undefined) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(byThread));
    } catch {
      // Quota/private mode: keep the in-memory draft, drop persistence.
    }
  }, 250);
}

function persistHeights(byThread: Record<string, number>) {
  if (typeof window === "undefined") return;
  if (heightTimer !== undefined) window.clearTimeout(heightTimer);
  heightTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(HEIGHTS_KEY, JSON.stringify(byThread));
    } catch {
      // Quota/private mode: heights are only a comfort setting.
    }
  }, 250);
}

export interface ImageChip {
  /** Base64 payload (no data URL prefix). */
  data: string;
  mimeType: string;
  /** Full data URL for the thumbnail. */
  preview: string;
  name: string;
  size: number;
}

export interface FileChip {
  name: string;
  text: string;
  truncated: boolean;
  size: number;
}

export interface DraftAttachments {
  images: ImageChip[];
  files: FileChip[];
}

const EMPTY: DraftAttachments = { images: [], files: [] };

interface DraftsState {
  byThread: Record<string, string>;
  attachments: Record<string, DraftAttachments>;
  heightByThread: Record<string, number>;
  setDraft: (threadId: string, text: string) => void;
  clearDraft: (threadId: string) => void;
  setAttachments: (threadId: string, patch: Partial<DraftAttachments>) => void;
  clearAttachments: (threadId: string) => void;
  setDraftHeight: (threadId: string, height: number) => void;
}

export const useDraftsStore = create<DraftsState>((set) => {
  const write = (threadId: string, text: string) =>
    set((state) => {
      const next = { ...state.byThread };
      const value = text.slice(0, MAX_DRAFT);
      if (value) next[threadId] = value;
      else delete next[threadId];
      persist(next);
      return { byThread: next };
    });

  return {
    byThread: readStored(),
    // Attachments stay in memory on purpose: base64 images overflow the
    // localStorage quota. `shortcut: lost on restart, move to IndexedDB if
    // drafts must survive a relaunch`.
    attachments: {},
    heightByThread: readHeights(),
    setDraft: write,
    clearDraft: (threadId) => {
      write(threadId, "");
      const heights = { ...useDraftsStore.getState().heightByThread };
      if (!(threadId in heights)) return;
      delete heights[threadId];
      persistHeights(heights);
      useDraftsStore.setState({ heightByThread: heights });
    },
    setDraftHeight: (threadId, height) =>
      set((state) => {
        const value = Math.min(280, Math.max(52, Math.round(height)));
        if (state.heightByThread[threadId] === value) return state;
        const next = { ...state.heightByThread, [threadId]: value };
        persistHeights(next);
        return { heightByThread: next };
      }),
    setAttachments: (threadId, patch) =>
      set((state) => {
        const current = state.attachments[threadId] ?? EMPTY;
        return {
          attachments: { ...state.attachments, [threadId]: { ...current, ...patch } },
        };
      }),
    clearAttachments: (threadId) =>
      set((state) => {
        if (!state.attachments[threadId]) return state;
        const next = { ...state.attachments };
        delete next[threadId];
        return { attachments: next };
      }),
  };
});
