import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

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

import { FleetStrip } from "../src/components/chat/FleetStrip";
import { MessagesTimeline } from "../src/components/chat/MessagesTimeline";
import type { ChatItem, ToolChatItem } from "../src/stores/runs";
import { useRunsStore } from "../src/stores/runs";
import { useSubagentsStore } from "../src/stores/subagents";
import { useSettingsStore } from "../src/stores/settings";
import { useUiStore } from "../src/stores/ui";
import { useGitStore } from "../src/stores/git";
import type { DelegatedTask, Run } from "../src/lib/types";

const makeRun = (id: string, idx: number): Run => ({
  id,
  threadId: "th",
  idx,
  status: "finished",
  instanceId: "mock",
  startedAt: 0,
});

const makeTask = (taskId: string, title: string, status: string): DelegatedTask => ({
  taskId,
  parentThreadId: "th",
  parentRunId: "r1",
  childThreadId: `child-${taskId}`,
  title,
  promptSummary: "",
  targetInstanceId: "mock",
  isolation: "shared",
  permissionMode: "default",
  status,
  startedAt: 0,
});

const tool = (id: string, kind: "read" | "edit" | "search", path: string): ToolChatItem => ({
  type: "tool",
  toolCallId: id,
  title: kind,
  kind,
  status: "completed",
  locations: [path],
});

// The mock store is a plain zustand slice; the real one is owned by Wave 4C-2.
const gitState = useGitStore as unknown as {
  setState: (partial: { byThread: Record<string, unknown> }) => void;
};

beforeEach(() => {
  loadCheckpoints.mockClear().mockResolvedValue(undefined);
  viewCheckpointDiff.mockClear().mockResolvedValue(undefined);
  restoreCheckpoint.mockClear().mockResolvedValue(true);
  gitState.setState({ byThread: {} });
  Element.prototype.scrollIntoView = vi.fn();
  useRunsStore.setState({
    runsByThread: {},
    viewsByRun: {},
    appliedEvents: {},
    commandsByThread: {},
    queueByThread: {},
    pendingUserByThread: {},
  });
  useSubagentsStore.setState({ tasks: {}, order: [] });
  useSettingsStore.setState({ transcriptVerbosity: "full" });
  useUiStore.setState({ rightPanelTab: "none", rightPanelOpen: false });
});

describe("FleetStrip", () => {
  it("shows one flat strip for two or more active subagents and opens the diff panel", () => {
    useSubagentsStore.setState({
      tasks: {
        a: makeTask("a", "Alpha task", "running"),
        b: makeTask("b", "Beta task", "queued"),
      },
      order: ["a", "b"],
    });

    const { container } = render(<FleetStrip threadId="th" />);
    expect(screen.getByText("2 subagents working")).toBeInTheDocument();
    expect(screen.getByText("Alpha task · Beta task")).toBeInTheDocument();
    expect(container.querySelector(".rounded-full")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "View worktree diff" }));
    expect(useUiStore.getState().rightPanelTab).toBe("diff");
  });

  it("renders nothing for a single active subagent", () => {
    useSubagentsStore.setState({
      tasks: {
        a: makeTask("a", "Alpha task", "running"),
        b: makeTask("b", "Beta task", "completed"),
      },
      order: ["a", "b"],
    });

    const { container } = render(<FleetStrip threadId="th" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when no subagent is active", () => {
    useSubagentsStore.setState({
      tasks: { a: makeTask("a", "Alpha task", "completed") },
      order: ["a"],
    });

    const { container } = render(<FleetStrip threadId="th" />);
    expect(container.firstChild).toBeNull();
  });
});

