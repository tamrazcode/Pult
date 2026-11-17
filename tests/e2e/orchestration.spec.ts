import { expect, test, type Page } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const CLAUDE_INSTANCE = {
  id: "claude",
  displayName: "Claude Code",
  enabled: true,
  driver: "claude",
  command: "claude",
  args: [],
  env: {},
  status: "running",
  promptImage: true,
  loadSession: true,
  modes: [],
  configOptions: [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "claude-sonnet-4",
      options: [
        { value: "claude-sonnet-4", name: "Sonnet 4" },
        { value: "claude-opus-4", name: "Opus 4" },
      ],
    },
  ],
  authMethods: [],
};

const CODEX_INSTANCE = {
  id: "codex",
  displayName: "Codex",
  enabled: true,
  driver: "codex",
  command: "codex",
  args: [],
  env: {},
  status: "running",
  promptImage: true,
  loadSession: true,
  modes: [],
  configOptions: [
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "gpt-5.3-codex",
      options: [
        { value: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
        { value: "gpt-5.4", name: "GPT-5.4" },
      ],
    },
  ],
  authMethods: [],
};

async function waitForThreadReady(page: Page, events: string[]) {
  await page.locator("textarea").first().waitFor({ state: "visible", timeout: 15_000 });
  await expect
    .poll(async () => {
      return page.evaluate((requiredEvents) => {
        const w = window as unknown as {
          __PULT_INVOKES__?: Array<{ cmd: string }>;
          __PULT_LISTENERS__?: (event: string) => number;
        };
        const invokes = w.__PULT_INVOKES__ ?? [];
        const loaded =
          invokes.some((call) => call.cmd === "threads_get") &&
          invokes.some((call) => call.cmd === "providers_instances_list") &&
          invokes.some((call) => call.cmd === "providers_model_prefs_list");
        const listenersReady = requiredEvents.every(
          (ev) => (w.__PULT_LISTENERS__?.(ev) ?? 0) > 0,
        );
        return loaded && listenersReady;
      }, events);
    })
    .toBe(true);
}

async function emitEvent(page: Page, event: string, payload: unknown) {
  const delivered = await page.evaluate(
    ({ eventName, eventPayload }) =>
      (
        window as unknown as {
          __PULT_EMIT__: (name: string, data: unknown) => number;
        }
      ).__PULT_EMIT__(eventName, eventPayload),
    { eventName: event, eventPayload: payload },
  );
  expect(delivered).toBeGreaterThan(0);
}

