import { expect, test } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

test("Add provider wizard saves an ACP instance and a secret API key", async ({ page }) => {
  await installTauriMock(page, {
    instances: [],
    detected: [
      {
        id: "codex",
        displayName: "Codex",
        command: "codex",
        suggestedInstanceId: "codex",
        suggestedCommand: ["npx", "-y", "@agentclientprotocol/codex-acp"],
        notes: "",
      },
    ],
  });
  await page.goto("/settings/providers");

  await page
    .getByRole("button", { name: /add provider/i })
    .first()
    .click();
  const dialog = page.getByRole("dialog", { name: "Add provider" });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: /Codex/i }).first().click();
  await dialog.getByRole("button", { name: "Next" }).click();

  await dialog.getByLabel("Instance ID").fill("codex-e2e");
  await dialog.getByLabel("Label").fill("Codex E2E");
  await dialog.getByRole("button", { name: "Next" }).click();

  await dialog.getByLabel(/API key/i).fill("sk-e2e-secret-1234");
  await dialog.getByRole("button", { name: /Add instance/i }).click();

  await expect(dialog).toBeHidden();
  const calls = await page.evaluate(
    () =>
      (window as unknown as { __PULT_INVOKES__: Array<Record<string, unknown>> }).__PULT_INVOKES__,
  );
  const save = calls.find((call) => call.cmd === "providers_instances_save") as
    { args: { instances: Array<Record<string, unknown>> } } | undefined;
  expect(save).toBeTruthy();
  const saved = save!.args.instances.find((instance) => instance.id === "codex-e2e") as {
    env: Record<string, string>;
    secretEnvKeys: string[];
  };
  expect(saved.secretEnvKeys).toContain("OPENAI_API_KEY");
  expect(saved.env.OPENAI_API_KEY).toBe("sk-e2e-secret-1234");
});
