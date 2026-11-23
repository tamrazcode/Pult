import { expect, test } from "@playwright/test";
import { installTauriMock } from "./tauri-mock";

const WARMUP_TEXT = [
  "## Warmup",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "```ts",
  "const warm = 1;",
  "```",
  "",
  "Inline $e^{i\\pi}+1=0$ and display:",
  "",
  "$$",
  "\\int_0^1 x\\,dx = \\tfrac12",
  "$$",
].join("\n");

/** ~20 KB mixed markdown: prose, tables, closed fences and KaTeX. */
function perfMarkdown(): string {
  const filler =
    "The quick brown fox jumps over the lazy dog while the renderer schedules a frame and " +
    "the parser waits for the next chunk of the answer. ";
  const parts: string[] = [];
  for (let i = 0; i < 40; i += 1) {
    parts.push(
      `Paragraph ${i + 1}: the agent keeps writing while the transcript grows, and the ` +
        `timeline must paint at frame rate instead of blocking on every delta. ` +
        `A second sentence adds realistic weight, the size where per-token parsing drops frames. ` +
        filler +
        filler,
    );
    if (i % 13 === 4) {
      parts.push(
        `\n| step | state | note |\n| --- | --- | --- |\n| ${i} | done | checked |\n| ${i + 1} | wip | streaming |`,
      );
    }
    if (i % 10 === 3) {
      parts.push(
        `\n\`\`\`ts\nfunction block${i}(value: number) {\n  return value * ${i};\n}\n\`\`\``,
      );
    }
    if (i % 20 === 7) {
      parts.push(
        `\nInline $a_${i} + b_${i} = c_${i}$ and display:\n\n$$\n\\sum_{k=1}^{${i}} k\n$$`,
      );
    }
  }
  return parts.join("\n\n");
}

