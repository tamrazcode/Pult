import { useCallback } from "react";
import { en } from "./locales/en";
import type { TranslationKey } from "./locales/en";
import { ru } from "./locales/ru";
import { de } from "./locales/de";
import { es } from "./locales/es";
import { ja } from "./locales/ja";
import { zh } from "./locales/zh";
import { fr } from "./locales/fr";
import { useLocaleStore } from "./store";
import type { LocaleId, TranslationParams } from "./types";

export { applyLocale, useLocaleStore } from "./store";
export { SUPPORTED_LOCALES, LOCALE_LABELS, isLocaleId } from "./types";
export type { LocaleId, TranslationParams } from "./types";
export type { TranslationKey } from "./locales/en";

const DICTIONARIES: Record<LocaleId, Record<string, string>> = {
  en,
  ru,
  de,
  es,
  ja,
  zh,
  fr,
};

function interpolate(text: string, params?: TranslationParams): string {
  if (!params) return text;
  let result = text;
  for (const [name, value] of Object.entries(params)) {
    result = result.replaceAll(`{{${name}}}`, String(value));
  }
  return result;
}

/** Translate a key; falls back to English, then to the key itself. */
export function translate(
  key: TranslationKey | string,
  params?: TranslationParams,
  locale?: LocaleId,
): string {
  const active = locale ?? useLocaleStore.getState().locale;
  const dictionary = DICTIONARIES[active] ?? en;
  const text = dictionary[key] ?? (en as Record<string, string>)[key] ?? key;
  return interpolate(text, params);
}

/** Plural form: `chat.files.one|few|many|other` selected by Intl.PluralRules. */
export function plural(
  base: string,
  count: number,
  params?: TranslationParams,
  locale?: LocaleId,
): string {
  const active = locale ?? useLocaleStore.getState().locale;
  let category = "other";
  try {
    category = new Intl.PluralRules(active).select(count);
  } catch {
    // Older engines without the locale fall back to "other".
  }
  const key = `${base}.${category}`;
  const dictionary = DICTIONARIES[active] ?? en;
  const text =
    dictionary[key] ??
    (en as Record<string, string>)[key] ??
    dictionary[`${base}.other`] ??
    (en as Record<string, string>)[`${base}.other`] ??
    base;
  return interpolate(text, { count, ...params });
}

/** Reactive translator for components; re-renders when the language changes. */
export function useT() {
  const locale = useLocaleStore((s) => s.locale);
  return useCallback(
    (key: TranslationKey | string, params?: TranslationParams) => translate(key, params, locale),
    [locale],
  );
}

export function formatDate(value: number | Date, locale?: LocaleId): string {
  const active = locale ?? useLocaleStore.getState().locale;
  try {
    return new Intl.DateTimeFormat(active, { dateStyle: "medium" }).format(value);
  } catch {
    return new Date(value).toLocaleDateString();
  }
}

export function formatTime(value: number | Date, locale?: LocaleId): string {
  const active = locale ?? useLocaleStore.getState().locale;
  try {
    return new Intl.DateTimeFormat(active, { timeStyle: "short" }).format(value);
  } catch {
    return new Date(value).toLocaleTimeString();
  }
}

export function formatRelativeTime(value: number, locale?: LocaleId): string {
  const active = locale ?? useLocaleStore.getState().locale;
  const seconds = Math.round((value - Date.now()) / 1000);
  try {
    const formatter = new Intl.RelativeTimeFormat(active, { numeric: "auto" });
    const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
      ["day", 86_400],
      ["hour", 3_600],
      ["minute", 60],
    ];
    for (const [unit, span] of units) {
      if (Math.abs(seconds) >= span) {
        return formatter.format(Math.round(seconds / span), unit);
      }
    }
    return formatter.format(seconds, "second");
  } catch {
    return new Date(value).toLocaleString();
  }
}

export function formatNumber(value: number, locale?: LocaleId): string {
  const active = locale ?? useLocaleStore.getState().locale;
  try {
    return new Intl.NumberFormat(active).format(value);
  } catch {
    return String(value);
  }
}

/** Localized message for a structured IPC error; unknown codes keep the raw text. */
export function localizeIpcError(error: unknown, locale?: LocaleId): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : error instanceof Error
        ? error.message
        : String(error);
  if (code) {
    const key = `errors.${code}`;
    const active = locale ?? useLocaleStore.getState().locale;
    const dictionary = DICTIONARIES[active] ?? en;
    if (key in dictionary || key in en) return translate(key, undefined, locale);
  }
  return message;
}
