import { create } from "zustand";

const STORAGE_KEY = "pult:drafts:v1";
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

let saveTimer: number | undefined;

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

export interface ImageChip {
  /** Base64 payload (no data URL prefix). */
  data: string;
  mimeType: string;
  /** Full data URL for the thumbnail. */
  preview: string;
}

export interface FileChip {
  name: string;
  text: string;
  truncated: boolean;
}

export interface DraftAttachments {
  images: ImageChip[];
  files: FileChip[];
}

const EMPTY: DraftAttachments = { images: [], files: [] };

interface DraftsState {
  byThread: Record<string, string>;
  attachments: Record<string, DraftAttachments>;
  setDraft: (threadId: string, text: string) => void;
  clearDraft: (threadId: string) => void;
  setAttachments: (threadId: string, patch: Partial<DraftAttachments>) => void;
  clearAttachments: (threadId: string) => void;
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
    setDraft: write,
    clearDraft: (threadId) => write(threadId, ""),
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
