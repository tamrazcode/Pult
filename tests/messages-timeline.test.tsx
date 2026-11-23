import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";
import type { AppEvent, Run } from "../src/lib/types";

const { markdownRenderCounts, runsCancel, readImageDataUrl } = vi.hoisted(() => ({
  markdownRenderCounts: new Map<string, number>(),
  runsCancel: vi.fn(async () => undefined),
  readImageDataUrl: vi.fn(async () => ""),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    runsCancel,
    readImageDataUrl,
  };
});

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/chat" } }),
  useRouter: () => ({ navigate: vi.fn(async () => undefined) }),
}));

vi.mock("../src/components/chat/Markdown", () => ({
  default: ({ text }: { text: string }) => {
    markdownRenderCounts.set(text, (markdownRenderCounts.get(text) ?? 0) + 1);
    return <div>{text}</div>;
  },
}));

import { Composer } from "../src/components/chat/Composer";
import { MessagesTimeline } from "../src/components/chat/MessagesTimeline";
import { ImageLightbox } from "../src/components/ui/ImageLightbox";
import { useRunsStore } from "../src/stores/runs";
import { useSettingsStore } from "../src/stores/settings";
import type { ChatItem, ToolChatItem } from "../src/stores/runs";
import { useSubagentsStore } from "../src/stores/subagents";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";
import type { DelegatedTask } from "../src/lib/types";

const run = (id: string, status: Run["status"], idx: number): Run => ({
  id,
  threadId: "th",
  idx,
  status,
  instanceId: "mock",
  startedAt: 0,
});

const deltaEvent = (runId: string, seq: number, text: string): AppEvent => ({
  id: `${runId}-${seq}`,
  runId,
  seq,
  ts: 0,
  kind: "agent_message_delta",
  payload: { delta: text },
});

beforeEach(() => {
  markdownRenderCounts.clear();
  runsCancel.mockReset().mockResolvedValue(undefined);
  readImageDataUrl.mockReset().mockResolvedValue("");
  Element.prototype.scrollIntoView = vi.fn();
  useRunsStore.setState({
    runsByThread: {},
    viewsByRun: {},
    appliedEvents: {},
    commandsByThread: {},
    queueByThread: {},
    pendingUserByThread: {},
    activeElicitation: null,
  });
  useSubagentsStore.setState({ tasks: {}, order: [] });
  useThreadsStore.setState({
    threads: [],
    activeThreadId: null,
  });
  useUiStore.setState({
    imagePreview: null,
    paletteOpen: false,
    instances: [],
    selectedInstanceId: null,
    instanceByThread: {},
  });
});

