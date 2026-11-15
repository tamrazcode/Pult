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
});
