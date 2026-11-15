import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { HistoryTicks, type HistoryTick } from "../src/components/chat/HistoryTicks";
import { MessagesTimeline } from "../src/components/chat/MessagesTimeline";
import { useRunsStore } from "../src/stores/runs";
import type { Run } from "../src/lib/types";

const makeRun = (id: string, status: Run["status"], idx: number): Run => ({
  id,
  threadId: "th",
  idx,
  status,
  instanceId: "mock",
  startedAt: 0,
});

interface ScrollCall {
  element: Element;
  arg: unknown;
}

let scrollCalls: ScrollCall[] = [];
let rafQueue: FrameRequestCallback[] = [];

function flushRaf(): void {
  act(() => {
    while (rafQueue.length > 0) {
      const cb = rafQueue.shift();
      cb?.(performance.now());
    }
  });
}

beforeEach(() => {
  scrollCalls = [];
  rafQueue = [];
  Element.prototype.scrollIntoView = vi.fn(function (this: Element, arg?: unknown) {
    scrollCalls.push({ element: this, arg });
  });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  useRunsStore.setState({
    runsByThread: {},
    viewsByRun: {},
    appliedEvents: {},
    commandsByThread: {},
    queueByThread: {},
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HistoryTicks", () => {
  it("renders null when ticks is empty", () => {
    const { container } = render(<HistoryTicks ticks={[]} activeKey={null} onJump={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one tick per item and calls onJump when clicked", () => {
    const ticks: HistoryTick[] = [
      { key: "r1:i-0", label: "First user message", globalIndex: 0 },
      { key: "r2:i-0", label: "Second user message", globalIndex: 2 },
    ];
    const onJump = vi.fn();

    render(<HistoryTicks ticks={ticks} activeKey="r2:i-0" onJump={onJump} />);

    expect(screen.getAllByRole("button")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "First user message" }));
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith(ticks[0]);
  });

  it("displays the 80-char preview on hover and focus", () => {
    const preview80 = "A".repeat(80);
    const ticks: HistoryTick[] = [{ key: "r1:i-0", label: preview80, globalIndex: 0 }];

    render(<HistoryTicks ticks={ticks} activeKey={null} onJump={vi.fn()} />);
    const tickButton = screen.getByRole("button", { name: preview80 });

    fireEvent.mouseEnter(tickButton);
    expect(screen.getByText(preview80)).toBeInTheDocument();
    fireEvent.mouseLeave(tickButton);

    fireEvent.focus(tickButton);
    expect(screen.getByText(preview80)).toBeInTheDocument();
  });
});

describe("MessagesTimeline HistoryTicks integration", () => {
  it("renders one tick per user item across multiple runs and none when 0 user items exist", () => {
    useRunsStore.setState({
      runsByThread: { th: [makeRun("r1", "finished", 0)] },
      viewsByRun: {
        r1: {
          items: [
            { type: "assistant", text: "Assistant without user prompt", streaming: false },
            { type: "notice", level: "info", message: "System notice" },
          ],
          streaming: false,
          stopReason: "end_turn",
        },
      },
    });

    const { rerender } = render(<MessagesTimeline threadId="th" />);
    expect(screen.queryAllByLabelText(/Prompt/)).toHaveLength(0);

    act(() => {
      useRunsStore.setState({
        runsByThread: {
          th: [makeRun("r1", "finished", 0), makeRun("r2", "finished", 1)],
        },
        viewsByRun: {
          r1: {
            items: [
              { type: "user", text: "Prompt one", images: [] },
              { type: "assistant", text: "Reply one", streaming: false },
              { type: "user", text: "Prompt two", images: [] },
              { type: "assistant", text: "Reply two", streaming: false },
            ],
            streaming: false,
            stopReason: "end_turn",
          },
          r2: {
            items: [
              { type: "user", text: "Prompt three", images: [] },
              { type: "assistant", text: "Reply three", streaming: false },
            ],
            streaming: false,
            stopReason: "end_turn",
          },
        },
      });
    });

    rerender(<MessagesTimeline threadId="th" />);

    expect(screen.getByRole("button", { name: "Prompt one" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prompt two" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prompt three" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reply/ })).toBeNull();
    expect(screen.getAllByLabelText(/Prompt/)).toHaveLength(3);
  });

  it("shows trimmed first 80 chars of user message when hovering or focusing its tick", () => {
    const rawUserText = `   ${"X".repeat(40)} ${"Y".repeat(55)}   `;
    const expectedPreview = rawUserText.trim().slice(0, 80);

    useRunsStore.setState({
      runsByThread: { th: [makeRun("r1", "finished", 0)] },
      viewsByRun: {
        r1: {
          items: [
            { type: "user", text: rawUserText, images: [] },
            { type: "assistant", text: "Done", streaming: false },
          ],
          streaming: false,
          stopReason: "end_turn",
        },
      },
    });

    render(<MessagesTimeline threadId="th" />);

    const tickButton = screen.getByRole("button", { name: expectedPreview });
    fireEvent.mouseEnter(tickButton);
    expect(screen.getByText(expectedPreview)).toBeInTheDocument();

    fireEvent.mouseLeave(tickButton);
    fireEvent.focus(tickButton);
    expect(screen.getByText(expectedPreview)).toBeInTheDocument();
  });

  it("scrolls the matching [data-history-key] element into view when clicking a tick in an unwindowed transcript", () => {
    useRunsStore.setState({
      runsByThread: {
        th: [makeRun("r1", "finished", 0), makeRun("r2", "finished", 1)],
      },
      viewsByRun: {
        r1: {
          items: [
            { type: "user", text: "First question", images: [] },
            { type: "assistant", text: "First answer", streaming: false },
          ],
          streaming: false,
          stopReason: "end_turn",
        },
        r2: {
          items: [
            { type: "user", text: "Second question", images: [] },
            { type: "assistant", text: "Second answer", streaming: false },
          ],
          streaming: false,
          stopReason: "end_turn",
        },
      },
    });

    const { container } = render(<MessagesTimeline threadId="th" />);
    scrollCalls = [];
    rafQueue = [];

    const firstRow = container.querySelector('[data-history-key="r1:i-0"]');
    expect(firstRow).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "First question" }));
    flushRaf();

    expect(scrollCalls.some((call) => call.element === firstRow)).toBe(true);
  });

  it(
    "expands the hidden older window and scrolls to the mounted [data-history-key] element after requestAnimationFrame",
    { timeout: 20_000 },
    () => {
      useRunsStore.setState({
        runsByThread: {
          th: [makeRun("r1", "finished", 0), makeRun("r2", "finished", 1)],
        },
        viewsByRun: {
          r1: {
            items: [
              { type: "user", text: "Ancient first prompt", images: [] },
              ...Array.from({ length: 279 }, (_, i) => ({
                type: "assistant" as const,
                text: `old-reply-${i + 1}`,
                streaming: false,
              })),
            ],
            streaming: false,
            stopReason: "end_turn",
          },
          r2: {
            items: [
              { type: "user", text: "Recent prompt", images: [] },
              ...Array.from({ length: 29 }, (_, i) => ({
                type: "assistant" as const,
                text: `new-reply-${i + 1}`,
                streaming: false,
              })),
            ],
            streaming: false,
            stopReason: "end_turn",
          },
        },
      });

      const { container } = render(<MessagesTimeline threadId="th" />);

      expect(screen.queryByText("Ancient first prompt")).not.toBeInTheDocument();
      expect(container.querySelector('[data-history-key="r1:i-0"]')).toBeNull();

      const ancientTick = screen.getByRole("button", { name: "Ancient first prompt" });
      scrollCalls = [];
      rafQueue = [];

      fireEvent.click(ancientTick);

      const expandedRow = container.querySelector('[data-history-key="r1:i-0"]');
      expect(expandedRow).not.toBeNull();
      expect(screen.getByText("Ancient first prompt")).toBeInTheDocument();
      expect(rafQueue.length).toBeGreaterThan(0);
      expect(scrollCalls.some((call) => call.element === expandedRow)).toBe(false);

      flushRaf();

      const scrollMatch = scrollCalls.find((call) => call.element === expandedRow);
      expect(scrollMatch).toBeDefined();
      expect(scrollMatch?.arg).toEqual(
        expect.objectContaining({ block: "start", behavior: "smooth" }),
      );
    },
  );

  it("tracks active tick across scroll using only user rows and sets aria-current='location'", () => {
    useRunsStore.setState({
      runsByThread: {
        th: [makeRun("r1", "finished", 0), makeRun("r2", "finished", 1)],
      },
      viewsByRun: {
        r1: {
          items: [
            { type: "user", text: "First prompt", images: [] },
            { type: "assistant", text: "First reply", streaming: false },
          ],
          streaming: false,
          stopReason: "end_turn",
        },
        r2: {
          items: [
            { type: "user", text: "Second prompt", images: [] },
            { type: "assistant", text: "Second reply", streaming: false },
          ],
          streaming: false,
          stopReason: "end_turn",
        },
      },
    });

    const { container } = render(<MessagesTimeline threadId="th" />);
    const scrollContainer = Array.from(container.querySelectorAll<HTMLElement>("div")).find(
      (el) => el.classList.contains("overflow-y-auto") && el.querySelector("[data-history-key]"),
    );
    expect(scrollContainer).toBeDefined();

    const makeRect = (top: number, bottom: number): DOMRect =>
      ({
        top,
        bottom,
        left: 0,
        right: 0,
        width: 0,
        height: bottom - top,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;

    let topmostKey = "r1:i-1";
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      if (this === scrollContainer) {
        return makeRect(100, 500);
      }
      if (this.getAttribute("data-history-key") === topmostKey) {
        return makeRect(120, 150);
      }
      return makeRect(50, 90);
    });

    fireEvent.scroll(scrollContainer!);
    for (const button of screen.getAllByRole("button")) {
      expect(button).not.toHaveAttribute("aria-current");
    }

    topmostKey = "r1:i-0";
    fireEvent.scroll(scrollContainer!);

    expect(screen.getByRole("button", { name: "First prompt" })).toHaveAttribute(
      "aria-current",
      "location",
    );
    expect(screen.getByRole("button", { name: "Second prompt" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("gives an image-only user message a non-empty accessible tick name", () => {
    useRunsStore.setState({
      runsByThread: { th: [makeRun("r1", "finished", 0)] },
      viewsByRun: {
        r1: {
          items: [
            {
              type: "user",
              text: "",
              images: [{ data: "AAAA", mimeType: "image/png" }],
            },
            { type: "assistant", text: "Described image", streaming: false },
          ],
          streaming: false,
          stopReason: "end_turn",
        },
      },
    });

    render(<MessagesTimeline threadId="th" />);

    expect(screen.getByRole("button", { name: "Image prompt" })).toBeInTheDocument();
  });
});
