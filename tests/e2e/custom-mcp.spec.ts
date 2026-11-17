import { expect, test } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const server = {
  id: "mcp-1",
  name: "Mock MCP",
  enabled: true,
  transport: {
    kind: "stdio",
    command: "node",
    args: ["mock.mjs"],
    env: { LOG_LEVEL: "debug" },
    secretEnvKeys: [
      { key: "API_TOKEN", hasValue: true, masked: "••••3456" },
    ],
  },
  scope: "global",
  projectId: null,
  threadId: null,
  providerIds: [],
  allowTools: [],
  denyTools: [],
  timeoutMs: 30000,
  allowLocalhost: true,
  status: "connected",
  lastError: null,
  lastLatencyMs: 12,
  lastCheckedAt: 1,
  toolsCount: 1,
  createdAt: 1,
  updatedAt: 1,
};

test("MCP settings lists a server, masks secrets and probes tools", async ({ page }) => {
  await installTauriMock(page, {
    instances: [],
    projects: [],
    threads: [],
    mcpServers: [server],
  });
  await page.goto("/settings/mcp");

  await expect(page.getByRole("heading", { name: "Mock MCP" })).toBeVisible();
  await expect(page.getByText("Connected in 12 ms · 1 tools")).not.toBeVisible();

  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText("Connected in 12 ms · 1 tools")).toBeVisible();
  await expect(page.getByText("Echo text")).toBeVisible();
  // Wait for post-probe load() to finish so setServers doesn't reset the modal after Edit opens.
  await expect(page.getByRole("button", { name: "Test connection" })).toBeEnabled();

  await page.getByRole("button", { name: "Edit" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByPlaceholder("••••3456")).toBeVisible();
});
