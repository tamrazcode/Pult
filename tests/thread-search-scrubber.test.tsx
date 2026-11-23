import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const { loadCheckpoints, viewCheckpointDiff, restoreCheckpoint } = vi.hoisted(() => ({
  loadCheckpoints: vi.fn(async () => undefined),
  viewCheckpointDiff: vi.fn(async () => undefined),
  restoreCheckpoint: vi.fn(async () => true),
}));

// Wave 4C-2 owns the real store; the timeline only needs the checkpoint slice.
vi.mock("../src/stores/git", async () => {
  const { create } = await import("zustand");
  return {
    useGitStore: create(() => ({
      byThread: {},
      loadCheckpoints,
      viewCheckpointDiff,
      restoreCheckpoint,
    })),
  };
});

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: vi.fn(async () => undefined) }),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/chat" } }),
}));

vi.mock("../src/components/chat/Markdown", () => ({
  default: ({ text }: { text: string }) => <div>{text}</div>,
}));

import { ThreadSearchBar } from "../src/components/chat/ThreadSearchBar";
import { HistoryTicks, type HistoryTick } from "../src/components/chat/HistoryTicks";
import { MessagesTimeline } from "../src/components/chat/MessagesTimeline";
import { useRunsStore } from "../src/stores/runs";
import { useSettingsStore } from "../src/stores/settings";
import type { Run } from "../src/lib/types";

const makeRun = (id: string, status: Run["status"], idx: number): Run => ({
  id,
  threadId: "th",
  idx,
  status,
  instanceId: "mock",
  startedAt: 0,
});

function SearchHarness({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <>
      <div ref={ref}>
        <p>alpha beta</p>
        <p>Alpha again alpha</p>
      </div>
      <ThreadSearchBar containerRef={ref} onClose={onClose} />
    </>
  );
}