test("streams 600 deltas within frame and long-task budgets", async ({ page }) => {
  test.setTimeout(120_000);
  const text = perfMarkdown();
  expect(text.length).toBeGreaterThan(12_000);
  const thread = {
    id: "perf-1",
    projectId: null,
    title: "Streaming perf",
    status: "working",
    pinned: false,
    createdAt: 0,
    updatedAt: 0,
  };
  await installTauriMock(page, {
    instances: [],
    threads: [thread],
    threadDetail: {
      thread,
      runs: [
        {
          id: "warmup",
          threadId: "perf-1",
          idx: 0,
          status: "finished",
          instanceId: "mock",
          startedAt: 1,
          stoppedAt: 2,
          stopReason: "end_turn",
        },
        {
          id: "perf-run",
          threadId: "perf-1",
          idx: 1,
          status: "running",
          instanceId: "mock",
          startedAt: 3,
        },
      ],
      events: [
        {
          id: "w1",
          runId: "warmup",
          seq: 1,
          ts: 1,
          kind: "user_message",
          payload: { text: "warmup", images: [] },
        },
        {
          id: "w2",
          runId: "warmup",
          seq: 2,
          ts: 2,
          kind: "agent_message_delta",
          payload: { delta: WARMUP_TEXT },
        },
        {
          id: "w3",
          runId: "warmup",
          seq: 3,
          ts: 3,
          kind: "run_finished",
          payload: { stopReason: "end_turn" },
        },
        {
          id: "p1",
          runId: "perf-run",
          seq: 1,
          ts: 4,
          kind: "user_message",
          payload: { text: "perf", images: [] },
        },
      ],
      queue: [],
      activeRunId: "perf-run",
    },
  });

  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(String(err)));

  await page.goto("/thread/perf-1");
  // Warmup loads the Shiki grammar, KaTeX CSS and the markdown chunks.
  await expect(page.locator("pre.shiki").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".katex").first()).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(
    () =>
      (
        window as unknown as { __PULT_LISTENERS__?: (event: string) => number }
      ).__PULT_LISTENERS__?.("run:event") ?? 0,
  );

  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });

  const result = await page.evaluate(
    async ({ markdown, runId }) => {
      const emit = (
        window as unknown as { __PULT_EMIT__: (event: string, payload: unknown) => number }
      ).__PULT_EMIT__;
      const baseline = {
        tables: document.querySelectorAll("table").length,
        katex: document.querySelectorAll(".katex").length,
        highlighted: document.querySelectorAll("pre.shiki").length,
      };
      const deltas = 600;
      const size = Math.ceil(markdown.length / deltas);
      const chunks: string[] = [];
      for (let i = 0; i < deltas; i += 1) {
        chunks.push(markdown.slice(i * size, (i + 1) * size));
      }
      const firstPrefix = chunks[0].slice(0, 16);

      const gaps: number[] = [];
      let sampling = true;
      let lastFrame = performance.now();
      const sampleFrame = (now: number) => {
        gaps.push(now - lastFrame);
        lastFrame = now;
        if (sampling) requestAnimationFrame(sampleFrame);
      };
      requestAnimationFrame(sampleFrame);

      let resolveFirstPaint: (ms: number) => void = () => {};
      const firstPaint = new Promise<number>((resolve) => {
        resolveFirstPaint = resolve;
      });
      const longTasks: Array<{ start: number; duration: number }> = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push({ start: entry.startTime, duration: entry.duration });
        }
      });
      try {
        observer.observe({ type: "longtask", buffered: false });
      } catch {
        // Older engines without the longtask entry type: frame gaps still count.
      }

      const started = performance.now();
      for (let i = 0; i < chunks.length; i += 1) {
        emit("run:event", {
          runId,
          event: {
            id: `${runId}-d${i}`,
            runId,
            seq: i + 2,
            ts: started + i * 16,
            kind: "agent_message_delta",
            payload: { delta: chunks[i] },
          },
        });
        if (i === 0) {
          const waitFirstPaint = () => {
            if (document.body.textContent?.includes(firstPrefix)) {
              resolveFirstPaint(performance.now() - started);
            } else {
              requestAnimationFrame(waitFirstPaint);
            }
          };
          requestAnimationFrame(waitFirstPaint);
        }
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      // Trailing throttle flush + streaming code highlight.
      await new Promise((resolve) => setTimeout(resolve, 400));
      sampling = false;
      observer.disconnect();
      const painted = await Promise.race([
        firstPaint,
        new Promise<number>((resolve) => setTimeout(() => resolve(9_999), 2_000)),
      ]);
      const sorted = [...gaps].sort((a, b) => a - b);
      const over50 = longTasks.filter((t) => t.duration > 50);
      const maxLongTaskMs = over50.reduce((max, t) => Math.max(max, t.duration), 0);
      return {
        firstTokenPaintMs: painted,
        p95FrameGapMs: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
        maxFrameGapMs: sorted[sorted.length - 1] ?? 0,
        longTasksOver50ms: over50.length,
        maxLongTaskMs: Math.round(maxLongTaskMs * 10) / 10,
        longTasksDetail: over50.map((t) => ({
          offsetMs: Math.round(t.start - started),
          durationMs: Math.round(t.duration * 10) / 10,
        })),
        deltas: chunks.length,
        bytes: markdown.length,
        tables: document.querySelectorAll("table").length - baseline.tables,
        katex: document.querySelectorAll(".katex").length - baseline.katex,
        highlighted: document.querySelectorAll("pre.shiki").length - baseline.highlighted,
      };
    },
    { markdown: text, runId: "perf-run" },
  );

  console.log("streaming perf:", JSON.stringify(result));
  expect(pageErrors).toEqual([]);
  expect(result.deltas).toBe(600);
  expect(result.tables).toBe(3);
  expect(result.katex).toBe(4);
  expect(result.highlighted).toBe(4);
  expect(result.firstTokenPaintMs).toBeLessThan(150);
  expect(result.p95FrameGapMs).toBeLessThanOrEqual(40);
  expect(result.longTasksOver50ms).toBeLessThanOrEqual(4);
  expect(result.maxLongTaskMs).toBeLessThan(120);
});
