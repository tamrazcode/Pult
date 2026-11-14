import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Run, Thread } from "../src/lib/types";

const { navigate, runsCancel, threadsDelete, threadsRename, threadsSetPinned, threadsSetStatus } =
  vi.hoisted(() => ({
    navigate: vi.fn(),
    runsCancel: vi.fn(),
    threadsDelete: vi.fn(),
    threadsRename: vi.fn(),
    threadsSetPinned: vi.fn(),
    threadsSetStatus: vi.fn(),
  }));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    runsCancel,
    threadsDelete,
    threadsRename,
    threadsSetPinned,
    threadsSetStatus,
  };
});

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate }),
}));

import { ChatHeader } from "../src/components/chat/ChatHeader";
import { shelfDropTarget } from "../src/components/layout/Sidebar";
import { useRunsStore } from "../src/stores/runs";
import { useThreadsStore } from "../src/stores/threads";

const thread: Thread = {
  id: "th",
  projectId: null,
  title: "Old title",
  status: "draft",
  pinned: false,
  createdAt: 0,
  updatedAt: 0,
};

const runningRun: Run = {
  id: "r1",
  threadId: "th",
  idx: 0,
  status: "running",
  instanceId: "mock",
  startedAt: 0,
};

describe("thread actions", () => {
  beforeEach(() => {
    navigate.mockReset().mockResolvedValue(undefined);
    runsCancel.mockReset().mockResolvedValue(undefined);
    threadsDelete.mockReset().mockResolvedValue(undefined);
    threadsRename.mockReset().mockResolvedValue(undefined);
    threadsSetPinned.mockReset().mockResolvedValue(undefined);
    threadsSetStatus.mockReset().mockResolvedValue(undefined);
    useThreadsStore.setState({ threads: [thread], activeThreadId: "th", loaded: true });
    useRunsStore.setState({
      runsByThread: {},
      viewsByRun: {},
      appliedEvents: {},
      queueByThread: {},
      desiredModeByThread: {},
      activeElicitation: null,
    });
    useRunsStore.getState().registerRun(runningRun);
  });

  it("renames a thread with a trimmed title", async () => {
    render(<ChatHeader title="Old title" threadId="th" />);
    fireEvent.click(screen.getByRole("button", { name: "Rename thread" }));
    const input = screen.getByLabelText("Thread title");
    fireEvent.change(input, { target: { value: "  New title  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(threadsRename).toHaveBeenCalledWith("th", "New title"));
    expect(useThreadsStore.getState().threads[0].title).toBe("New title");
  });

  it("pins the thread and reflects it in the store", async () => {
    render(<ChatHeader title="Old title" threadId="th" />);
    fireEvent.click(screen.getByRole("button", { name: "Pin thread" }));
    await waitFor(() => expect(threadsSetPinned).toHaveBeenCalledWith("th", true));
    expect(useThreadsStore.getState().threads[0].pinned).toBe(true);
  });

  it("cancels the live run, deletes the thread and leaves the chat", async () => {
    render(<ChatHeader title="Old title" threadId="th" />);
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete thread/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(threadsDelete).toHaveBeenCalledWith("th"));
    expect(runsCancel).toHaveBeenCalledWith("r1");
    expect(navigate).toHaveBeenCalledWith({ to: "/chat" });
    expect(useThreadsStore.getState().threads).toHaveLength(0);
    expect(useRunsStore.getState().runsByThread["th"]).toBeUndefined();
  });

  it("closes its action menu on Escape without leaving the thread", async () => {
    render(<ChatHeader title="Old title" threadId="th" />);
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    expect(document.querySelector("[data-escape-layer]")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: /Delete thread/ })).toBeNull(),
    );
    expect(threadsDelete).not.toHaveBeenCalled();
  });

  it("stays on the thread when deletion fails", async () => {
    threadsDelete.mockRejectedValueOnce(new Error("nope"));
    render(<ChatHeader title="Old title" threadId="th" />);
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete thread/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(threadsDelete).toHaveBeenCalledWith("th"));
    expect(navigate).not.toHaveBeenCalled();
    expect(useThreadsStore.getState().threads).toHaveLength(1);
  });

  it("does not offer the working shelf as a drag target", () => {
    expect(shelfDropTarget("working")).toBeNull();
    expect(shelfDropTarget("snoozed")).toEqual({ status: "snoozed", pinned: false });
  });
});
