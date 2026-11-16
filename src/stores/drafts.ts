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

interface DraftsState {
  byThread: Record<string, string>;
  setDraft: (threadId: string, text: string) => void;
  clearDraft: (threadId: string) => void;
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
    setDraft: write,
    clearDraft: (threadId) => write(threadId, ""),
  };
});
