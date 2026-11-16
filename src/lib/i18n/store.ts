import { create } from "zustand";
import type { LocaleId } from "./types";
import { isLocaleId } from "./types";

/**
 * Active UI language. Kept out of the settings store so the translation
 * helpers can be imported from stores without a cycle.
 */
export const useLocaleStore = create<{
  locale: LocaleId;
  setLocale: (locale: LocaleId) => void;
}>((set) => ({
  locale: "en",
  setLocale: (locale) => {
    set({ locale });
    if (typeof document !== "undefined") document.documentElement.lang = locale;
  },
}));

/** Boot-time / settings sync; never persists by itself. */
export function applyLocale(locale: LocaleId | null | undefined) {
  const resolved = isLocaleId(locale) ? locale : "en";
  useLocaleStore.getState().setLocale(resolved);
}
