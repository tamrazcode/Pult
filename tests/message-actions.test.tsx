import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";
import type { Run, Thread } from "../src/lib/types";

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: vi.fn(async () => undefined) }),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/chat" } }),
}));

const { threadsCreate } = vi.hoisted(() => ({
  threadsCreate: vi.fn(),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    threadsCreate,
  };
});

vi.mock("../src/components/chat/Markdown", () => ({
  default: ({ text }: { text: string }) => <div>{text}</div>,
}));

import { MessagesTimeline, formatElapsed } from "../src/components/chat/MessagesTimeline";
import { formatTime } from "../src/lib/i18n";
import { useRunsStore } from "../src/stores/runs";
import { useSettingsStore } from "../src/stores/settings";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

const baseThread: Thread = {
  id: "th-1",
  projectId: "proj-1",
  title: "Source thread",
  status: "settled",
  pinned: false,
  createdAt: 1000,
  updatedAt: 2000,
  workspace: "C:\\work\\proj-1",
};

const finishedRun: Run = {
  id: "r1",
  threadId: "th-1",
  idx: 0,
  status: "finished",
  instanceId: "mock",
  startedAt: 1000,
};

const sampleTs = new Date(2026, 0, 15, 14, 5).getTime();
const expectedTimeLabel = formatTime(sampleTs, "en", false);

describe("MessageActions", () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    threadsCreate.mockReset();
    writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    useThreadsStore.setState({
      threads: [baseThread],
      activeThreadId: "th-1",
      unreadIds: [],
      loaded: true,
    });
    useUiStore.setState({
      composerPrefill: null,
      pendingThreadId: null,
      globalError: null,
    });
    useSettingsStore.setState({
      showTimestamps: true,
    });
    useRunsStore.setState({
      runsByThread: { "th-1": [finishedRun] },
      viewsByRun: {
        r1: {
          items: [
            { type: "user", text: "User prompt", images: [], ts: sampleTs },
            { type: "assistant", text: "Assistant reply", streaming: false, ts: sampleTs },
          ],
          streaming: false,
          stopReason: "end_turn",
        },
      },
      appliedEvents: {},
      commandsByThread: {},
      queueByThread: {},
    });
  });

  it("renders Copy message and Branch from message buttons on finished user and assistant messages", () => {
    render(<MessagesTimeline threadId="th-1" />);

    expect(screen.getAllByRole("button", { name: "Copy message" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Branch from message" })).toHaveLength(2);
  });

  it("writes the message text to navigator.clipboard when clicking Copy message", () => {
    render(<MessagesTimeline threadId="th-1" />);

    const copyButtons = screen.getAllByRole("button", { name: "Copy message" });
    fireEvent.click(copyButtons[0]);
    expect(writeText).toHaveBeenCalledWith("User prompt");

    fireEvent.click(copyButtons[1]);
    expect(writeText).toHaveBeenCalledWith("Assistant reply");
  });

  it("branches into a new thread and sets ui.composerPrefill and ui.pendingThreadId", async () => {
    const branchedThread: Thread = {
      ...baseThread,
      id: "th-branch",
      title: "Branch: Assistant reply",
    };
    threadsCreate.mockResolvedValueOnce(branchedThread);
    const createThreadSpy = vi.spyOn(useThreadsStore.getState(), "createThread");

    render(<MessagesTimeline threadId="th-1" />);

    const branchButtons = screen.getAllByRole("button", { name: "Branch from message" });
    fireEvent.click(branchButtons[1]);

    await waitFor(() =>
      expect(createThreadSpy).toHaveBeenCalledWith("proj-1", "Branch: Assistant reply", {
        workspace: "C:\\work\\proj-1",
        worktree: false,
      }),
    );
    await waitFor(() => {
      expect(useUiStore.getState().composerPrefill).toBe("Assistant reply");
      expect(useUiStore.getState().pendingThreadId).toBe("th-branch");
    });
  });

  it("shows timestamps when settings.showTimestamps is true and hides them when false", () => {
    const { rerender } = render(<MessagesTimeline threadId="th-1" />);

    expect(screen.getAllByText(expectedTimeLabel)).toHaveLength(1);
    const escaped = expectedTimeLabel!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    expect(screen.getByText(new RegExp(`^${escaped} · `))).toBeInTheDocument();

    useSettingsStore.setState({ showTimestamps: false });
    rerender(<MessagesTimeline threadId="th-1" />);

    expect(screen.queryByText(expectedTimeLabel)).toBeNull();
    expect(screen.queryByText(new RegExp(`^${escaped} · `))).toBeNull();
  });

  it("formats the elapsed offset in seconds, minutes and hours", () => {
    expect(formatElapsed(1_000, 47_000)).toBe("46s");
    expect(formatElapsed(1_000, 126_000)).toBe("2m 5s");
    expect(formatElapsed(1_000, 3_781_000)).toBe("1h 3m");
  });
});
