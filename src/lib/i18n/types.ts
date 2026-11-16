export const SUPPORTED_LOCALES = ["en", "ru", "de", "es", "ja", "zh", "fr"] as const;

export type LocaleId = (typeof SUPPORTED_LOCALES)[number];

/** Human names shown in the Settings language picker. */
export const LOCALE_LABELS: Record<LocaleId, string> = {
  en: "English",
  ru: "Русский",
  de: "Deutsch",
  es: "Español",
  ja: "日本語",
  zh: "中文",
  fr: "Français",
};

export type TranslationParams = Record<string, string | number>;

export function isLocaleId(value: unknown): value is LocaleId {
  return typeof value === "string" && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}
