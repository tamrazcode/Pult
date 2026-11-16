import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";
import type { QueueItem, Run } from "../src/lib/types";

const {
  navigate,
  runsCancel,
  runsDispatch,
  runsRespondPermission,
  runsQueueRemove,
  runsQueueUpdate,
  runsQueueReorder,
  runsQueueSteer,
  workspaceFiles,
  providersInstancesList,
} = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
  runsCancel: vi.fn(),
  runsDispatch: vi.fn(),
  runsRespondPermission: vi.fn(),
  runsQueueRemove: vi.fn(),
  runsQueueUpdate: vi.fn(),
  runsQueueReorder: vi.fn(),
  runsQueueSteer: vi.fn(),
  workspaceFiles: vi.fn(),
  providersInstancesList: vi.fn(),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    runsCancel,
    runsDispatch,
    runsRespondPermission,
    runsQueueRemove,
    runsQueueUpdate,
    runsQueueReorder,
    runsQueueSteer,
    workspaceFiles,
    providersInstancesList,
    onThreadUpdate: vi.fn(async () => () => {}),
    onAgentProcess: vi.fn(async () => () => {}),
  };
});

vi.mock("../src/lib/tauri", () => ({
  isTauri: () => true,
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate }),
}));

import { Composer } from "../src/components/chat/Composer";
import { useRunsStore } from "../src/stores/runs";
import { useUiStore } from "../src/stores/ui";

const runningRun: Run = {
  id: "r1",
  threadId: "th",
  idx: 0,
  status: "running",
  instanceId: "mock",
  startedAt: 0,
};

function makeQueueItems(): QueueItem[] {
  return [
    {
      id: "q1",
      threadId: "th",
      instanceId: "mock",
      text: "first queued",
      images: [],
      createdAt: 100,
    },
    {
      id: "q2",
      threadId: "th",
      instanceId: "mock",
      text: "second queued",
      images: [],
      createdAt: 200,
    },
  ];
}

describe("queue actions", () => {
  beforeEach(() => {
    navigate.mockReset().mockResolvedValue(undefined);
    runsCancel.mockReset().mockResolvedValue(undefined);
    runsDispatch.mockReset().mockResolvedValue({ run: null, queued: false, queueId: null });
    runsRespondPermission.mockReset().mockResolvedValue(undefined);
    runsQueueRemove.mockReset().mockResolvedValue(undefined);
    runsQueueUpdate.mockReset().mockResolvedValue(undefined);
    runsQueueReorder.mockReset().mockResolvedValue(undefined);
    runsQueueSteer.mockReset().mockResolvedValue(undefined);
    workspaceFiles.mockReset().mockResolvedValue([]);
    providersInstancesList.mockReset().mockResolvedValue([]);

    useRunsStore.setState({
      runsByThread: {},
      viewsByRun: {},
      appliedEvents: {},
      commandsByThread: {},
      queueByThread: { th: makeQueueItems() },
      desiredModeByThread: {},
      desiredConfigByThread: {},
      activeElicitation: null,
    });
    useRunsStore.getState().registerRun(runningRun);
    useUiStore.setState({
      selectedInstanceId: "mock",
      instanceByThread: {},
      paletteOpen: false,
      instances: [],
    });
  });

  it("exports runsQueueUpdate, runsQueueReorder, and runsQueueSteer from src/lib/ipc.ts", async () => {
    const actual = (await vi.importActual<typeof IpcModule>("../src/lib/ipc")) as Record<
      string,
      unknown
    >;

    expect(typeof actual.runsQueueUpdate).toBe("function");
    expect(typeof actual.runsQueueReorder).toBe("function");
    expect(typeof actual.runsQueueSteer).toBe("function");

    const updatePromise = (
      actual.runsQueueUpdate as (threadId: string, queueId: string, text: string) => Promise<void>
    )("th", "q1", "updated");
    const reorderPromise = (
      actual.runsQueueReorder as (threadId: string, queueIds: string[]) => Promise<void>
    )("th", ["q2", "q1"]);
    const steerPromise = (
      actual.runsQueueSteer as (threadId: string, queueId: string) => Promise<void>
    )("th", "q1");

    expect(updatePromise).toBeInstanceOf(Promise);
    expect(reorderPromise).toBeInstanceOf(Promise);
    expect(steerPromise).toBeInstanceOf(Promise);

    await Promise.allSettled([updatePromise, reorderPromise, steerPromise]);
  });

  it("renders reorder handle, pencil Edit button, and Steer button on queue rows", () => {
    render(<Composer threadId="th" />);

    const handles = screen.getAllByLabelText("Reorder queued message");
    expect(handles).toHaveLength(2);
    expect(handles[0].className).toContain("cursor-grab");

    const editButtons = screen.getAllByRole("button", { name: "Edit queued message" });
    expect(editButtons).toHaveLength(2);
    expect(editButtons[0].querySelector("svg.lucide-pencil")).toBeTruthy();

    const steerButtons = screen.getAllByRole("button", { name: "Steer queued message" });
    expect(steerButtons).toHaveLength(2);
  });

  it("edits a queued message in the composer and restores the draft afterwards", async () => {
    render(<Composer threadId="th" />);

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "my draft" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Edit queued message" })[0]);

    expect(runsQueueRemove).not.toHaveBeenCalled();
    expect(textarea.value).toBe("first queued");
    expect(screen.getByText("Editing queued message")).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: "edited queued" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(runsQueueUpdate).toHaveBeenCalledWith("th", "q1", "edited queued"));
    await waitFor(() => expect(textarea.value).toBe("my draft"));
    expect(runsQueueRemove).not.toHaveBeenCalled();
  });

  it("cancels queued-message editing with Escape and keeps the composer draft", () => {
    render(<Composer threadId="th" />);

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "my draft" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Edit queued message" })[0]);
    fireEvent.change(textarea, { target: { value: "aborted via escape" } });
    fireEvent.keyDown(window, { key: "Escape" });

    expect(runsQueueUpdate).not.toHaveBeenCalled();
    expect(runsCancel).not.toHaveBeenCalled();
    expect(textarea.value).toBe("my draft");
  });

  it("calls runsQueueSteer when clicking Steer without calling runsQueueRemove or runsDispatch", async () => {
    render(<Composer threadId="th" />);

    const steerButtons = screen.getAllByRole("button", { name: "Steer queued message" });
    fireEvent.click(steerButtons[1]);

    await waitFor(() => expect(runsQueueSteer).toHaveBeenCalledWith("th", "q2"));
    expect(runsQueueRemove).not.toHaveBeenCalled();
    expect(runsDispatch).not.toHaveBeenCalled();
  });

  it("reorders queued messages with a pointer drag", async () => {
    render(<Composer threadId="th" />);

    const row = screen.getByText("first queued").parentElement!;
    fireEvent.pointerDown(row, { clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(row, { clientY: 44, pointerId: 1 });
    fireEvent.pointerUp(row, { clientY: 44, pointerId: 1 });

    await waitFor(() => expect(runsQueueReorder).toHaveBeenCalledWith("th", ["q2", "q1"]));
  });

  it("renders no inline queue textbox while editing a queued message", () => {
    const { container } = render(<Composer threadId="th" />);

    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    fireEvent.click(screen.getAllByRole("button", { name: "Edit queued message" })[0]);

    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    const cap = container.querySelector(".rounded-t-\\[18px\\]");
    expect(cap).not.toBeNull();
    expect(cap!.querySelectorAll("input, textarea")).toHaveLength(0);
  });
});
