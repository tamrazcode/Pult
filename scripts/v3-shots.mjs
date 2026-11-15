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
  await page.waitForTimeout(700);
  await page.evaluate(() => document.fonts.ready);
}

await open("/chat");
await page.screenshot({ path: `${out}/v3-shell-browser.png` });
await page.screenshot({ path: `${out}/v3-live-ascii.png` });

await open("/chat");
await page.getByTitle("Provider, model, and reasoning").click();
await page.screenshot({ path: `${out}/v3-composer-picker.png` });
await page.keyboard.press("Escape");

await open("/settings/general");
await page.screenshot({ path: `${out}/v3-settings-general.png` });
await open("/settings/chat");
await page.screenshot({ path: `${out}/v3-settings-chat.png` });
await open("/settings/projects");
await page.screenshot({ path: `${out}/v3-settings-projects.png` });

console.log(JSON.stringify({ errors }, null, 2));
await browser.close();
