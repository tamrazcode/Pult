import { createElement } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { en } from "../src/lib/i18n/locales/en";
import { ru } from "../src/lib/i18n/locales/ru";
import { de } from "../src/lib/i18n/locales/de";
import { es } from "../src/lib/i18n/locales/es";
import { ja } from "../src/lib/i18n/locales/ja";
import { zh } from "../src/lib/i18n/locales/zh";
import { fr } from "../src/lib/i18n/locales/fr";
import {
  localizeIpcError,
  plural,
  SUPPORTED_LOCALES,
  translate,
  useLocaleStore,
} from "../src/lib/i18n";
import { Route as GeneralRoute } from "../src/routes/settings.general";

vi.mock("../src/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  permissionsRememberedList: vi.fn(async () => []),
}));

const dictionaries = { en, ru, de, es, ja, zh, fr };
const placeholders = (value: string) =>
  [...value.matchAll(/\{\{([^{}]+)\}\}/g)].map((match) => match[1]).sort();

afterEach(() => {
  act(() => useLocaleStore.getState().setLocale("en"));
});

describe("i18n dictionaries", () => {
  it("covers exactly the seven supported locales", () => {
    expect(Object.keys(dictionaries).sort()).toEqual([...SUPPORTED_LOCALES].sort());
    expect(SUPPORTED_LOCALES).toHaveLength(7);
  });

  it.each(SUPPORTED_LOCALES)("%s covers the English key set (plus plural variants)", (locale) => {
    const dictionary = dictionaries[locale];
    // Every English key must exist; extra keys are allowed only as plural
    // category variants of an existing English plural base.
    expect(Object.keys(en).every((key) => key in dictionary)).toBe(true);
    const extras = Object.keys(dictionary).filter((key) => !(key in en));
    for (const extra of extras) {
      const base = extra.replace(/\.(zero|one|two|few|many|other)$/, ".other");
      expect(base, `${locale}:${extra} is not a plural variant`).not.toBe(extra);
      expect(base in en, `${locale}:${extra} has no English plural base`).toBe(true);
    }
  });

  it.each(SUPPORTED_LOCALES)(
    "%s has no empty values and preserves every interpolation placeholder",
    (locale) => {
      for (const [key, value] of Object.entries(dictionaries[locale])) {
        expect(value.trim(), `${locale}:${key}`).not.toBe("");
        const source =
          (en as Record<string, string>)[key] ??
          (en as Record<string, string>)[key.replace(/\.(few|many)$/, ".other")];
        expect(source, `${locale}:${key} must have an English source`).toBeDefined();
        expect(placeholders(value), `${locale}:${key}`).toEqual(placeholders(source));
      }
    },
  );

  it("provides Russian few and many forms for every English plural family", () => {
    const bases = Object.keys(en)
      .filter((key) => key.endsWith(".one"))
      .map((key) => key.slice(0, -4));
    expect(bases.length).toBeGreaterThan(0);
    for (const base of bases) {
      expect(ru[`${base}.few`], `${base}.few`).toBeTruthy();
      expect(ru[`${base}.many`], `${base}.many`).toBeTruthy();
    }
  });
});

describe("translation behavior", () => {
  it("defaults to English, interpolates repeated values, and keeps unknown keys", () => {
    expect(useLocaleStore.getState().locale).toBe("en");
    expect(translate("settings.general.title")).toBe("General");
    expect(translate("chat.trace.autoAllowed", { optionId: "allow_once" })).toBe(
      "Auto-allowed by permission mode (allow_once)",
    );
    expect(translate("missing.translation")).toBe("missing.translation");
    expect(translate("chat.thoughtFor", { duration: "1m 5s" }, "ru")).toBe("Рассуждал 1m 5s");
  });

  it.each([
    [1, "Changed 1 file", "Изменён 1 файл"],
    [2, "Changed 2 files", "Изменено 2 файла"],
    [5, "Changed 5 files", "Изменено 5 файлов"],
    [11, "Changed 11 files", "Изменено 11 файлов"],
    [21, "Changed 21 files", "Изменён 21 файл"],
    [22, "Changed 22 files", "Изменено 22 файла"],
  ])("selects English and Russian plural forms for %i", (count, english, russian) => {
    expect(plural("chat.tool.changedFiles", count, undefined, "en")).toBe(english);
    expect(plural("chat.tool.changedFiles", count, undefined, "ru")).toBe(russian);
  });

  it("uses the store locale and returns an unknown plural base unchanged", () => {
    useLocaleStore.getState().setLocale("ru");
    expect(translate("settings.general.title")).toBe("Основные");
    expect(plural("chat.tool.changedFiles", 2)).toBe("Изменено 2 файла");
    expect(plural("unknown.plural", 2)).toBe("unknown.plural");
    expect(document.documentElement).toHaveAttribute("lang", "ru");
  });

  it("renders General settings in English by default and updates the mounted page to Russian", async () => {
    expect(useLocaleStore.getState().locale).toBe("en");
    await act(async () => {
      render(createElement(GeneralRoute.options.component!));
    });
    expect(screen.getByRole("heading", { name: "General" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Language" })).toBeVisible();
    act(() => useLocaleStore.getState().setLocale("ru"));
    expect(screen.getByRole("heading", { name: "Основные" })).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Язык" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "General" })).toBeNull();
  });

  it("localizes structured IPC error codes and falls back to raw message for unknown codes", () => {
    expect(localizeIpcError({ code: "browser.navigate_failed", message: "raw" })).toBe(
      "That page could not be opened.",
    );
    expect(localizeIpcError({ code: "unknown.error_code", message: "raw" })).toBe("raw");
  });
});
