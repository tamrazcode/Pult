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

function makeDataTransfer() {
  const store = new Map<string, string>();
  return {
    effectAllowed: "move",
    dropEffect: "move",
    setData: (type: string, value: string) => {
      store.set(type, value);
    },
    getData: (type: string) => store.get(type) ?? "",
  };
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

  it("renders draggable reorder handle, pencil Edit button, and Steer button on queue rows", () => {
    render(<Composer threadId="th" />);

    const handles = screen.getAllByLabelText("Reorder queued message");
    expect(handles).toHaveLength(2);
    expect(handles[0].closest("[draggable='true']")).toBeTruthy();

    const editButtons = screen.getAllByRole("button", { name: "Edit queued message" });
    expect(editButtons).toHaveLength(2);
    expect(editButtons[0].querySelector("svg.lucide-pencil")).toBeTruthy();

    const steerButtons = screen.getAllByRole("button", { name: "Steer queued message" });
    expect(steerButtons).toHaveLength(2);
  });

  it("edits a queued message inline with Save and Cancel without calling runsQueueRemove", async () => {
    render(<Composer threadId="th" />);

    const editButtons = screen.getAllByRole("button", { name: "Edit queued message" });
    fireEvent.click(editButtons[0]);

    expect(runsQueueRemove).not.toHaveBeenCalled();

    const editBox = screen.getByDisplayValue("first queued");
    expect(screen.getAllByRole("textbox")).toContain(editBox);
    const saveBtn = screen.getByRole("button", { name: /^save$/i });
    const cancelBtn = screen.getByRole("button", { name: /^cancel$/i });
    expect(saveBtn).toBeInTheDocument();
    expect(cancelBtn).toBeInTheDocument();

    fireEvent.change(editBox, { target: { value: "edited queued" } });
    fireEvent.click(saveBtn);

    await waitFor(() => expect(runsQueueUpdate).toHaveBeenCalledWith("th", "q1", "edited queued"));
    expect(runsQueueRemove).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByRole("button", { name: "Edit queued message" })[0]);
    const editBoxAgain = screen.getByDisplayValue("first queued");
    fireEvent.change(editBoxAgain, { target: { value: "discarded edit" } });
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    expect(runsQueueUpdate).toHaveBeenCalledTimes(1);
    expect(runsQueueRemove).not.toHaveBeenCalled();
    expect(screen.getByText("first queued")).toBeInTheDocument();
  });

  it("saves inline edit on Enter and cancels on Escape without cancelling the active run", async () => {
    render(<Composer threadId="th" />);

    fireEvent.click(screen.getAllByRole("button", { name: "Edit queued message" })[0]);
    const editBox = screen.getByDisplayValue("first queued");
    fireEvent.change(editBox, { target: { value: "saved via enter" } });
    fireEvent.keyDown(editBox, { key: "Enter" });

    await waitFor(() =>
      expect(runsQueueUpdate).toHaveBeenCalledWith("th", "q1", "saved via enter"),
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Edit queued message" })[0]);
    const editBoxAgain = screen.getByDisplayValue("first queued");
    fireEvent.change(editBoxAgain, { target: { value: "aborted via escape" } });
    fireEvent.keyDown(editBoxAgain, { key: "Escape" });

    expect(runsQueueUpdate).toHaveBeenCalledTimes(1);
    expect(runsCancel).not.toHaveBeenCalled();
    expect(screen.getByText("first queued")).toBeInTheDocument();
  });

  it("calls runsQueueSteer when clicking Steer without calling runsQueueRemove or runsDispatch", async () => {
    render(<Composer threadId="th" />);

    const steerButtons = screen.getAllByRole("button", { name: "Steer queued message" });
    fireEvent.click(steerButtons[1]);

    await waitFor(() => expect(runsQueueSteer).toHaveBeenCalledWith("th", "q2"));
    expect(runsQueueRemove).not.toHaveBeenCalled();
    expect(runsDispatch).not.toHaveBeenCalled();
  });

  it("reorders queued messages on HTML5 dragstart, dragover, and drop", async () => {
    render(<Composer threadId="th" />);

    const handles = screen.getAllByLabelText("Reorder queued message");
    const dataTransfer = makeDataTransfer();

    fireEvent.dragStart(handles[0], { dataTransfer });
    fireEvent.dragOver(handles[1], { dataTransfer });
    fireEvent.drop(handles[1], { dataTransfer });

    await waitFor(() => expect(runsQueueReorder).toHaveBeenCalledWith("th", ["q2", "q1"]));
  });
});