beforeEach(() => {
  loadCheckpoints.mockClear().mockResolvedValue(undefined);
  viewCheckpointDiff.mockClear().mockResolvedValue(undefined);
  restoreCheckpoint.mockClear().mockResolvedValue(true);
  Element.prototype.scrollIntoView = vi.fn();
  useRunsStore.setState({
    runsByThread: {},
    viewsByRun: {},
    appliedEvents: {},
    commandsByThread: {},
    queueByThread: {},
    pendingUserByThread: {},
  });
  useSettingsStore.setState({ transcriptVerbosity: "full" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (typeof CSS !== "undefined") delete (CSS as { highlights?: unknown }).highlights;
});

describe("ThreadSearchBar", () => {
  it("counts matches case-insensitively and walks them with buttons, Enter and Shift+Enter", () => {
    const onClose = vi.fn();
    render(<SearchHarness onClose={onClose} />);
    const input = screen.getByRole("textbox", { name: "Find in thread" });
    expect(input).toHaveAttribute("placeholder", "Find in thread…");

    fireEvent.change(input, { target: { value: "ALPHA" } });
    expect(screen.getByText("1 of 3")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByText("2 of 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByText("1 of 3")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(screen.getByText("3 of 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(screen.getByText("2 of 3")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("3 of 3")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("says No matches for a query that does not occur", () => {
    render(<SearchHarness onClose={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "Find in thread" });
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.getByText("No matches")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
  });

  it("still counts matches when the Custom Highlight API is unavailable (jsdom)", () => {
    if (typeof CSS !== "undefined") delete (CSS as { highlights?: unknown }).highlights;
    expect((CSS as { highlights?: unknown }).highlights).toBeUndefined();

    render(<SearchHarness onClose={vi.fn()} />);
    const input = screen.getByRole("textbox", { name: "Find in thread" });

    expect(() => fireEvent.change(input, { target: { value: "alpha" } })).not.toThrow();
    expect(screen.getByText("1 of 3")).toBeInTheDocument();
  });

  it("registers ranges with the Custom Highlight API when the engine supports it", () => {
    const set = vi.fn();
    class FakeHighlight {
      ranges: Range[];
      constructor(...ranges: Range[]) {
        this.ranges = ranges;
      }
    }
    vi.stubGlobal("Highlight", FakeHighlight);
    Object.defineProperty(CSS, "highlights", {
      configurable: true,
      value: { set, delete: vi.fn(), clear: vi.fn() },
    });

    render(<SearchHarness onClose={vi.fn()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Find in thread" }), {
      target: { value: "alpha" },
    });

    const all = set.mock.calls.find(([key]) => key === "pult-search")?.[1] as FakeHighlight;
    expect(all?.ranges).toHaveLength(3);
    expect(set).toHaveBeenCalledWith("pult-search-active", expect.any(FakeHighlight));
  });
});

describe("MessagesTimeline Mod+F", () => {
  it("opens find-in-thread on Mod+F and searches rendered transcript text", () => {
    useRunsStore.setState({
      runsByThread: { th: [makeRun("r1", "finished", 0)] },
      viewsByRun: {
        r1: {
          items: [
            { type: "user", text: "look here", images: [] },
            { type: "assistant", text: "alpha beta alpha", streaming: false },
          ],
          streaming: false,
          stopReason: "end_turn",
        },
      },
    });

    render(<MessagesTimeline threadId="th" />);
    expect(screen.queryByRole("textbox", { name: "Find in thread" })).toBeNull();

    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = screen.getByRole("textbox", { name: "Find in thread" });
    fireEvent.change(input, { target: { value: "alpha" } });
    expect(screen.getByText("1 of 2")).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("2 of 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close search" }));
    expect(screen.queryByRole("textbox", { name: "Find in thread" })).toBeNull();
  });
});

describe("HistoryTicks kinds", () => {
  it("gives error, edit and plain turns distinct hairlines", () => {
    const ticks: HistoryTick[] = [
      { key: "a", label: "plain turn", globalIndex: 0, kind: "user" },
      { key: "b", label: "edited files", globalIndex: 1, kind: "edit" },
      { key: "c", label: "crashed turn", globalIndex: 2, kind: "error" },
    ];
    const onJump = vi.fn();
    render(<HistoryTicks ticks={ticks} activeKey={null} onJump={onJump} />);

    const hairline = (name: string) =>
      screen.getByRole("button", { name }).querySelector("span") as HTMLElement;
    expect(hairline("plain turn")).toHaveAttribute("data-tick-kind", "user");
    expect(hairline("edited files")).toHaveAttribute("data-tick-kind", "edit");
    expect(hairline("crashed turn")).toHaveAttribute("data-tick-kind", "error");
    expect(hairline("plain turn")).toHaveClass("bg-text-tertiary/60");
    expect(hairline("edited files")).toHaveClass("w-2", "bg-success/75");
    expect(hairline("crashed turn")).toHaveClass("w-2", "bg-danger/75");

    fireEvent.click(screen.getByRole("button", { name: "edited files" }));
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenCalledWith(ticks[1]);
  });

  it("derives the kind from the run: failed runs and editing runs are marked", () => {
    useRunsStore.setState({
      runsByThread: {
        th: [
          makeRun("r1", "finished", 0),
          makeRun("r2", "finished", 1),
          makeRun("r3", "finished", 2),
        ],
      },
      viewsByRun: {
        r1: {
          items: [{ type: "user", text: "plain turn", images: [] }],
          streaming: false,
          stopReason: "end_turn",
        },
        r2: {
          items: [
            { type: "user", text: "edited files", images: [] },
            {
              type: "tool",
              toolCallId: "e1",
              title: "edit",
              kind: "edit",
              status: "completed",
              locations: ["src/a.ts"],
            },
          ],
          streaming: false,
          stopReason: "end_turn",
        },
        r3: {
          items: [{ type: "user", text: "crashed turn", images: [] }],
          streaming: false,
          stopReason: "failed",
        },
      },
    });

    render(<MessagesTimeline threadId="th" />);
    const hairline = (name: string) =>
      screen.getByRole("button", { name }).querySelector("span") as HTMLElement;
    expect(hairline("plain turn")).toHaveClass("bg-text-tertiary/60");
    expect(hairline("edited files")).toHaveClass("bg-success/75");
    expect(hairline("crashed turn")).toHaveClass("bg-danger/75");
  });
});