test("delegated subagent sequence renders SubagentCard and isolates child thread from sidebar and parent timeline", async ({
  page,
}) => {
  const parentThread = {
    id: "th-parent",
    projectId: null,
    title: "Parent orchestration thread",
    status: "working",
    pinned: false,
    createdAt: 1,
    updatedAt: 10,
  };
  const childThread = {
    id: "th-child",
    projectId: null,
    title: "Child subagent thread",
    status: "working",
    pinned: false,
    createdAt: 2,
    updatedAt: 20,
    parentThreadId: "th-parent",
    parentRunId: "run-1",
    depth: 1,
    lineageKind: "delegated",
    childRole: "reviewer",
  };

  await installTauriMock(page, {
    instances: [CLAUDE_INSTANCE, CODEX_INSTANCE],
    threads: [parentThread, childThread],
    threadDetail: {
      thread: parentThread,
      runs: [],
      events: [],
      queue: [],
      activeRunId: null,
    },
  });

  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await page.goto("/thread/th-parent");
  await waitForThreadReady(page, [
    "run:started",
    "run:event",
    "subagent:spawned",
    "subagent:updated",
    "subagent:finished",
  ]);

  await emitEvent(page, "run:started", {
    run: {
      id: "run-1",
      threadId: "th-parent",
      idx: 0,
      status: "running",
      instanceId: "claude",
      model: "claude-sonnet-4",
      startedAt: Date.now(),
    },
  });
  await emitEvent(page, "run:event", {
    runId: "run-1",
    event: {
      id: "ev-1",
      runId: "run-1",
      seq: 1,
      ts: Date.now(),
      kind: "user_message",
      payload: { text: "Audit the auth flow", images: [] },
    },
  });
  await emitEvent(page, "run:event", {
    runId: "run-1",
    event: {
      id: "ev-2",
      runId: "run-1",
      seq: 2,
      ts: Date.now(),
      kind: "agent_message_delta",
      payload: { delta: "Delegating auth audit to a subagent." },
    },
  });

  await emitEvent(page, "subagent:spawned", {
    parentThreadId: "th-parent",
    parentRunId: "run-1",
    task: {
      taskId: "task-1",
      parentThreadId: "th-parent",
      parentRunId: "run-1",
      childThreadId: "th-child",
      childRunId: "run-child",
      title: "Audit auth tokens",
      promptSummary: "Check JWT verification.",
      role: "reviewer",
      targetInstanceId: "codex",
      targetModel: "gpt-5.3-codex",
      isolation: "shared",
      permissionMode: "supervised",
      status: "queued",
      summary: null,
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
      durationMs: null,
    },
  });

  // Also stream a child run transcript to verify it never leaks into parent or sidebar.
  await emitEvent(page, "run:started", {
    run: {
      id: "run-child",
      threadId: "th-child",
      idx: 0,
      status: "running",
      instanceId: "codex",
      model: "gpt-5.3-codex",
      startedAt: Date.now(),
    },
  });
  await emitEvent(page, "run:event", {
    runId: "run-child",
    event: {
      id: "ev-child-1",
      runId: "run-child",
      seq: 1,
      ts: Date.now(),
      kind: "agent_message_delta",
      payload: { delta: "CHILD_INTERNAL_SECRET_MSG" },
    },
  });

  const main = page.locator("main");
  await expect(main.getByText("Audit the auth flow")).toBeVisible();
  await expect(main.getByText("Delegating auth audit to a subagent.")).toBeVisible();

  const card = main.locator("[data-subagent-card]");
  await expect(card).toBeVisible();
  await expect(card.getByText("Audit auth tokens")).toBeVisible();
  await expect(card.getByText(/· reviewer/)).toBeVisible();
  await expect(card.getByText("Queued")).toBeVisible();
  await expect(card.getByText("Check JWT verification.")).toBeVisible();

  await emitEvent(page, "subagent:updated", {
    taskId: "task-1",
    status: "running",
  });
  await expect(card.getByText("Working")).toBeVisible();

  await emitEvent(page, "subagent:finished", {
    taskId: "task-1",
    status: "completed",
    summary: "JWT checks passed with zero issues.",
  });
  await expect(card.getByText("Done")).toBeVisible();
  await expect(card.getByText("JWT checks passed with zero issues.")).toBeVisible();

  // Child thread & transcript stay isolated from parent timeline and sidebar.
  await expect(main.getByText("CHILD_INTERNAL_SECRET_MSG")).toHaveCount(0);
  const sidebar = page.getByRole("navigation", { name: "Threads" });
  await expect(sidebar.getByText("Parent orchestration thread")).toBeVisible();
  await expect(sidebar.getByText("Child subagent thread")).toHaveCount(0);
  await expect(sidebar.getByText("CHILD_INTERNAL_SECRET_MSG")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test("stop button appears while streaming and invokes runs_cancel without fake completion", async ({
  page,
}) => {
  const thread = {
    id: "th-stop",
    projectId: null,
    title: "Stop run thread",
    status: "working",
    pinned: false,
    createdAt: 1,
    updatedAt: 10,
  };

  await installTauriMock(page, {
    instances: [CLAUDE_INSTANCE, CODEX_INSTANCE],
    threads: [thread],
    threadDetail: {
      thread,
      runs: [],
      events: [],
      queue: [],
      activeRunId: null,
    },
  });

  await page.goto("/thread/th-stop");
  await waitForThreadReady(page, ["run:started", "run:event"]);

  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop run", exact: true })).toHaveCount(0);

  await emitEvent(page, "run:started", {
    run: {
      id: "run-stop-1",
      threadId: "th-stop",
      idx: 0,
      status: "running",
      instanceId: "claude",
      model: "claude-sonnet-4",
      startedAt: Date.now(),
    },
  });
  await emitEvent(page, "run:event", {
    runId: "run-stop-1",
    event: {
      id: "ev-stop-1",
      runId: "run-stop-1",
      seq: 1,
      ts: Date.now(),
      kind: "user_message",
      payload: { text: "Stream forever", images: [] },
    },
  });
  await emitEvent(page, "run:event", {
    runId: "run-stop-1",
    event: {
      id: "ev-stop-2",
      runId: "run-stop-1",
      seq: 2,
      ts: Date.now(),
      kind: "agent_message_delta",
      payload: { delta: "Streaming partial output..." },
    },
  });

  await expect(page.getByText("Streaming partial output...")).toBeVisible();
  const stopButton = page.getByRole("button", { name: "Stop run", exact: true });
  await expect(stopButton).toBeVisible();

  await stopButton.click();

  await expect
    .poll(async () => {
      const calls = await page.evaluate(
        () =>
          (
            window as unknown as {
              __PULT_INVOKES__: Array<{ cmd: string; args: Record<string, unknown> }>;
            }
          ).__PULT_INVOKES__,
      );
      return calls.some(
        (call) =>
          call.cmd === "runs_cancel" &&
          call.args.runId === "run-stop-1" &&
          call.args.force === false,
      );
    })
    .toBe(true);

  // Mock does not fake completion: no finish divider appears and Stop remains visible.
  await expect(page.locator("main").getByText("Cancelled", { exact: true })).toHaveCount(0);
  await expect(page.locator("main").getByText("Completed", { exact: true })).toHaveCount(0);
  await expect(stopButton).toBeVisible();
});

test("switching provider picker changes selected provider and model label", async ({ page }) => {
  const thread = {
    id: "th-switch",
    projectId: null,
    title: "Provider switch thread",
    status: "settled",
    pinned: false,
    createdAt: 1,
    updatedAt: 10,
  };

  await installTauriMock(page, {
    instances: [CLAUDE_INSTANCE, CODEX_INSTANCE],
    threads: [thread],
    threadDetail: {
      thread,
      runs: [],
      events: [],
      queue: [],
      activeRunId: null,
    },
  });

  await page.goto("/thread/th-switch");
  await waitForThreadReady(page, ["run:started", "run:event"]);

  const claudeTrigger = page.getByRole("button", { name: "Claude Code · Sonnet 4" });
  await expect(claudeTrigger).toBeVisible();
  await claudeTrigger.click();

  const dialog = page.getByRole("dialog", { name: "Provider, model, and reasoning" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Sonnet 4" })).toBeVisible();

  await dialog.getByRole("button", { name: "Codex", exact: true }).click();

  const codexTrigger = page.getByRole("button", { name: "Codex · GPT-5.3 Codex" });
  await expect(codexTrigger).toBeVisible();
  await expect(dialog.getByRole("button", { name: "GPT-5.3 Codex" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "GPT-5.4" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Sonnet 4" })).toHaveCount(0);

  await dialog.getByRole("button", { name: "GPT-5.4" }).click();
  await expect(page.getByRole("button", { name: "Codex · GPT-5.4" })).toBeVisible();

  await expect
    .poll(async () => {
      const calls = await page.evaluate(
        () =>
          (
            window as unknown as {
              __PULT_INVOKES__: Array<{ cmd: string; args: Record<string, unknown> }>;
            }
          ).__PULT_INVOKES__,
      );
      return calls.some(
        (call) =>
          call.cmd === "runs_set_config_option" &&
          call.args.threadId === "th-switch" &&
          call.args.configId === "model" &&
          call.args.value === "gpt-5.4",
      );
    })
    .toBe(true);
});

test("model prefs disableAll hides provider models in picker", async ({ page }) => {
  const thread = {
    id: "th-prefs",
    projectId: null,
    title: "Model prefs thread",
    status: "settled",
    pinned: false,
    createdAt: 1,
    updatedAt: 10,
  };

  await installTauriMock(page, {
    instances: [CLAUDE_INSTANCE, CODEX_INSTANCE],
    threads: [thread],
    modelPrefs: [
      {
        instanceId: "codex",
        defaultModelId: null,
        disableAll: true,
        disabledModels: [],
        modelOrder: [],
        customModels: [],
        updatedAt: 1,
      },
    ],
    threadDetail: {
      thread,
      runs: [],
      events: [],
      queue: [],
      activeRunId: null,
    },
  });

  await page.goto("/thread/th-prefs");
  await waitForThreadReady(page, ["run:started", "run:event"]);

  await page.getByRole("button", { name: "Claude Code · Sonnet 4" }).click();
  const dialog = page.getByRole("dialog", { name: "Provider, model, and reasoning" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Sonnet 4" })).toBeVisible();

  await dialog.getByRole("button", { name: "Codex", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "GPT-5.3 Codex" })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "GPT-5.4" })).toHaveCount(0);
  await expect(dialog.getByText("No models match")).toBeVisible();
});
