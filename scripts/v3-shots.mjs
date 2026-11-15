import { chromium } from "playwright-core";

const base = "http://127.0.0.1:4173";
const out = "docs/screenshots";
const browser = await chromium.launch({ channel: "msedge", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error" && !message.text().includes("Failed to load resource")) {
    errors.push(message.text());
  }
});

async function open(path) {
  await page.goto(`${base}${path}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  await page.evaluate(() => document.fonts.ready);
}

async function shot(path, name) {
  await open(path);
  await page.screenshot({ path: `${out}/${name}.png` });
}

await shot("/chat", "v3-shell-browser");
await shot("/settings/appearance", "v3-theme-previews");
await shot("/settings/providers", "v3-providers-empty");

await open("/chat");
await page.locator("textarea").first().waitFor();
await page.keyboard.press("Control+k");
await page.getByRole("dialog", { name: "Command palette" }).waitFor();
await page.screenshot({ path: `${out}/v3-palette.png` });
await page.keyboard.press("Escape");

await page.getByTitle("Provider, model, and reasoning").click();
await page.screenshot({ path: `${out}/v3-composer-picker.png` });

await open("/chat");
await page.locator("textarea").first().waitFor();
await page.evaluate(() => {
  document.documentElement.dataset.theme = "light";
});
await page.waitForTimeout(250);
await page.screenshot({ path: `${out}/v3-light.png` });

console.log(JSON.stringify({ errors }, null, 2));
await browser.close();
