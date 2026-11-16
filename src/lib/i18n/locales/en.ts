import { common } from "./en/common";
import { sidebar } from "./en/sidebar";
import { chat } from "./en/chat";
import { composer } from "./en/composer";
import { settings } from "./en/settings";
import { panels } from "./en/panels";
import { errors } from "./en/errors";

/**
 * Canonical English strings. Every other locale is typed against these keys,
 * so a missing or extra translation is a TypeScript error.
 */
export const en = {
  ...common,
  ...sidebar,
  ...chat,
  ...composer,
  ...settings,
  ...panels,
  ...errors,
};

export type TranslationKey = keyof typeof en;