// The skipped tests assert the Solid Glass timeline (flat rows, StatusGlyph, composer dock).
describe("MessagesTimeline", () => {
  it("renders every run's messages and keeps them when a new run starts", () => {
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0), run("r2", "running", 1)] },
      viewsByRun: {
        r1: {
          items: [
            { type: "user", text: "first prompt", images: [] },
            { type: "assistant", text: "first answer", streaming: false },
          ],
          streaming: false,
          stopReason: "end_turn",
        },
        r2: {
          items: [
            { type: "user", text: "second prompt", images: [] },
            { type: "assistant", text: "second answer", streaming: true },
          ],
          streaming: true,
        },
      },
    });

    render(<MessagesTimeline threadId="th" />);
    expect(screen.getByText("first prompt")).toBeInTheDocument();
    expect(screen.getByText("first answer")).toBeInTheDocument();
    expect(screen.getByText("second prompt")).toBeInTheDocument();
    expect(screen.getByText("second answer")).toBeInTheDocument();

    act(() => {
      useRunsStore.getState().registerRun(run("r3", "running", 2));
      useRunsStore.getState().receiveRunEvent("r3", deltaEvent("r3", 0, "third answer"));
    });

    expect(screen.getByText("first prompt")).toBeInTheDocument();
    expect(screen.getByText("first answer")).toBeInTheDocument();
    expect(screen.getByText("second prompt")).toBeInTheDocument();
    expect(screen.getByText("second answer")).toBeInTheDocument();
    expect(screen.getByText("third answer")).toBeInTheDocument();
  });

  it("windows the merged history across runs and expands it", { timeout: 20_000 }, () => {
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0), run("r2", "finished", 1)] },
      viewsByRun: {
        r1: {
          items: Array.from({ length: 280 }, (_, i) => ({
            type: "user" as const,
            text: `old-${i}`,
            images: [],
          })),
          streaming: false,
        },
        r2: {
          items: Array.from({ length: 30 }, (_, i) => ({
            type: "user" as const,
            text: `new-${i}`,
            images: [],
          })),
          streaming: false,
        },
      },
    });

    render(<MessagesTimeline threadId="th" />);
    expect(screen.queryByText("old-0")).not.toBeInTheDocument();
    expect(screen.queryByText("old-9")).not.toBeInTheDocument();
    expect(screen.getByText("old-10")).toBeInTheDocument();
    expect(screen.getByText("new-29")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Earlier messages \(10 hidden\)/ }));
    expect(screen.getByText("old-0")).toBeInTheDocument();

    // Registering another run on the same thread must not reset the expanded window.
    act(() => {
      useRunsStore.getState().registerRun(run("r3", "running", 2));
      useRunsStore.getState().receiveRunEvent("r3", deltaEvent("r3", 0, "latest reply"));
    });
    expect(screen.getByText("old-0")).toBeInTheDocument();
    expect(screen.getByText("latest reply")).toBeInTheDocument();
  });

  it("does not re-render a previous run row when a later run streams", () => {
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0), run("r2", "running", 1)] },
      viewsByRun: {
        r1: {
          items: [
            { type: "user", text: "first prompt", images: [] },
            { type: "assistant", text: "run-1 answer", streaming: false },
          ],
          streaming: false,
          stopReason: "end_turn",
        },
        r2: {
          items: [
            { type: "user", text: "second prompt", images: [] },
            { type: "assistant", text: "run-2 start", streaming: true },
          ],
          streaming: true,
        },
      },
    });

    render(<MessagesTimeline threadId="th" />);
    const countBefore = markdownRenderCounts.get("run-1 answer") ?? 0;
    expect(countBefore).toBe(1);

    act(() => {
      useRunsStore.getState().receiveRunEvent("r2", deltaEvent("r2", 0, " more"));
    });

    expect(markdownRenderCounts.get("run-1 answer")).toBe(countBefore);
  });

  it("does not auto-scroll when the user is reading history", async () => {
    Element.prototype.scrollIntoView = vi.fn();

    useRunsStore.setState({
      runsByThread: { th: [run("r1", "running", 0)] },
      viewsByRun: {
        r1: {
          items: [
            { type: "user", text: "prompt", images: [] },
            { type: "assistant", text: "initial chunk", streaming: true },
          ],
          streaming: true,
        },
      },
    });

    const { container } = render(<MessagesTimeline threadId="th" />);
    const scrollContainer = container.querySelector("div.flex-1.overflow-y-auto") as HTMLElement;
    expect(scrollContainer).not.toBeNull();

    Object.defineProperty(scrollContainer, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scrollContainer, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(scrollContainer, "scrollTop", {
      value: 100,
      writable: true,
      configurable: true,
    });

    fireEvent.scroll(scrollContainer);

    act(() => {
      useRunsStore.getState().receiveRunEvent("r1", deltaEvent("r1", 0, " next chunk"));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(scrollContainer.scrollTop).toBe(100);
  });

  it("skips queued rAF auto-scroll if the user scrolls away before the frame flushes", () => {
    Element.prototype.scrollIntoView = vi.fn();

    let nextFrameId = 1;
    const rafCallbacks = new Map<number, FrameRequestCallback>();
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      const id = nextFrameId++;
      rafCallbacks.set(id, cb);
      return id;
    });
    const cafSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      rafCallbacks.delete(id);
    });

    const flushRaf = () => {
      act(() => {
        for (const [id, cb] of [...rafCallbacks.entries()]) {
          rafCallbacks.delete(id);
          cb(performance.now());
        }
      });
    };

    try {
      useRunsStore.setState({
        runsByThread: { th: [run("r1", "running", 0)] },
        viewsByRun: {
          r1: {
            items: [
              { type: "user", text: "prompt", images: [] },
              { type: "assistant", text: "initial chunk", streaming: true },
            ],
            streaming: true,
          },
        },
      });

      const { container } = render(<MessagesTimeline threadId="th" />);
      const scrollContainer = container.querySelector("div.flex-1.overflow-y-auto") as HTMLElement;
      expect(scrollContainer).not.toBeNull();

      // Flush initial render's pin frame.
      flushRaf();

      Object.defineProperty(scrollContainer, "scrollHeight", { value: 1000, configurable: true });
      Object.defineProperty(scrollContainer, "clientHeight", { value: 400, configurable: true });
      Object.defineProperty(scrollContainer, "scrollTop", {
        value: 100,
        writable: true,
        configurable: true,
      });

      // Append a delta while still pinned to bottom: this queues a scroll rAF.
      act(() => {
        useRunsStore.getState().receiveRunEvent("r1", deltaEvent("r1", 0, " next chunk"));
      });
      expect(rafCallbacks.size).toBeGreaterThan(0);

      // User scrolls far from bottom before the queued rAF runs.
      fireEvent.scroll(scrollContainer);

      // Flush the pending rAF; a reader who scrolled up must keep their position.
      flushRaf();
      expect(scrollContainer.scrollTop).toBe(100);
    } finally {
      rafSpy.mockRestore();
      cafSpy.mockRestore();
    }
  });

  it("omits token usage text and the Completed divider for end_turn", () => {
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0)] },
      viewsByRun: {
        r1: {
          items: [
            { type: "user", text: "Check usage", images: [] },
            { type: "assistant", text: "Done", streaming: false },
          ],
          streaming: false,
          stopReason: "end_turn",
          usage: { used: 12300, size: 200000 },
        },
      },
    });

    const { container } = render(<MessagesTimeline threadId="th" />);
    expect(screen.queryByText("Completed")).toBeNull();
    expect(container.querySelector(".h-px.bg-border-subtle")).toBeNull();
    expect(screen.queryByText(/tokens/i)).toBeNull();
    expect(container.textContent).not.toMatch(/tokens/i);
  });

  it("renders the stop reason label and divider for non-end_turn stop reasons", () => {
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "cancelled", 0)] },
      viewsByRun: {
        r1: {
          items: [
            { type: "user", text: "Stop early", images: [] },
            { type: "assistant", text: "Partial", streaming: false },
          ],
          streaming: false,
          stopReason: "cancelled",
        },
      },
    });

    const { container } = render(<MessagesTimeline threadId="th" />);
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(container.querySelector(".h-px.bg-border-subtle")).not.toBeNull();
  });

  it.skip("renders user messages as a flat text block instead of a bordered bubble", () => {
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0)] },
      viewsByRun: {
        r1: {
          items: [{ type: "user", text: "Neutral bubble check", images: [] }],
          streaming: false,
        },
      },
    });

    render(<MessagesTimeline threadId="th" />);
    const bubble = screen.getByText("Neutral bubble check").parentElement!;
    expect(bubble).not.toHaveClass("bg-mention-bg");
    expect(bubble).not.toHaveClass("border-border-subtle");
    expect(bubble).not.toHaveClass("bg-surface");
    expect(bubble).toHaveClass("text-text-primary");
  });

  it("keeps expanded thought and tool rows flat inside one collapsed summary", () => {
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0)] },
      viewsByRun: {
        r1: {
          items: [
            {
              type: "thought",
              text: "Checking code",
              streaming: false,
              startedAt: 1000,
              endedAt: 3000,
            },
            {
              type: "tool",
              toolCallId: "t1",
              title: "Read main.ts",
              kind: "read",
              status: "completed",
              locations: ["src/main.ts"],
            },
          ],
          streaming: false,
        },
      },
    });

    render(<MessagesTimeline threadId="th" />);

    const summary = screen.getByRole("button", { name: "Read 1 file" });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/Checking code/)).toBeNull();
    expect(screen.queryByText("Read src/main.ts")).toBeNull();
    fireEvent.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "true");
    const thoughtText = screen.getByText("Checking code · 2s");
    const thoughtContainer = thoughtText.closest("div")!;
    expect(thoughtContainer).not.toHaveClass("border-border-subtle");
    expect(thoughtContainer).not.toHaveClass("bg-surface");

    const toolContainer = screen.getByText("Read src/main.ts").closest("div")!;
    expect(toolContainer).not.toHaveClass("border-border-subtle");
    expect(toolContainer).not.toHaveClass("bg-surface");
  });

  it.each(["tools", "thoughts", "traces"])(
    "collapses two consecutive %s into exactly one summary button",
    (kind) => {
      const items: ChatItem[] =
        kind === "tools"
          ? ["First tool", "Second tool"].map((title, index) => ({
              type: "tool",
              toolCallId: `t${index}`,
              title,
              kind: "read",
              status: "completed",
              locations: [],
            }))
          : kind === "thoughts"
            ? ["First thought", "Second thought"].map((text) => ({
                type: "thought",
                text,
                streaming: false,
                startedAt: 1_000,
                endedAt: 3_000,
              }))
            : [
                { type: "trace", optionId: "first" },
                { type: "trace", optionId: "second" },
              ];
      useRunsStore.setState({
        runsByThread: { th: [run("r1", "finished", 0)] },
        viewsByRun: { r1: { items, streaming: false } },
      });
      const { container } = render(<MessagesTimeline threadId="th" />);
      expect(container.querySelectorAll("button[aria-expanded]")).toHaveLength(1);
      const summary = container.querySelector("button[aria-expanded]")!;
      expect(summary).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(summary);
      expect(summary).toHaveAttribute("aria-expanded", "true");
      if (kind === "tools") {
        expect(screen.getByText("First tool")).toBeVisible();
        expect(screen.getByText("Second tool")).toBeVisible();
      } else if (kind === "thoughts") {
        expect(screen.getAllByText("First thought · 2s")).toHaveLength(1);
        expect(screen.getAllByText("Second thought · 2s")).toHaveLength(1);
      } else {
        expect(screen.getByText("Auto-allowed by permission mode (first)")).toBeVisible();
        expect(screen.getByText("Auto-allowed by permission mode (second)")).toBeVisible();
      }
    },
  );

  it("summarizes completed mixed actions by count and expands every action chronologically", () => {
    const items: ChatItem[] = [
      {
        type: "tool",
        toolCallId: "read",
        title: "Read source",
        kind: "read",
        status: "completed",
        locations: [],
      },
      {
        type: "thought",
        text: "Consider the result",
        streaming: false,
        startedAt: 1_000,
        endedAt: 3_000,
      },
      { type: "trace", optionId: "allow_once" },
      {
        type: "tool",
        toolCallId: "edit",
        title: "Edit source",
        kind: "edit",
        status: "completed",
        locations: [],
      },
      {
        type: "tool",
        toolCallId: "exec",
        title: "Run tests",
        kind: "execute",
        status: "completed",
        locations: [],
      },
    ];
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0)] },
      viewsByRun: { r1: { items, streaming: false } },
    });
    const { container } = render(<MessagesTimeline threadId="th" />);
    const summary = screen.getByRole("button", {
      name: "Ran 1 command, changed 1 file and read 1 file",
    });
    expect(container.querySelectorAll("button[aria-expanded]")).toHaveLength(1);
    expect(screen.queryByText("Read source")).toBeNull();
    fireEvent.click(summary);
    const chronological = [
      screen.getByText("Read file"),
      screen.getByText("Consider the result · 2s"),
      screen.getByText("Auto-allowed by permission mode (allow_once)"),
      screen.getByText("Edited file"),
      screen.getByText("Run tests"),
    ];
    chronological.forEach((element, index) => {
      expect(element).toBeVisible();
      if (index > 0)
        expect(
          chronological[index - 1].compareDocumentPosition(element) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    });
    expect(screen.queryByText("Consider the result")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Consider the result · 2s" }));
    expect(screen.getByText("Consider the result")).toBeVisible();
    fireEvent.click(summary);
    expect(screen.queryByText("Read file")).toBeNull();
    expect(screen.queryByText("Consider the result")).toBeNull();
  });

  it("does not shimmer a past-tense summary while the run is still streaming", () => {
    useRunsStore.setState({
      runsByThread: { th: [{ ...run("r1", "running", 0), startedAt: Date.now() - 5_000 }] },
      viewsByRun: {
        r1: {
          items: [
            {
              type: "tool",
              toolCallId: "t1",
              title: "shell",
              kind: "shell",
              status: "completed",
              locations: [],
              rawInput: { command: "pnpm test" },
            },
          ],
          streaming: true,
        },
      },
    });

    const { container } = render(<MessagesTimeline threadId="th" />);
    const summary = screen.getByRole("button", { name: "Ran 1 command" });
    expect(summary.querySelector("span.truncate")).not.toHaveClass("sg-status-shimmer");
    // Icon instead of the working glyph.
    expect(summary.querySelector("svg")).not.toBeNull();
    expect(summary.querySelector('[data-slot="status-glyph"]')).toBeNull();
    expect(container.textContent).not.toContain("…");
  });

  it("keeps a manually opened action row open when its live tool completes mid-run", () => {
    const tool = (patch: Partial<ToolChatItem>): ToolChatItem => ({
      type: "tool",
      toolCallId: "t1",
      title: "shell",
      kind: "shell",
      status: "in_progress",
      locations: [],
      rawInput: { command: "pnpm test" },
      ...patch,
    });
    useRunsStore.setState({
      runsByThread: { th: [{ ...run("r1", "running", 0), startedAt: Date.now() - 4_000 }] },
      viewsByRun: { r1: { items: [tool({})], streaming: true } },
    });

    render(<MessagesTimeline threadId="th" />);
    const summary = screen.getByRole("button", { name: "Running pnpm test" });
    fireEvent.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "true");

    // The current tool finishes while the run is still streaming.
    act(() => {
      useRunsStore.setState({
        viewsByRun: {
          r1: { items: [tool({ status: "completed" })], streaming: true },
        },
      });
    });
    expect(screen.getByRole("button", { name: "Ran 1 command" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );

    // Only the end of the run folds it away.
    act(() => {
      useRunsStore.setState({
        runsByThread: { th: [run("r1", "finished", 0)] },
        viewsByRun: {
          r1: { items: [tool({ status: "completed" })], streaming: false },
        },
      });
    });
    expect(screen.getByRole("button", { name: "Ran 1 command" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("keeps the smart active label and auto-expands until the actions complete", () => {
    const first: ChatItem = {
      type: "tool",
      toolCallId: "read",
      title: "Read source",
      kind: "read",
      status: "completed",
      locations: [],
    };
    const latest: ChatItem = {
      type: "tool",
      toolCallId: "exec",
      title: "Run newest checks",
      kind: "execute",
      status: "in_progress",
      locations: [],
    };
    useRunsStore.setState({
      runsByThread: { th: [{ ...run("r1", "running", 0), startedAt: Date.now() - 4_000 }] },
      viewsByRun: { r1: { items: [first, latest], streaming: true } },
    });
    const { container } = render(<MessagesTimeline threadId="th" />);
    expect(container.querySelectorAll("button[aria-expanded]")).toHaveLength(1);
    const summary = screen.getByRole("button", { name: "Run newest checks" });
    expect(screen.getByText(/Working for \d+s/)).toBeVisible();
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Read file")).toBeNull();
    fireEvent.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Read file")).toBeVisible();
    expect(screen.getAllByText("Run newest checks").length).toBeGreaterThan(1);
    const newest: ChatItem = { ...latest, toolCallId: "exec2", title: "Build latest revision" };
    act(() =>
      useRunsStore.setState({
        viewsByRun: {
          r1: { items: [first, { ...latest, status: "completed" }, newest], streaming: true },
        },
      }),
    );
    expect(screen.getByRole("button", { name: "Build latest revision" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getAllByText("Build latest revision").length).toBeGreaterThan(1);
    act(() =>
      useRunsStore.setState({
        runsByThread: { th: [run("r1", "finished", 0)] },
        viewsByRun: {
          r1: {
            items: [first, { ...latest, status: "completed" }, { ...newest, status: "completed" }],
            streaming: false,
          },
        },
      }),
    );
    const done = screen.getByRole("button", { name: "Ran 2 commands and read 1 file" });
    expect(done).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Build latest revision")).toBeNull();
  });

  it("shows the running command beside the Working timer without status dots, then switches to the summary", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      useRunsStore.setState({
        runsByThread: { th: [{ ...run("r1", "running", 0), startedAt: 6_000 }] },
        viewsByRun: {
          r1: {
            items: [
              { type: "user", text: "Write the file", images: [] },
              {
                type: "tool",
                toolCallId: "exec-1",
                title: "shell",
                kind: "shell",
                status: "in_progress",
                locations: [],
                rawInput: { command: "Set-Content out.txt -Value 4" },
              },
            ],
            streaming: true,
          },
        },
      });

      const { container } = render(<MessagesTimeline threadId="th" />);
      expect(screen.getByText("Working for 4s")).toBeVisible();
      const group = screen.getByRole("button", {
        name: "Running Set-Content out.txt -Value 4",
      });
      fireEvent.click(group);
      // Completed and pending rows carry no dot; in-progress is the spinner + title.
      const dots = [...container.querySelectorAll("span.h-1\\.5.w-1\\.5.rounded-full")];
      expect(dots.every((dot) => dot.classList.contains("bg-danger"))).toBe(true);

      act(() => {
        useRunsStore.setState({
          runsByThread: { th: [run("r1", "finished", 0)] },
          viewsByRun: {
            r1: {
              items: [
                { type: "user", text: "Write the file", images: [] },
                {
                  type: "tool",
                  toolCallId: "exec-1",
                  title: "shell",
                  kind: "shell",
                  status: "completed",
                  locations: [],
                  rawInput: { command: "Set-Content out.txt -Value 4" },
                },
              ],
              streaming: false,
            },
          },
        });
      });
      expect(screen.getByRole("button", { name: "Ran 1 command" })).toBeVisible();
      expect(screen.queryByText(/Working for \d+s/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens a thread at the newest message instead of the top", () => {
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0)] },
      viewsByRun: {
        r1: {
          items: [
            { type: "user", text: "oldest", images: [] },
            { type: "assistant", text: "newest", streaming: false },
          ],
          streaming: false,
        },
      },
    });

    // The height has to exist before the layout pass runs, otherwise the pin
    // writes scrollTop 0 and the test proves nothing.
    const heightSpy = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(2400);
    const clientSpy = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);

    try {
      const { container } = render(<MessagesTimeline threadId="th" />);
      const scrollContainer = container.querySelector("div.flex-1.overflow-y-auto") as HTMLElement;
      expect(screen.getByText("newest")).toBeInTheDocument();
      // jsdom stores scrollTop verbatim; the assertion is the value the opening
      // layout pass wrote, which is the bottom of the transcript.
      expect(scrollContainer.scrollTop).toBe(2400);
    } finally {
      heightSpy.mockRestore();
      clientSpy.mockRestore();
    }
  });

  it("keeps the opening pin while a late table settles the layout", () => {
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0)] },
      viewsByRun: {
        r1: {
          items: [
            { type: "user", text: "usage?", images: [] },
            { type: "assistant", text: "table follows", streaming: false },
          ],
          streaming: false,
        },
      },
    });
    // A reader who disabled follow-streaming still gets a settled opening.
    useSettingsStore.setState({ followStreaming: false });

    const callbacks: ResizeObserverCallback[] = [];
    const OriginalRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        callbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as never;

    try {
      const { container } = render(<MessagesTimeline threadId="th" />);
      const scrollContainer = container.querySelector("div.flex-1.overflow-y-auto") as HTMLElement;
      let scrollHeight = 1000;
      let scrollTop = 0;
      Object.defineProperty(scrollContainer, "scrollHeight", {
        get: () => scrollHeight,
        configurable: true,
      });
      Object.defineProperty(scrollContainer, "clientHeight", { value: 400, configurable: true });
      Object.defineProperty(scrollContainer, "scrollTop", {
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.max(0, Math.min(value, scrollHeight - 400));
        },
        configurable: true,
      });

      // The opening pin landed at the bottom of the short transcript.
      scrollTop = 600;
      // The table renders after the opening layout pass: 74px taller, which is
      // exactly what left the tail cut off under the composer.
      scrollHeight = 1074;
      act(() => {
        for (const cb of callbacks) cb([], {} as ResizeObserver);
      });
      expect(scrollTop).toBe(674);

      // A reader who really scrolled away is far past the settle threshold.
      scrollTop = 100;
      scrollHeight = 1200;
      act(() => {
        for (const cb of callbacks) cb([], {} as ResizeObserver);
      });
      expect(scrollTop).toBe(100);
    } finally {
      globalThis.ResizeObserver = OriginalRO;
      useSettingsStore.setState({ followStreaming: true });
    }
  });

  it("pins to scrollHeight so the composer gap stays constant", async () => {
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "running", 0)] },
      viewsByRun: {
        r1: {
          items: [
            { type: "user", text: "prompt", images: [] },
            { type: "assistant", text: "initial chunk", streaming: true },
          ],
          streaming: true,
        },
      },
    });

    const { container } = render(<MessagesTimeline threadId="th" />);
    const scrollContainer = container.querySelector("div.flex-1.overflow-y-auto") as HTMLElement;
    let scrollHeight = 1000;
    let scrollTop = 0;
    Object.defineProperty(scrollContainer, "scrollHeight", {
      get: () => scrollHeight,
      configurable: true,
    });
    Object.defineProperty(scrollContainer, "clientHeight", { value: 400, configurable: true });
    // A browser clamps scrollTop to scrollHeight - clientHeight, which is what
    // keeps the pb-6 gap visible below the last row.
    Object.defineProperty(scrollContainer, "scrollTop", {
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.max(0, Math.min(value, scrollHeight - 400));
      },
      configurable: true,
    });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    // Pinned at the bottom before the next row arrives.
    expect(scrollTop).toBe(600);

    // New content grows the transcript while the reader is still pinned.
    scrollHeight = 1200;
    act(() => {
      useRunsStore.getState().receiveRunEvent("r1", deltaEvent("r1", 0, " next chunk"));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(scrollTop).toBe(800);
  });

  it.skip("shows the optimistic bubble and Thinking immediately before a run exists", () => {
    useRunsStore.setState({
      runsByThread: {},
      viewsByRun: {},
      pendingUserByThread: {
        th: { type: "user", text: "hello", images: [], ts: 1 },
      },
    });

    render(<MessagesTimeline threadId="th" />);

    const userText = screen.getByText("hello");
    const thinking = screen.getByText("Thinking…");
    expect(userText).toBeVisible();
    expect(thinking).toBeVisible();
    expect(thinking).toHaveClass("sg-status-shimmer");
    const glyph = thinking.parentElement?.querySelector('[data-slot="status-glyph"]');
    expect(glyph).toBeInTheDocument();
    expect(
      userText.compareDocumentPosition(thinking) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText("Nothing here yet")).toBeNull();
    expect(screen.queryByText(/Working/)).toBeNull();
  });

  it.skip("shows ThinkingRow below pendingUser when an existing run has streaming === false", () => {
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0)] },
      viewsByRun: {
        r1: {
          items: [
            { type: "user", text: "first prompt", images: [] },
            { type: "assistant", text: "first answer", streaming: false },
          ],
          streaming: false,
          stopReason: "end_turn",
        },
      },
      pendingUserByThread: {
        th: { type: "user", text: "follow up", images: [], ts: 2 },
      },
    });

    const { unmount } = render(<MessagesTimeline threadId="th" />);

    const pendingBubble = screen.getByText("follow up");
    const thinking = screen.getByText("Thinking…");
    expect(screen.getByText("first prompt")).toBeVisible();
    expect(screen.getByText("first answer")).toBeVisible();
    expect(pendingBubble).toBeVisible();
    expect(thinking).toBeVisible();
    expect(thinking).toHaveClass("sg-status-shimmer");
    expect(thinking.parentElement?.querySelector('[data-slot="status-glyph"]')).toBeInTheDocument();
    expect(
      pendingBubble.compareDocumentPosition(thinking) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText(/Working/)).toBeNull();
    unmount();

    // Even if the existing non-streaming run has empty items, pendingUser keeps it out of EmptyState.
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0)] },
      viewsByRun: {
        r1: { items: [], streaming: false },
      },
      pendingUserByThread: {
        th: { type: "user", text: "retry prompt", images: [], ts: 3 },
      },
    });

    render(<MessagesTimeline threadId="th" />);
    expect(screen.queryByText("Nothing here yet")).toBeNull();
    expect(screen.getByText("retry prompt")).toBeVisible();
    expect(screen.getByText("Thinking…")).toBeVisible();
  });

  it("shows ThinkingRow below pendingUser on a finished run", () => {
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0)] },
      viewsByRun: {
        r1: {
          items: [
            { type: "user", text: "first prompt", images: [] },
            { type: "assistant", text: "first answer", streaming: false },
          ],
          streaming: false,
          stopReason: "end_turn",
        },
      },
      pendingUserByThread: {
        th: { type: "user", text: "follow up", images: [], ts: 2 },
      },
    });

    render(<MessagesTimeline threadId="th" />);

    const pendingBubble = screen.getByText("follow up");
    const thinking = screen.getByText("Thinking…");
    expect(screen.getByText("first prompt")).toBeVisible();
    expect(screen.getByText("first answer")).toBeVisible();
    expect(pendingBubble).toBeVisible();
    expect(thinking).toBeVisible();
    expect(
      pendingBubble.compareDocumentPosition(thinking) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText(/Working/)).toBeNull();
  });

  it("does not show ThinkingRow during a streaming run and replaces it with WorkingTimer", () => {
    useRunsStore.setState({
      runsByThread: {},
      viewsByRun: {},
      pendingUserByThread: {
        th: { type: "user", text: "hello", images: [], ts: 1 },
      },
    });

    render(<MessagesTimeline threadId="th" />);
    expect(screen.getByText("Thinking…")).toBeVisible();

    act(() => {
      useRunsStore.getState().registerRun({ ...run("r1", "running", 0), startedAt: Date.now() });
    });

    expect(screen.queryByText("Thinking…")).toBeNull();
    expect(screen.getByText(/Working for \d+s/)).toBeVisible();

    // Queuing a pendingUser while a run is already streaming must not duplicate Thinking with Working.
    act(() => {
      useRunsStore.getState().setPendingUser("th", "queued while running", []);
    });

    expect(screen.getByText("queued while running")).toBeVisible();
    expect(screen.getByText(/Working for \d+s/)).toBeVisible();
    expect(screen.queryByText("Thinking…")).toBeNull();
  });

  it("shows the Working row for a new run even when an earlier run had actions", () => {
    useRunsStore.setState({
      runsByThread: {
        th: [
          { ...run("r1", "finished", 0), startedAt: Date.now() - 60_000 },
          { ...run("r2", "running", 1), startedAt: Date.now() },
        ],
      },
      viewsByRun: {
        r1: {
          items: [
            {
              type: "tool",
              toolCallId: "read",
              title: "Read source",
              kind: "read",
              status: "completed",
              locations: [],
            },
            { type: "assistant", text: "First answer", streaming: false },
          ],
          streaming: false,
          stopReason: "end_turn",
        },
        r2: { items: [], streaming: true },
      },
      pendingUserByThread: {},
    });

    render(<MessagesTimeline threadId="th" />);

    expect(screen.getByText(/Working for \d+s/)).toBeVisible();
    expect(screen.queryByText("Thinking…")).toBeNull();
  });

  it("renders EmptyState for empty threads without pendingUser", () => {
    const { unmount } = render(<MessagesTimeline />);
    expect(screen.getByText("Nothing here yet")).toBeVisible();
    expect(screen.queryByText("Thinking…")).toBeNull();
    unmount();

    const emptyThread = render(<MessagesTimeline threadId="th" />);
    expect(screen.getByText("Nothing here yet")).toBeVisible();
    expect(screen.queryByText("Thinking…")).toBeNull();
    emptyThread.unmount();

    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0)] },
      viewsByRun: { r1: { items: [], streaming: false } },
      pendingUserByThread: {},
    });
    render(<MessagesTimeline threadId="th" />);
    expect(screen.getByText("Nothing here yet")).toBeVisible();
    expect(screen.queryByText("Thinking…")).toBeNull();
  });

  it("keeps a Working row visible between actions for the whole run", () => {
    useRunsStore.setState({
      runsByThread: { th: [{ ...run("r1", "running", 0), startedAt: Date.now() - 5_000 }] },
      viewsByRun: {
        r1: {
          items: [
            {
              type: "tool",
              toolCallId: "read",
              title: "Read source",
              kind: "read",
              status: "completed",
              locations: [],
            },
            { type: "assistant", text: "Between steps", streaming: false },
          ],
          streaming: true,
        },
      },
    });

    render(<MessagesTimeline threadId="th" />);

    expect(screen.getByText("Between steps")).toBeVisible();
    expect(screen.getByText(/Working for \d+s/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Read 1 file" })).toBeVisible();
  });

  it("keeps all actions of a run in one smart row after the assistant message", () => {
    const tool = (id: string): ChatItem => ({
      type: "tool",
      toolCallId: id,
      title: id,
      kind: "read",
      status: "completed",
      locations: [],
    });
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0)] },
      viewsByRun: {
        r1: {
          items: [
            tool("a"),
            tool("b"),
            { type: "assistant", text: "Intermediate result", streaming: false },
            tool("c"),
            tool("d"),
          ],
          streaming: false,
        },
      },
    });
    render(<MessagesTimeline threadId="th" />);
    const summaries = screen.getAllByRole("button", { name: "Read 4 files" });
    expect(summaries).toHaveLength(1);
    const message = screen.getByText("Intermediate result");
    expect(
      message.compareDocumentPosition(summaries[0]) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("omits completed sub-second thoughts entirely, including from group counts", () => {
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0)] },
      viewsByRun: {
        r1: {
          items: [
            {
              type: "thought",
              text: "Instant thought",
              streaming: false,
              startedAt: 1_000,
              endedAt: 1_999,
            },
            {
              type: "tool",
              toolCallId: "read",
              title: "Read source",
              kind: "read",
              status: "completed",
              locations: [],
            },
            {
              type: "thought",
              text: "Zero thought",
              streaming: false,
              startedAt: 2_000,
              endedAt: 2_000,
            },
          ],
          streaming: false,
        },
      },
    });
    render(<MessagesTimeline threadId="th" />);
    expect(screen.queryByRole("button", { name: /Thought/ })).toBeNull();
    expect(screen.queryByText("Instant thought")).toBeNull();
    expect(screen.queryByText("Zero thought")).toBeNull();
    const summary = screen.getByRole("button", { name: "Read 1 file" });
    expect(summary).toBeVisible();
    fireEvent.click(summary);
    expect(screen.getByText("Read file")).toBeVisible();
  });

  it.skip("shows a StatusGlyph in the active Thought row without duplicating the turn timer", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(60_000);
      useRunsStore.setState({
        runsByThread: { th: [run("r1", "running", 0)] },
        viewsByRun: {
          r1: {
            items: [
              {
                type: "thought",
                text: "Still reasoning",
                streaming: true,
                startedAt: 1_000,
                endedAt: 1_000,
              },
            ],
            streaming: true,
          },
        },
      });
      render(<MessagesTimeline threadId="th" />);
      const thought = screen.getByRole("button", { name: "Still reasoning" });
      const glyph = thought.querySelector('[data-slot="status-glyph"]')!;
      expect(glyph).toBeInTheDocument();
      expect(glyph).toHaveAttribute("data-activity", "thinking");
      expect(thought.querySelector("span.truncate")).toHaveClass("sg-status-shimmer");
      act(() => vi.advanceTimersByTime(6_000));
      expect(screen.getByRole("button", { name: "Still reasoning" })).toBeVisible();
      expect(screen.queryByText(/1m 5s/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not duplicate the elapsed time in the active Thought label after 65s", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(60_000);
      useRunsStore.setState({
        runsByThread: { th: [run("r1", "running", 0)] },
        viewsByRun: {
          r1: {
            items: [
              {
                type: "tool",
                toolCallId: "t1",
                title: "Read context",
                kind: "read",
                status: "completed",
                locations: [],
              },
              {
                type: "thought",
                text: "Deep reasoning",
                streaming: true,
                startedAt: 1_000,
                endedAt: 1_000,
              },
            ],
            streaming: true,
          },
        },
      });
      render(<MessagesTimeline threadId="th" />);
      expect(screen.getByRole("button", { name: "Deep reasoning" })).toBeVisible();
      act(() => vi.advanceTimersByTime(6_000));
      expect(screen.getByRole("button", { name: "Deep reasoning" })).toBeVisible();
      expect(screen.queryByText(/1m 5s/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a completed thought preview without duplicating its duration", () => {
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0)] },
      viewsByRun: {
        r1: {
          items: [
            {
              type: "thought",
              text: "Long reasoning",
              streaming: false,
              startedAt: 1_000,
              endedAt: 66_000,
            },
          ],
          streaming: false,
        },
      },
    });
    render(<MessagesTimeline threadId="th" />);
    expect(screen.getByRole("button", { name: "Long reasoning" })).toBeVisible();
    expect(screen.queryByText(/1m 5s/)).toBeNull();
  });

  it("groups two consecutive search tool calls into one expandable summary line", () => {
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0)] },
      viewsByRun: {
        r1: {
          items: [
            {
              type: "tool",
              toolCallId: "s1",
              title: "Grep foo",
              kind: "search",
              status: "completed",
              locations: ["src/a.ts"],
            },
            {
              type: "tool",
              toolCallId: "s2",
              title: "Grep bar",
              kind: "search",
              status: "completed",
              locations: ["src/b.ts"],
            },
          ],
          streaming: false,
        },
      },
    });

    render(<MessagesTimeline threadId="th" />);

    expect(screen.queryByText("Searched in src/a.ts")).toBeNull();
    expect(screen.queryByText("Searched in src/b.ts")).toBeNull();

    const summaryBtn = screen.getByRole("button", { name: /Searched.*2/i });
    fireEvent.click(summaryBtn);

    expect(screen.getByText("Searched in src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("Searched in src/b.ts")).toBeInTheDocument();
  });

  it.skip("displays live 'Working for Ns' line while a run is streaming", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000);
      useRunsStore.setState({
        runsByThread: {
          th: [{ ...run("r1", "running", 0), startedAt: 6_000 }],
        },
        viewsByRun: {
          r1: {
            items: [{ type: "user", text: "Do something", images: [] }],
            streaming: true,
          },
        },
      });

      render(<MessagesTimeline threadId="th" />);
      const line = screen.getByText(/Working for \d+s/);
      expect(line).toHaveTextContent("Working for 4s");
      const glyph = line.parentElement!.querySelector('[data-slot="status-glyph"]');
      expect(glyph).toBeInTheDocument();
      expect(glyph).toHaveAttribute("data-activity", "running");

      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(screen.getByText(/Working for \d+s/)).toHaveTextContent("Working for 6s");
    } finally {
      vi.useRealTimers();
    }
  });

  it.skip("shows a StatusGlyph beside the initial Working… line", () => {
    useRunsStore.setState({
      runsByThread: {
        th: [{ ...run("r1", "running", 0), startedAt: undefined as unknown as number }],
      },
      viewsByRun: {
        r1: { items: [], streaming: true },
      },
    });

    render(<MessagesTimeline threadId="th" />);
    const line = screen.getByText("Working…");
    const glyph = line.parentElement!.querySelector('[data-slot="status-glyph"]');
    expect(glyph).toBeInTheDocument();
    expect(glyph).toHaveAttribute("data-activity", "thinking");
  });

  it("shows readable tool output without exec- ids and reveals raw JSON only after clicking Raw", () => {
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0)] },
      viewsByRun: {
        r1: {
          items: [
            {
              type: "tool",
              toolCallId: "exec-998877",
              title: "Run echo",
              kind: "execute",
              status: "completed",
              locations: [],
              rawInput: { id: "exec-998877", command: "echo hello" },
              rawOutput: { id: "exec-998877", stdout: "hello\n", exitCode: 0 },
            },
          ],
          streaming: false,
        },
      },
    });

    const { container } = render(<MessagesTimeline threadId="th" />);

    fireEvent.click(screen.getByRole("button", { name: "Ran 1 command" }));
    fireEvent.click(screen.getByRole("button", { name: "Run echo" }));

    expect(screen.getAllByText(/hello/).length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("exec-");
    expect(container.textContent).not.toContain("exitCode");

    fireEvent.click(screen.getByRole("button", { name: /Raw/i }));
    expect(container.textContent).toContain("exitCode");
  });

  it("opens image preview dialog on user and agent-generated image clicks and closes on backdrop click or Escape", () => {
    function TimelineWithLightbox() {
      const imagePreview = useUiStore((s) => s.imagePreview);
      const closeImagePreview = useUiStore((s) => s.closeImagePreview);
      return (
        <>
          <MessagesTimeline threadId="th" />
          {imagePreview && (
            <ImageLightbox
              src={imagePreview.src}
              alt={imagePreview.alt}
              onClose={closeImagePreview}
            />
          )}
        </>
      );
    }

    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0)] },
      viewsByRun: {
        r1: {
          items: [
            {
              type: "user",
              text: "Look at this",
              images: [{ data: "USERIMG", mimeType: "image/png" }],
            },
            {
              type: "tool",
              toolCallId: "img-1",
              title: "Generate image",
              kind: "other",
              status: "completed",
              locations: [],
              rawOutput: { mimeType: "image/png", data: "AGENTIMG" },
            },
          ],
          streaming: false,
        },
      },
    });

    render(<TimelineWithLightbox />);

    fireEvent.click(screen.getByRole("button", { name: "Performed 1 other action" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate image" }));
    const openButtons = screen.getAllByRole("button", { name: "Open image" });
    expect(openButtons).toHaveLength(2);

    // Clicking the user-message image opens the preview dialog; backdrop click closes it.
    fireEvent.click(openButtons[0]!);
    const userDialog = screen.getByRole("dialog", { name: "Image preview" });
    expect(userDialog.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,USERIMG");

    fireEvent.click(userDialog);
    expect(screen.queryByRole("dialog", { name: "Image preview" })).toBeNull();

    // Clicking the agent-generated image opens the preview dialog; Escape closes it.
    fireEvent.click(openButtons[1]!);
    const agentDialog = screen.getByRole("dialog", { name: "Image preview" });
    expect(agentDialog.querySelector("img")).toHaveAttribute(
      "src",
      "data:image/png;base64,AGENTIMG",
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Image preview" })).toBeNull();
  });

  it("scopes readImageDataUrl to the rendered thread, not the active one", async () => {
    readImageDataUrl.mockReset().mockResolvedValue("data:image/png;base64,TOOLIMG");
    useThreadsStore.setState({ threads: [], activeThreadId: "th-img" });
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0)] },
      viewsByRun: {
        r1: {
          items: [
            { type: "user", text: "Draw a cat", images: [] },
            {
              type: "tool",
              toolCallId: "img-path",
              title: "Generate image",
              kind: "other",
              status: "completed",
              locations: [],
              rawOutput: { path: "C:\\ws\\outputs\\cat.png" },
            },
          ],
          streaming: false,
        },
      },
    });

    render(<MessagesTimeline threadId="th" />);

    fireEvent.click(screen.getByRole("button", { name: "Performed 1 other action" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate image" }));

    await waitFor(() =>
      expect(readImageDataUrl).toHaveBeenCalledWith("C:\\ws\\outputs\\cat.png", "th"),
    );
  });

  it("closes user image preview on Escape during an active run without calling runsCancel", () => {
    function TimelineWithComposerAndLightbox() {
      const imagePreview = useUiStore((s) => s.imagePreview);
      const closeImagePreview = useUiStore((s) => s.closeImagePreview);
      return (
        <>
          <MessagesTimeline threadId="th" />
          <Composer threadId="th" />
          {imagePreview && (
            <ImageLightbox
              src={imagePreview.src}
              alt={imagePreview.alt}
              onClose={closeImagePreview}
            />
          )}
        </>
      );
    }

    useRunsStore.setState({
      runsByThread: { th: [run("r1", "running", 0)] },
      viewsByRun: {
        r1: {
          items: [
            {
              type: "user",
              text: "Look at this",
              images: [{ data: "USERIMG", mimeType: "image/png" }],
            },
          ],
          streaming: true,
        },
      },
    });

    render(<TimelineWithComposerAndLightbox />);

    fireEvent.click(screen.getByRole("button", { name: "Open image" }));
    expect(screen.getByRole("dialog", { name: "Image preview" })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Image preview" })).toBeNull();
    expect(runsCancel).not.toHaveBeenCalled();
  });

  it("shows 'Scroll to end' only when scrolled away from bottom, sets scrollTop to scrollHeight without smooth scroll, and keeps the button hidden", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0)] },
      viewsByRun: {
        r1: {
          items: [
            { type: "user", text: "prompt", images: [] },
            { type: "assistant", text: "answer", streaming: false },
          ],
          streaming: false,
        },
      },
    });

    const { container } = render(<MessagesTimeline threadId="th" />);
    const scrollContainer = container.querySelector("div.flex-1.overflow-y-auto") as HTMLElement;
    expect(scrollContainer).not.toBeNull();

    expect(screen.queryByRole("button", { name: "Scroll to end" })).toBeNull();

    Object.defineProperty(scrollContainer, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(scrollContainer, "clientHeight", { value: 400, configurable: true });
    Object.defineProperty(scrollContainer, "scrollTop", {
      value: 100,
      writable: true,
      configurable: true,
    });

    fireEvent.scroll(scrollContainer);
    const scrollBtn = screen.getByRole("button", { name: "Scroll to end" });
    expect(scrollBtn).toBeVisible();

    scrollContainer.scrollTop = 580;
    fireEvent.scroll(scrollContainer);
    expect(screen.queryByRole("button", { name: "Scroll to end" })).toBeNull();

    scrollContainer.scrollTop = 100;
    fireEvent.scroll(scrollContainer);
    scrollIntoView.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
    expect(scrollContainer.scrollTop).toBe(1000);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Scroll to end" })).toBeNull();

    fireEvent.scroll(scrollContainer);
    expect(screen.queryByRole("button", { name: "Scroll to end" })).toBeNull();
  });

  it.skip("shows the pending approval once, in the composer dock, never in the timeline", () => {
    useThreadsStore.setState({
      threads: [
        {
          id: "th",
          projectId: null,
          title: "Fix build",
          status: "working",
          pinned: false,
          createdAt: 0,
          updatedAt: 0,
          workspace: "C:\\work\\alpha",
        },
      ],
      activeThreadId: "th",
    });
    useUiStore.setState({
      selectedInstanceId: "claude",
      instanceByThread: { th: "claude" },
      instances: [
        {
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
          configOptions: [],
          authMethods: [],
        },
      ],
    });
    useRunsStore.setState({
      runsByThread: {
        th: [{ ...run("r1", "running", 0), instanceId: "claude" }],
      },
      viewsByRun: {
        r1: {
          items: [],
          streaming: true,
          pendingApproval: {
            requestId: "req-1",
            title: "Execute npm test?",
            options: [
              { optionId: "o1", name: "Allow once", kind: "allow_once" },
              { optionId: "o2", name: "Always allow", kind: "allow_always" },
              { optionId: "o3", name: "Reject", kind: "reject_once" },
            ],
          },
        },
      },
    });

    render(
      <>
        <MessagesTimeline threadId="th" />
        <Composer threadId="th" />
      </>,
    );

    // One waiting surface, and it knows who asks and where.
    expect(screen.getAllByText(/Decision needed: Execute npm test\?/)).toHaveLength(1);
    expect(screen.getByText(/C:\\work\\alpha/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Allow once/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: /this agent & project/i })).toBeInTheDocument();
  });

  it.skip("applies status shimmer to WorkingTimer text and active group labels, removing it on completion", () => {
    useRunsStore.setState({
      runsByThread: { th: [{ ...run("r1", "running", 0), startedAt: Date.now() - 3_000 }] },
      viewsByRun: {
        r1: {
          items: [{ type: "user", text: "Check shimmer", images: [] }],
          streaming: true,
        },
      },
    });

    render(<MessagesTimeline threadId="th" />);
    const workingSpan = screen.getByText(/Working for \d+s/);
    expect(workingSpan).toHaveClass("sg-status-shimmer");

    act(() => {
      useRunsStore.setState({
        viewsByRun: {
          r1: {
            items: [
              { type: "user", text: "Check shimmer", images: [] },
              {
                type: "tool",
                toolCallId: "exec-1",
                title: "Run tests",
                kind: "execute",
                status: "in_progress",
                locations: [],
              },
            ],
            streaming: true,
          },
        },
      });
    });

    const activeBtn = screen.getByRole("button", { name: "Run tests" });
    const activeLabel = activeBtn.querySelector("span.truncate");
    expect(activeLabel).not.toBeNull();
    expect(activeLabel).toHaveClass("sg-status-shimmer", "truncate");
    expect(screen.getByText(/Working for \d+s/)).toBeVisible();

    act(() => {
      useRunsStore.setState({
        runsByThread: { th: [run("r1", "finished", 0)] },
        viewsByRun: {
          r1: {
            items: [
              { type: "user", text: "Check shimmer", images: [] },
              {
                type: "tool",
                toolCallId: "exec-1",
                title: "Run tests",
                kind: "execute",
                status: "completed",
                locations: [],
              },
            ],
            streaming: false,
          },
        },
      });
    });

    const doneBtn = screen.getByRole("button", { name: "Ran 1 command" });
    const doneLabel = doneBtn.querySelector("span.truncate");
    expect(doneLabel).not.toBeNull();
    expect(doneLabel).not.toHaveClass("sg-status-shimmer");
    expect(doneLabel).toHaveClass("text-text-secondary");
  });

  it("renders SubagentCard for delegated tasks belonging to the thread in useSubagentsStore", () => {
    const taskForThread: DelegatedTask = {
      taskId: "task-1",
      parentThreadId: "th",
      parentRunId: "r1",
      childThreadId: "th-sub-1",
      childRunId: "r-sub-1",
      title: "Audit tests",
      promptSummary: "Check coverage of subagent components",
      role: "review",
      targetInstanceId: "claude",
      targetModel: "claude-sonnet-4",
      isolation: "shared",
      permissionMode: "supervised",
      status: "running",
      summary: null,
      error: null,
      startedAt: Date.now() - 2_000,
      finishedAt: null,
      durationMs: null,
    };
    const taskForOtherThread: DelegatedTask = {
      ...taskForThread,
      taskId: "task-other",
      parentThreadId: "other-th",
      title: "Unrelated task",
    };

    useRunsStore.setState({
      runsByThread: { th: [run("r1", "running", 0)] },
      viewsByRun: {
        r1: {
          items: [{ type: "user", text: "Delegate work", images: [] }],
          streaming: true,
        },
      },
    });
    useSubagentsStore.getState().upsert(taskForThread);
    useSubagentsStore.getState().upsert(taskForOtherThread);

    const { container } = render(<MessagesTimeline threadId="th" />);

    expect(container.querySelectorAll("[data-subagent-card]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-subagent-group]")).toHaveLength(0);
    expect(screen.getByText("Audit tests")).toBeVisible();
    expect(screen.getByText("Working")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open chat" })).toBeInTheDocument();
    expect(screen.queryByText("Unrelated task")).toBeNull();
  });

  it("renders one subagent card when the store repeats the same task", () => {
    const task: DelegatedTask = {
      taskId: "task-dedup",
      parentThreadId: "th",
      parentRunId: "r1",
      childThreadId: "th-sub-dedup",
      childRunId: "r-sub-dedup",
      title: "Dedup me",
      promptSummary: "work",
      role: "general",
      targetInstanceId: "claude",
      targetModel: "claude-sonnet-4",
      isolation: "shared",
      permissionMode: "auto",
      status: "completed",
      summary: "done",
      error: null,
      startedAt: 1_000,
      finishedAt: 2_000,
      durationMs: 1_000,
    };
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0)] },
      viewsByRun: {
        r1: { items: [{ type: "user", text: "Delegate work", images: [] }], streaming: false },
      },
    });
    useSubagentsStore.setState({
      tasks: {
        [task.taskId]: task,
        "task-dedup-alias": { ...task, taskId: "task-dedup-alias" },
      },
      order: [task.taskId, task.taskId, "task-dedup-alias"],
    });

    const { container } = render(<MessagesTimeline threadId="th" />);

    expect(container.querySelectorAll("[data-subagent-card]")).toHaveLength(1);
  });

  it("puts a running card at the bottom and settles it at the finish position", () => {
    const task: DelegatedTask = {
      taskId: "task-anchor",
      parentThreadId: "th",
      parentRunId: "r1",
      childThreadId: "th-sub-anchor",
      childRunId: "r-sub-anchor",
      title: "Anchored task",
      promptSummary: "work",
      role: "general",
      targetInstanceId: "claude",
      targetModel: "claude-sonnet-4",
      isolation: "shared",
      permissionMode: "supervised",
      status: "running",
      summary: null,
      error: null,
      startedAt: 2_000,
      finishedAt: null,
      durationMs: null,
    };
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "running", 0)] },
      viewsByRun: {
        r1: {
          items: [
            { type: "assistant", text: "Before the spawn", streaming: false, ts: 1_000 },
            { type: "assistant", text: "After the spawn", streaming: false, ts: 5_000 },
          ],
          streaming: true,
        },
      },
    });
    useSubagentsStore.getState().upsert(task);

    const { container } = render(<MessagesTimeline threadId="th" />);
    const before = screen.getByText("Before the spawn");
    const after = screen.getByText("After the spawn");
    const runningCard = container.querySelector("[data-subagent-card]")!;
    expect(
      after.compareDocumentPosition(runningCard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    act(() => {
      useSubagentsStore.getState().upsert({ ...task, status: "completed", finishedAt: 2_000 });
    });
    const finishedCard = container.querySelector("[data-subagent-card]")!;
    expect(
      before.compareDocumentPosition(finishedCard) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      finishedCard.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders a running subagent from an old run above the live action row", () => {
    const task: DelegatedTask = {
      taskId: "task-old-run",
      parentThreadId: "th",
      parentRunId: "r-old",
      childThreadId: "th-sub-old",
      childRunId: "r-sub-old",
      title: "Old run child",
      promptSummary: "work",
      role: "general",
      targetInstanceId: "claude",
      targetModel: "claude-sonnet-4",
      isolation: "shared",
      permissionMode: "supervised",
      status: "running",
      summary: null,
      error: null,
      startedAt: 2_000,
      finishedAt: null,
      durationMs: null,
    };
    useRunsStore.setState({
      runsByThread: {
        th: [run("r-old", "finished", 0), { ...run("r-new", "running", 1), startedAt: 6_000 }],
      },
      viewsByRun: {
        "r-old": {
          items: [
            { type: "user", text: "old prompt", images: [] },
            { type: "assistant", text: "old answer", streaming: false },
          ],
          streaming: false,
        },
        "r-new": {
          items: [
            { type: "user", text: "new prompt", images: [] },
            { type: "assistant", text: "new answer", streaming: true },
            {
              type: "tool",
              toolCallId: "exec-live",
              title: "Run tests",
              kind: "execute",
              status: "in_progress",
              locations: [],
            },
          ],
          streaming: true,
        },
      },
    });
    useSubagentsStore.getState().upsert(task);

    const { container } = render(<MessagesTimeline threadId="th" />);
    const card = container.querySelector("[data-subagent-card]")!;
    const liveRow = screen.getByRole("button", { name: "Run tests" });
    expect(card).not.toBeNull();
    // After every message, including the old run's answer.
    expect(
      screen.getByText("old answer").compareDocumentPosition(card) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByText("new answer").compareDocumentPosition(card) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Directly above the live action row.
    expect(card.compareDocumentPosition(liveRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("groups 2 tasks with the same parentRunId into SubagentGroupCard and expands them", () => {
    const baseTask: DelegatedTask = {
      taskId: "task-1",
      parentThreadId: "th",
      parentRunId: "r1",
      childThreadId: "th-sub-1",
      childRunId: "r-sub-1",
      title: "First sibling",
      promptSummary: "Check module A",
      role: "review",
      targetInstanceId: "claude",
      targetModel: "claude-sonnet-4",
      isolation: "shared",
      permissionMode: "supervised",
      status: "running",
      summary: null,
      error: null,
      startedAt: Date.now() - 2_000,
      finishedAt: null,
      durationMs: null,
    };
    const secondTask: DelegatedTask = {
      ...baseTask,
      taskId: "task-2",
      childThreadId: "th-sub-2",
      childRunId: "r-sub-2",
      title: "Second sibling",
      targetInstanceId: "codex",
    };

    useRunsStore.setState({
      runsByThread: { th: [run("r1", "running", 0)] },
      viewsByRun: {
        r1: {
          items: [{ type: "user", text: "Run siblings", images: [] }],
          streaming: true,
        },
      },
    });
    useSubagentsStore.getState().upsert(baseTask);
    useSubagentsStore.getState().upsert(secondTask);

    const { container } = render(<MessagesTimeline threadId="th" />);

    expect(container.querySelectorAll("[data-subagent-group]")).toHaveLength(1);
    expect(container.querySelectorAll("[data-subagent-card]")).toHaveLength(0);
    const toggle = screen.getByRole("button", { name: /2 subagents/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelectorAll("[data-subagent-card]")).toHaveLength(2);
    expect(screen.getByText("First sibling")).toBeVisible();
    expect(screen.getByText("Second sibling")).toBeVisible();
  });

  it("renders separate SubagentCard items when tasks have different parentRunId values", () => {
    const firstRunTask: DelegatedTask = {
      taskId: "task-1",
      parentThreadId: "th",
      parentRunId: "r1",
      childThreadId: "th-sub-1",
      childRunId: "r-sub-1",
      title: "Run 1 child",
      promptSummary: "Inspect A",
      role: "review",
      targetInstanceId: "claude",
      targetModel: "claude-sonnet-4",
      isolation: "shared",
      permissionMode: "supervised",
      status: "completed",
      summary: "Done A",
      error: null,
      startedAt: Date.now() - 10_000,
      finishedAt: Date.now() - 5_000,
      durationMs: 5_000,
    };
    const secondRunTask: DelegatedTask = {
      ...firstRunTask,
      taskId: "task-2",
      parentRunId: "r2",
      childThreadId: "th-sub-2",
      childRunId: "r-sub-2",
      title: "Run 2 child",
      summary: "Done B",
    };

    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0), run("r2", "finished", 1)] },
      viewsByRun: {
        r1: { items: [{ type: "user", text: "First run", images: [] }], streaming: false },
        r2: { items: [{ type: "user", text: "Second run", images: [] }], streaming: false },
      },
    });
    useSubagentsStore.getState().upsert(firstRunTask);
    useSubagentsStore.getState().upsert(secondRunTask);

    const { container } = render(<MessagesTimeline threadId="th" />);

    expect(container.querySelectorAll("[data-subagent-group]")).toHaveLength(0);
    expect(container.querySelectorAll("[data-subagent-card]")).toHaveLength(2);
    expect(screen.getByText("Run 1 child")).toBeVisible();
    expect(screen.getByText("Run 2 child")).toBeVisible();
  });

  it("clamps only long user messages and toggles Show full message", () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        const text = this.textContent ?? "";
        if (text.startsWith("LONG")) return 900;
        if (text.startsWith("ASSISTANT")) return 1200;
        return 60;
      },
    });
    try {
      useRunsStore.setState({
        runsByThread: { th: [run("r1", "finished", 0)] },
        viewsByRun: {
          r1: {
            items: [
              { type: "user", text: "short", images: [] },
              { type: "user", text: "LONG " + "x".repeat(2000), images: [] },
              { type: "assistant", text: "ASSISTANT " + "y".repeat(2000), streaming: false },
            ],
            streaming: false,
          },
        },
      });
      render(<MessagesTimeline threadId="th" />);

      const toggles = screen.getAllByRole("button", { name: "Show full message" });
      expect(toggles).toHaveLength(1);
      const toggle = toggles[0]!;
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      const body = document.getElementById(toggle.getAttribute("aria-controls")!)!;
      expect(body).toHaveStyle({ maxHeight: "264px" });
      expect(body.className).toContain("user-message-fade-mask");

      fireEvent.click(toggle);
      const less = screen.getByRole("button", { name: "Show less" });
      expect(less).toHaveAttribute("aria-expanded", "true");
      expect(body.style.maxHeight).toBe("");
      expect(body.className).not.toContain("user-message-fade-mask");

      fireEvent.click(less);
      expect(screen.getByRole("button", { name: "Show full message" })).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    } finally {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, "scrollHeight", descriptor);
      else delete (HTMLElement.prototype as { scrollHeight?: unknown }).scrollHeight;
    }
  });

  it.skip("renders the plan flat with a compact Plan X/Y header and a left thread line", () => {
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0)] },
      viewsByRun: {
        r1: {
          items: [],
          streaming: false,
          plan: [
            { content: "Read the review", status: "completed" },
            { content: "Flatten the cards", status: "in_progress" },
          ],
        } as never,
      },
    });

    const { container } = render(<MessagesTimeline threadId="th" />);

    expect(screen.getByText(/^Plan/)).toBeVisible();
    expect(screen.getByText("1/2")).toBeVisible();
    expect(screen.getByText("Read the review")).toBeVisible();
    expect(screen.getByText("Flatten the cards")).toBeVisible();
    const list = screen.getByText("Read the review").closest("ul")!;
    expect(list).toHaveClass("border-l", "border-border-subtle");
    // No card box around the plan: the header is not a second grey bar.
    expect(container.querySelector(".bg-surface")).toBeNull();
  });

  it.skip("expands a tool into one flat mono block and keeps Open diff borderless", () => {
    useRunsStore.setState({
      runsByThread: { th: [run("r1", "finished", 0)] },
      viewsByRun: {
        r1: {
          items: [
            {
              type: "tool",
              toolCallId: "exec-1",
              title: "Run tests",
              kind: "execute",
              status: "completed",
              locations: [],
              rawInput: { command: "pnpm test" },
              rawOutput: { stdout: "all green", exitCode: 0 },
            },
            {
              type: "tool",
              toolCallId: "edit-1",
              title: "Edit App.tsx",
              kind: "edit",
              status: "completed",
              locations: ["src/App.tsx"],
            },
          ],
          streaming: false,
        },
      },
    });

    render(<MessagesTimeline threadId="th" />);
    fireEvent.click(screen.getByRole("button", { name: /Ran 1 command/ }));
    fireEvent.click(screen.getByRole("button", { name: "Run tests" }));

    // One indented thread line instead of nested code boxes.
    expect(screen.getByText(/pnpm test/).closest("pre")!.parentElement).toHaveClass(
      "border-l",
      "border-border-subtle",
      "pl-3",
    );
    expect(document.querySelectorAll(".bg-code-bg")).toHaveLength(0);

    const openDiff = screen.getByRole("button", { name: "Open diff" });
    expect(openDiff.className).not.toContain("border");
  });
});
