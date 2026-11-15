import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MessagesTimeline } from "../src/components/chat/MessagesTimeline";
import { useRunsStore } from "../src/stores/runs";
import type { AppEvent, Run } from "../src/lib/types";

const { markdownRenderCounts } = vi.hoisted(() => ({
  markdownRenderCounts: new Map<string, number>(),
}));

vi.mock("../src/components/chat/Markdown", () => ({
  default: ({ text }: { text: string }) => {
    markdownRenderCounts.set(text, (markdownRenderCounts.get(text) ?? 0) + 1);
    return <div>{text}</div>;
  },
}));

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
  Element.prototype.scrollIntoView = vi.fn();
  useRunsStore.setState({
    runsByThread: {},
    viewsByRun: {},
    appliedEvents: {},
    commandsByThread: {},
    queueByThread: {},
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

  it("omits token usage text from a finished run while keeping the stop reason label", () => {
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
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.queryByText(/tokens/i)).toBeNull();
    expect(container.textContent).not.toMatch(/tokens/i);
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

  it("renders thought and tool rows as flat inline lines without border-border-subtle or bg-surface", () => {
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

    const thoughtContainer = screen.getByRole("button", { name: /Thought for/i }).parentElement!;
    expect(thoughtContainer).not.toHaveClass("border-border-subtle");
    expect(thoughtContainer).not.toHaveClass("bg-surface");

    const toolContainer = screen.getByText("Read main.ts").closest("button")!.parentElement!;
    expect(toolContainer).not.toHaveClass("border-border-subtle");
    expect(toolContainer).not.toHaveClass("bg-surface");
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
      expect(screen.getByText(/Working for \d+s/)).toHaveTextContent("Working for 4s");

      act(() => {
        vi.advanceTimersByTime(2_000);
      });
      expect(screen.getByText(/Working for \d+s/)).toHaveTextContent("Working for 6s");
    } finally {
      vi.useRealTimers();
    }
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

    fireEvent.click(screen.getByText("Run echo").closest("button")!);

    expect(screen.getAllByText(/hello/).length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("exec-");
    expect(container.textContent).not.toContain("exitCode");

    fireEvent.click(screen.getByRole("button", { name: /Raw/i }));
    expect(container.textContent).toContain("exitCode");
  });
});
