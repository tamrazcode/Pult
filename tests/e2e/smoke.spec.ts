import { expect, test, type Page } from "@playwright/test";

/**
 * §8 M7 smoke: the shell boots, the palette opens and switches themes,
 * settings routes render, empty states speak for themselves. No console
 * errors anywhere (the plain-browser environment stubs IPC, guarded by
 * isTauri()).
 */

/** The shell needs React mounted before hotkeys exist. */
async function gotoChat(page: Page): Promise<void> {
  await page.goto("/chat");
  await page.locator("textarea").first().waitFor({ state: "visible", timeout: 15_000 });
}

test("shell loads: topbar, sidebar, composer, no console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(String(err)));
  page.on("console", (msg) => {
    // network-level noise (e.g. /favicon.ico 404 on the dev server) is not
    // an application error; JS exceptions still fail the test
    if (msg.type() === "error" && !msg.text().includes("Failed to load resource")) {
      errors.push(msg.text());
    }
  });

  await gotoChat(page);
  await expect(page.getByText("New thread").first()).toBeVisible();
  await expect(page.getByText("pult", { exact: true })).toHaveCount(1);
  // sidebar shelves render with their empty-state copy
  await expect(page.getByText("New threads start here.")).toBeVisible();
  expect(errors).toEqual([]);
});

test("⌘K palette opens, filters, and switches theme to Light", async ({ page }) => {
  await gotoChat(page);
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(dialog).toBeVisible();

  // filter then run
  await page.getByLabel("Search commands").fill("light");
  await dialog.getByRole("option", { name: "Theme: Light" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  // palette also navigates: back to dark via the command
  await page.keyboard.press("Control+k");
  await page.getByLabel("Search commands").fill("dark");
  await page.getByRole("dialog").getByRole("option", { name: "Theme: Dark" }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", "light");
});

test("palette navigates to settings routes", async ({ page }) => {
  await gotoChat(page);
  await page.keyboard.press("Control+k");
  await page.getByLabel("Search commands").fill("keybindings");
  await page.getByRole("dialog").getByRole("option", { name: "Settings: Keybindings" }).click();
  await expect(page.getByText("Press a row, then the new combination")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Keybindings" })).toBeVisible();

  await page.keyboard.press("Control+k");
  await page.getByLabel("Search commands").fill("appearance");
  await page.getByRole("dialog").getByRole("option", { name: "Settings: Appearance" }).click();
  await expect(page.getByRole("radiogroup", { name: "Theme" })).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Accent color" })).toBeVisible();
});

test("appearance: picking an accent regenerates the accent token", async ({ page }) => {
  await page.goto("/settings/appearance");
  await page.getByRole("radiogroup", { name: "Accent color" }).waitFor();
  const before = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
  );
  await page.getByRole("radio", { name: "Purple" }).click();
  const after = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
  );
  expect(after).not.toBe(before);
  // theme cards: light applies data-theme in the same session
  await page.getByRole("radio", { name: "Light" }).first().click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  // computed surface color actually flips
  const canvas = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(canvas).not.toBe("rgb(0, 0, 0)");
});

test("fps overlay stays off without the flag and on with ?fps=1", async ({ page }) => {
  await gotoChat(page);
  await expect(page.getByText(/fps · worst/)).toHaveCount(0);
  await page.goto("/chat?fps=1");
  await page.locator("textarea").first().waitFor({ state: "visible", timeout: 15_000 });
  await expect(page.getByText(/fps · worst/)).toBeVisible();
});
