import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";
import type { DelegatedTask } from "../src/lib/types";

const { navigate, orchestratorCancelTask, orchestratorRetryTask, orchestratorSteerTask } =
  vi.hoisted(() => ({
    navigate: vi.fn(async () => undefined),
    orchestratorCancelTask: vi.fn(async () => ({ cancelled: true })),
    orchestratorRetryTask: vi.fn(),
    orchestratorSteerTask: vi.fn(),
  }));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    orchestratorCancelTask,
    orchestratorRetryTask,
    orchestratorSteerTask,
  };
});

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate }),
}));

import { SubagentCard } from "../src/components/chat/SubagentCard";
import { useSubagentsStore } from "../src/stores/subagents";

const makeTask = (overrides: Partial<DelegatedTask> = {}): DelegatedTask => ({
  taskId: "task-1",
  parentThreadId: "th-parent",
  parentRunId: "run-parent",
  childThreadId: "th-child",
  childRunId: "run-child",
  title: "Review auth module",
  promptSummary: "Inspect token verification and report issues.",
  role: "review",
  targetInstanceId: "claude",
  targetModel: "claude-sonnet-4",
  isolation: "shared",
  permissionMode: "supervised",
  status: "running",
  summary: null,
  error: null,
  startedAt: Date.now() - 5_000,
  finishedAt: null,
  durationMs: null,
  ...overrides,
});

describe("SubagentCard", () => {
  beforeEach(() => {
    navigate.mockReset().mockResolvedValue(undefined);
    orchestratorCancelTask.mockReset().mockResolvedValue({ cancelled: true });
    orchestratorRetryTask.mockReset();
    orchestratorSteerTask.mockReset();
    useSubagentsStore.setState({ tasks: {}, order: [], finished: {} });
  });

  it("shows Stop for active tasks and calls orchestratorCancelTask(taskId, true)", () => {
    const task = makeTask({ status: "running" });
    render(<SubagentCard task={task} />);

    expect(screen.getByText("Review auth module")).toBeVisible();
    expect(screen.getByText("Working")).toBeVisible();
    expect(screen.getByText("claude-sonnet-4")).toBeVisible();
    expect(screen.getByText(/· review/)).toBeVisible();
    // The card is compact: the prompt excerpt is not rendered.
    expect(screen.queryByText("Inspect token verification and report issues.")).toBeNull();

    const stopBtn = screen.getByRole("button", { name: "Stop" });
    expect(stopBtn).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    fireEvent.click(stopBtn);
    expect(orchestratorCancelTask).toHaveBeenCalledWith("task-1", true);
  });

  it("shows Retry for terminal tasks and calls orchestratorRetryTask + upserts into store", async () => {
    const failed = makeTask({
      status: "failed",
      error: "child process exited 1",
      finishedAt: Date.now(),
    });
    const restarted = makeTask({
      status: "running",
      childRunId: "run-child-2",
      error: null,
      finishedAt: null,
    });
    useSubagentsStore.getState().upsert(failed);
    orchestratorRetryTask.mockResolvedValue(restarted);

    render(<SubagentCard task={failed} />);

    expect(screen.getByText("Failed")).toBeVisible();
    expect(screen.getByText("child process exited 1")).toBeVisible();

    const retryBtn = screen.getByRole("button", { name: "Retry" });
    expect(retryBtn).toBeVisible();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();

    fireEvent.click(retryBtn);

    await waitFor(() => expect(orchestratorRetryTask).toHaveBeenCalledWith("task-1"));
    await waitFor(() => expect(useSubagentsStore.getState().tasks["task-1"]).toEqual(restarted));
  });

  it("navigates to childThreadId when Open chat is clicked", () => {
    const task = makeTask({ childThreadId: "th-sub-42" });
    render(<SubagentCard task={task} />);

    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    expect(navigate).toHaveBeenCalledWith({
      to: "/thread/$threadId",
      params: { threadId: "th-sub-42" },
    });
  });

  it.each([
    { status: "queued", label: "Queued", active: true },
    { status: "running", label: "Working", active: true },
    { status: "completed", label: "Done", active: false },
    { status: "failed", label: "Failed", active: false },
    { status: "cancelled", label: "Stopped", active: false },
    { status: "orphaned", label: "Failed", active: false },
    { status: "interrupted", label: "Stopped", active: false },
  ])("renders status label '$label' for '$status'", ({ status, label, active }) => {
    const task = makeTask({
      status,
      finishedAt: active ? null : Date.now(),
    });
    render(<SubagentCard task={task} />);

    expect(screen.getByText(label)).toBeVisible();
    if (active) {
      expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    } else {
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    }
  });

  it("omits the prompt and summary excerpts, hides general role, and shows worktree/fallback instance", () => {
    const task = makeTask({
      role: "general",
      targetModel: null,
      targetInstanceId: "codex",
      isolation: "worktree",
      summary: "All tests pass.",
      status: "completed",
      startedAt: 10_000,
      finishedAt: 75_000,
    });
    const { container } = render(<SubagentCard task={task} />);

    expect(container.querySelector('[data-provider-logo="codex"]')).toBeInTheDocument();
    expect(screen.getByText("codex")).toBeVisible();
    expect(screen.queryByText(/· general/)).toBeNull();
    expect(screen.getByText(/· worktree/)).toBeVisible();
    expect(screen.getByText(/· 1m 5s/)).toBeVisible();
    expect(screen.queryByText("All tests pass.")).toBeNull();
    expect(screen.queryByText("Inspect token verification and report issues.")).toBeNull();
  });

  it("opens steer input, sends via button, updates store, closes and clears input", async () => {
    const task = makeTask({ status: "running" });
    const steered = makeTask({ status: "running", summary: "Steered" });
    useSubagentsStore.getState().upsert(task);
    orchestratorSteerTask.mockResolvedValue(steered);

    render(<SubagentCard task={task} />);

    expect(screen.queryByRole("textbox", { name: "Steer" })).toBeNull();
    const steerBtn = screen.getByRole("button", { name: "Steer" });
    fireEvent.click(steerBtn);

    const input = screen.getByRole("textbox", { name: "Steer" });
    const sendBtn = screen.getByRole("button", { name: "Send" });
    expect(input).toBeVisible();
    expect(sendBtn).toBeVisible();

    fireEvent.change(input, { target: { value: "  Focus on auth  " } });
    fireEvent.click(sendBtn);

    await waitFor(() =>
      expect(orchestratorSteerTask).toHaveBeenCalledWith("task-1", "Focus on auth", false),
    );
    await waitFor(() => expect(useSubagentsStore.getState().tasks["task-1"]).toEqual(steered));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Steer" })).toBeNull());

    fireEvent.click(steerBtn);
    expect(screen.getByRole("textbox", { name: "Steer" })).toHaveValue("");
  });

  it("submits steer on Enter and closes without sending on Escape", async () => {
    const task = makeTask({ status: "completed", finishedAt: Date.now() });
    const restarted = makeTask({ status: "running", childRunId: "run-child-3" });
    useSubagentsStore.getState().upsert(task);
    orchestratorSteerTask.mockResolvedValue(restarted);

    render(<SubagentCard task={task} />);

    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    const input = screen.getByRole("textbox", { name: "Steer" });
    fireEvent.change(input, { target: { value: "Do not send" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(orchestratorSteerTask).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "Steer" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    const reopened = screen.getByRole("textbox", { name: "Steer" });
    fireEvent.change(reopened, { target: { value: "Re-check tests" } });
    fireEvent.keyDown(reopened, { key: "Enter" });

    await waitFor(() =>
      expect(orchestratorSteerTask).toHaveBeenCalledWith("task-1", "Re-check tests", false),
    );
    await waitFor(() => expect(useSubagentsStore.getState().tasks["task-1"]).toEqual(restarted));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Steer" })).toBeNull());
  });

  it("does not call orchestratorSteerTask when input is empty or whitespace", () => {
    const task = makeTask({ status: "running" });
    render(<SubagentCard task={task} />);

    fireEvent.click(screen.getByRole("button", { name: "Steer" }));
    const input = screen.getByRole("textbox", { name: "Steer" });
    const sendBtn = screen.getByRole("button", { name: "Send" });

    fireEvent.click(sendBtn);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "   \t  " } });
    fireEvent.click(sendBtn);
    fireEvent.keyDown(input, { key: "Enter" });

    expect(orchestratorSteerTask).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Steer" })).toBeVisible();
  });
});

