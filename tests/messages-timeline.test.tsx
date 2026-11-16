import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";
import type { AppEvent, Run } from "../src/lib/types";

const { markdownRenderCounts, runsCancel } = vi.hoisted(() => ({
  markdownRenderCounts: new Map<string, number>(),
  runsCancel: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    runsCancel,
  };
});

vi.mock("@tanstack/react-router", () => ({
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
import type { ChatItem } from "../src/stores/runs";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

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
  Element.prototype.scrollIntoView = vi.fn();
  useRunsStore.setState({
    runsByThread: {},
    viewsByRun: {},
    appliedEvents: {},
    commandsByThread: {},
    queueByThread: {},
    activeElicitation: null,
  });
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
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

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
    scrollIntoView.mockClear();

    act(() => {
      useRunsStore.getState().receiveRunEvent("r1", deltaEvent("r1", 0, " next chunk"));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(scrollIntoView).not.toHaveBeenCalledWith(expect.objectContaining({ block: "end" }));
  });

  it("skips queued rAF auto-scroll if the user scrolls away before the frame flushes", () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

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

      // Flush initial render's auto-scroll frame, then clear recorded calls.
      flushRaf();
      scrollIntoView.mockClear();

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

      // Flush the pending rAF; scrollIntoView({ block: "end" }) must not run.
      flushRaf();
      expect(scrollIntoView).not.toHaveBeenCalledWith(expect.objectContaining({ block: "end" }));
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

  it("renders user message bubbles with neutral surface and subtle border instead of bg-mention-bg", () => {
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
    const bubble = screen.getByText("Neutral bubble check");
    expect(bubble).not.toHaveClass("bg-mention-bg");
    expect(bubble).toHaveClass("border-border-subtle");
    expect(bubble.classList.contains("bg-surface") || bubble.classList.contains("bg-panel")).toBe(
      true,
    );
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

    const summary = screen.getByRole("button", { name: "read 1 file" });
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText(/Thought for/i)).toBeNull();
    expect(screen.queryByText("Read src/main.ts")).toBeNull();
    fireEvent.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "true");
    const thoughtText = screen.getByText(/Thought for/i);
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
        expect(screen.getAllByText("Thought for 2s")).toHaveLength(2);
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
      name: "Changed 1 file, ran 1 command and read 1 file",
    });
    expect(container.querySelectorAll("button[aria-expanded]")).toHaveLength(1);
    expect(screen.queryByText("Read source")).toBeNull();
    fireEvent.click(summary);
    const chronological = [
      screen.getByText("Read source"),
      screen.getByText("Thought for 2s"),
      screen.getByText("Auto-allowed by permission mode (allow_once)"),
      screen.getByText("Edit source"),
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
    expect(screen.getByText("Consider the result")).toBeVisible();
    fireEvent.click(summary);
    expect(screen.queryByText("Read source")).toBeNull();
    expect(screen.queryByText("Consider the result")).toBeNull();
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
    const summary = screen.getByRole("button", { name: /Running command ·/ });
    expect(summary).toHaveTextContent(/Running command · \d+s/);
    expect(screen.queryByText(/Working for \d+s/)).toBeNull();
    expect(summary).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Read source")).toBeNull();
    fireEvent.click(summary);
    expect(summary).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Read source")).toBeVisible();
    expect(screen.getByText("Run newest checks")).toBeVisible();
    const newest: ChatItem = { ...latest, toolCallId: "exec2", title: "Build latest revision" };
    act(() =>
      useRunsStore.setState({
        viewsByRun: {
          r1: { items: [first, { ...latest, status: "completed" }, newest], streaming: true },
        },
      }),
    );
    expect(screen.getByRole("button", { name: /Running command ·/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("Build latest revision")).toBeVisible();
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
    const done = screen.getByRole("button", { name: "ran 2 commands and read 1 file" });
    expect(done).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Build latest revision")).toBeNull();
  });

  it("keeps action groups on either side of an assistant message separate", () => {
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
    const summaries = screen.getAllByRole("button", { name: "read 2 files" });
    expect(summaries).toHaveLength(2);
    const message = screen.getByText("Intermediate result");
    expect(
      summaries[0].compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      message.compareDocumentPosition(summaries[1]) & Node.DOCUMENT_POSITION_FOLLOWING,
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
    const summary = screen.getByRole("button", { name: "read 1 file" });
    expect(summary).toBeVisible();
    fireEvent.click(summary);
    expect(screen.getByText("Read source")).toBeVisible();
  });

  it("shows Thinking with a changing character spinner and a live duration across one minute", () => {
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
      const thought = screen.getByRole("button", { name: "Thinking · 59s" });
      const spinner = thought.querySelector("span[aria-hidden]")!;
      expect(spinner.textContent).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/u);
      const initial = spinner.textContent;
      act(() => vi.advanceTimersByTime(90));
      expect(spinner.textContent).not.toBe(initial);
      act(() => vi.advanceTimersByTime(5_910));
      expect(screen.getByRole("button", { name: "Thinking · 1m 5s" })).toBeVisible();
      expect(screen.queryByText("Still reasoning")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders '1m 5s' in the active Thinking label of a running action group after 65s", () => {
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
      expect(screen.getByRole("button", { name: "Thinking · 59s" })).toBeVisible();
      act(() => vi.advanceTimersByTime(6_000));
      expect(screen.getByRole("button", { name: "Thinking · 1m 5s" })).toBeVisible();
    } finally {
      vi.useRealTimers();
    }
  });

  it("formats a completed thought lasting at least a minute as minutes and seconds", () => {
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
    expect(screen.getByRole("button", { name: "Thought for 1m 5s" })).toBeVisible();
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

    expect(screen.queryByText("Grep foo")).toBeNull();
    expect(screen.queryByText("Grep bar")).toBeNull();

    const summaryBtn = screen.getByRole("button", { name: /Searched.*2/i });
    fireEvent.click(summaryBtn);

    expect(screen.getByText("Grep foo")).toBeInTheDocument();
    expect(screen.getByText("Grep bar")).toBeInTheDocument();
  });

  it("displays live 'Working for Ns' line while a run is streaming", () => {
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
      const spinner = line.parentElement!.querySelector("span[aria-hidden]")!;
      expect(spinner.textContent).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/u);
      const initial = spinner.textContent;
      act(() => {
        vi.advanceTimersByTime(90);
      });
      expect(spinner.textContent).not.toBe(initial);

      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(screen.getByText(/Working for \d+s/)).toHaveTextContent("Working for 6s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the ASCII spinner beside the initial Working… line", () => {
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
    const spinner = line.parentElement!.querySelector("span[aria-hidden]")!;
    expect(spinner.textContent).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/u);
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

    fireEvent.click(screen.getByRole("button", { name: "ran 1 command" }));

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

  it("ApprovalCard displays active provider, workspace, and project-scoped allow_always note", () => {
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
          items: [{ type: "user", text: "Run build", images: [] }],
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

    render(<MessagesTimeline threadId="th" />);

    expect(screen.getByText(/Claude Code/)).toBeInTheDocument();
    expect(screen.getByText(/C:\\work\\alpha/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /this agent & project/i })).toBeInTheDocument();
  });

  it("applies activity-shimmer to WorkingTimer text and active group labels, removing it on completion", () => {
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
    expect(workingSpan).toHaveClass("activity-shimmer");

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

    const activeBtn = screen.getByRole("button", { name: /Running command · \d+s/ });
    const activeLabel = activeBtn.querySelector("span.truncate");
    expect(activeLabel).not.toBeNull();
    expect(activeLabel).toHaveClass("activity-shimmer", "truncate");
    expect(screen.queryByText(/Working for \d+s/)).toBeNull();

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

    const doneBtn = screen.getByRole("button", { name: "ran 1 command" });
    const doneLabel = doneBtn.querySelector("span.truncate");
    expect(doneLabel).not.toBeNull();
    expect(doneLabel).not.toHaveClass("activity-shimmer");
    expect(doneLabel).toHaveClass("text-text-secondary");
  });
});
