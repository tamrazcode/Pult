import { defineConfig } from "@playwright/test";

/**
 * Smoke suite (§8 M7). Runs against the vite dev server in a plain browser:
 * the frontend guards every Tauri call with isTauri(), so the shell, palette,
 * themes, settings, and empty states are exercisable without the desktop
 * runtime. Backend-involving flows are covered by the in-app CDP walkthroughs
 * (see DEVLOG per milestone).
 */
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  retries: 0,
  timeout: 30_000,
  use: {
    // WebView2 shares the Edge engine; msedge avoids a chromium download.
    channel: process.env.PULT_E2E_CHANNEL ?? "msedge",
    baseURL: process.env.PULT_E2E_URL ?? "http://localhost:5173",
    viewport: { width: 1440, height: 900 },
  },
  webServer: process.env.PULT_E2E_URL
    ? undefined
    : {
        command: "pnpm dev",
        url: "http://localhost:5173",
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