describe("Quiet transcript", () => {
  it("folds consecutive reads and searches into one compact sub-row", () => {
    useSettingsStore.setState({ transcriptVerbosity: "quiet" });
    const items: ChatItem[] = [
      tool("r1", "read", "src/a.ts"),
      tool("r2", "read", "src/b.ts"),
      tool("r3", "read", "src/c.ts"),
      tool("s1", "search", "src/d.ts"),
      tool("s2", "search", "src/e.ts"),
    ];
    useRunsStore.setState({
      runsByThread: { th: [makeRun("r1", 0)] },
      viewsByRun: { r1: { items, streaming: false, stopReason: "end_turn" } },
    });

    render(<MessagesTimeline threadId="th" />);
    const summary = screen.getByRole("button", { name: "Explored 5 steps" });
    expect(screen.queryByText("Read src/a.ts")).toBeNull();

    fireEvent.click(summary);
    const group = screen.getByRole("button", { name: "Read 3 files · 2 searches" });
    expect(screen.queryByText("Read src/a.ts")).toBeNull();

    fireEvent.click(group);
    expect(screen.getByText("Read src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("Searched in src/d.ts")).toBeInTheDocument();
  });

  it("keeps edits directly visible while folding the reads around them", () => {
    useSettingsStore.setState({ transcriptVerbosity: "quiet" });
    const items: ChatItem[] = [
      tool("r1", "read", "src/a.ts"),
      tool("r2", "read", "src/b.ts"),
      tool("e1", "edit", "src/c.ts"),
    ];
    useRunsStore.setState({
      runsByThread: { th: [makeRun("r1", 0)] },
      viewsByRun: { r1: { items, streaming: false, stopReason: "end_turn" } },
    });

    const { container } = render(<MessagesTimeline threadId="th" />);
    const summary = container.querySelector("button[aria-expanded]") as HTMLElement;
    fireEvent.click(summary);

    expect(screen.getByText("Edited src/c.ts")).toBeVisible();
    expect(screen.queryByText("Read src/a.ts")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Read 2 files" }));
    expect(screen.getByText("Read src/a.ts")).toBeInTheDocument();
  });

  it("keeps commands and thoughts visible while folding consecutive reads", () => {
    useSettingsStore.setState({ transcriptVerbosity: "quiet" });
    const items: ChatItem[] = [
      tool("r1", "read", "src/a.ts"),
      tool("r2", "read", "src/b.ts"),
      {
        type: "tool",
        toolCallId: "x1",
        title: "shell",
        kind: "shell",
        status: "completed",
        locations: [],
        rawInput: { command: "pnpm test" },
      },
      {
        type: "thought",
        text: "Consider it",
        streaming: false,
        startedAt: 1_000,
        endedAt: 3_000,
      },
    ];
    useRunsStore.setState({
      runsByThread: { th: [makeRun("r1", 0)] },
      viewsByRun: { r1: { items, streaming: false, stopReason: "end_turn" } },
    });

    render(<MessagesTimeline threadId="th" />);
    fireEvent.click(screen.getByRole("button", { name: /Ran 1 command/ }));

    expect(screen.getByText("Ran pnpm test")).toBeVisible();
    expect(screen.getByText("Consider it · 2s")).toBeVisible();
    expect(screen.queryByText("Read src/a.ts")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Read 2 files" }));
    expect(screen.getByText("Read src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("Read src/b.ts")).toBeInTheDocument();
  });
});

describe("Turn diff and rollback", () => {
  it("opens the checkpoint diff and confirms a rollback inline before restoring", async () => {
    gitState.setState({
      byThread: { th: { checkpoints: ["r1"], restoringCheckpoint: null } },
    });
    useRunsStore.setState({
      runsByThread: { th: [makeRun("r1", 0)] },
      viewsByRun: {
        r1: {
          items: [
            { type: "user", text: "change it", images: [] },
            { type: "assistant", text: "done", streaming: false },
          ],
          streaming: false,
          stopReason: "end_turn",
        },
      },
    });

    render(<MessagesTimeline threadId="th" />);
    expect(loadCheckpoints).toHaveBeenCalledWith("th");

    fireEvent.click(screen.getByRole("button", { name: "Turn diff" }));
    expect(viewCheckpointDiff).toHaveBeenCalledWith("th", "r1");
    expect(useUiStore.getState().rightPanelTab).toBe("diff");

    fireEvent.click(screen.getByRole("button", { name: "Rollback" }));
    expect(
      screen.getByText("Restore workspace files to this turn's checkpoint?"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText("Restore workspace files to this turn's checkpoint?")).toBeNull();
    expect(restoreCheckpoint).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Rollback" }));
    fireEvent.click(screen.getByRole("button", { name: "Yes" }));
    await waitFor(() => expect(restoreCheckpoint).toHaveBeenCalledWith("th", "r1"));
    await waitFor(() =>
      expect(screen.getByText("Workspace restored to checkpoint")).toBeInTheDocument(),
    );
  });

  it("shows the restoring line and hides the actions while a restore is in flight", () => {
    gitState.setState({
      byThread: { th: { checkpoints: ["r1"], restoringCheckpoint: "r1" } },
    });
    useRunsStore.setState({
      runsByThread: { th: [makeRun("r1", 0)] },
      viewsByRun: {
        r1: {
          items: [{ type: "user", text: "change it", images: [] }],
          streaming: false,
          stopReason: "end_turn",
        },
      },
    });

    render(<MessagesTimeline threadId="th" />);
    expect(screen.getByText("Restoring…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rollback" })).toBeNull();
  });

  it("renders no turn actions for a run without a checkpoint", () => {
    useRunsStore.setState({
      runsByThread: { th: [makeRun("r1", 0)] },
      viewsByRun: {
        r1: {
          items: [{ type: "user", text: "no checkpoint", images: [] }],
          streaming: false,
          stopReason: "end_turn",
        },
      },
    });

    render(<MessagesTimeline threadId="th" />);
    expect(screen.queryByRole("button", { name: "Turn diff" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rollback" })).toBeNull();
  });
});