describe("subagents store merge order", () => {
  it("keeps a finish that arrives before its spawn", () => {
    const store = useSubagentsStore.getState();
    store.applyFinished({ taskId: "task-1", status: "completed", summary: "done" });
    expect(useSubagentsStore.getState().tasks["task-1"]).toBeUndefined();

    store.applySpawned({
      task: makeTask({ taskId: "task-1", status: "running" }),
      parentThreadId: "th-parent",
      parentRunId: "run-parent",
    });

    const task = useSubagentsStore.getState().tasks["task-1"];
    expect(task.status).toBe("completed");
    expect(task.summary).toBe("done");
    expect(useSubagentsStore.getState().finished["task-1"]).toBeUndefined();
  });

  it("does not resurrect a finished task from a stale update or snapshot", () => {
    const store = useSubagentsStore.getState();
    store.applySpawned({
      task: makeTask({ taskId: "task-1", status: "running" }),
      parentThreadId: "th-parent",
      parentRunId: "run-parent",
    });
    store.applyFinished({ taskId: "task-1", status: "completed", summary: "done" });

    store.applyUpdated({ taskId: "task-1", status: "running" });
    expect(useSubagentsStore.getState().tasks["task-1"].status).toBe("completed");

    // Same attempt in a stale snapshot: the terminal status wins.
    store.upsert(makeTask({ taskId: "task-1", status: "running" }));
    expect(useSubagentsStore.getState().tasks["task-1"].status).toBe("completed");
    expect(useSubagentsStore.getState().tasks["task-1"].summary).toBe("done");
  });

  it("accepts a new attempt (new childRunId) after a finish", () => {
    const store = useSubagentsStore.getState();
    store.upsert(makeTask({ taskId: "task-1", status: "completed", summary: "done" }));

    store.upsert(makeTask({ taskId: "task-1", status: "running", childRunId: "run-child-2" }));

    expect(useSubagentsStore.getState().tasks["task-1"].status).toBe("running");
  });
});
