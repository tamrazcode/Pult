import { expect, test } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const tree = [
  {
    pid: 100,
    parentPid: null,
    name: "pult-core.exe",
    role: "core",
    status: "running",
    killable: false,
    children: [
      {
        pid: 200,
        parentPid: 100,
        name: "codex",
        role: "agent",
        label: "Codex",
        threadId: "th-1",
        status: "running",
        cpuPercent: 1.2,
        memoryBytes: 64 * 1024 * 1024,
        killable: true,
        children: [],
      },
    ],
  },
];

test("process tree collapses and kills a registered child", async ({ page }) => {
  await installTauriMock(page, {
    instances: [],
    processTree: tree,
    mcpServers: [],
  });
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("/settings/diagnostics");

  const child = page.locator('[role="treeitem"]').nth(1);
  await expect(child).toBeVisible();
  await expect(child).toContainText("Codex");
  await page.getByRole("button", { name: "Collapse" }).click();
  await expect(child).not.toBeVisible();
  await page.getByRole("button", { name: "Expand" }).click();
  await expect(page.locator('[role="treeitem"]').nth(1)).toContainText("Codex");

  await page.getByRole("button", { name: "Kill" }).click();
  await expect
    .poll(async () => {
      const calls = await page.evaluate(
        () =>
          (window as unknown as { __PULT_INVOKES__: Array<Record<string, unknown>> })
            .__PULT_INVOKES__,
      );
      return calls.some(
        (call) =>
          call.cmd === "diagnostics_kill_process" &&
          (call.args as { pid?: number }).pid === 200,
      );
    })
    .toBe(true);
});
