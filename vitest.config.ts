import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    css: false,
    // *.spec.ts belongs to the Playwright suite (tests/e2e)
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
});
