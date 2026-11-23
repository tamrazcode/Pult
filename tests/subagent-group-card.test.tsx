import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { DelegatedTask } from "../src/lib/types";

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: vi.fn(async () => undefined) }),
}));

import { SubagentGroupCard } from "../src/components/chat/SubagentGroupCard";

const makeTask = (overrides: Partial<DelegatedTask> = {}): DelegatedTask => ({
  taskId: "task-1",
  parentThreadId: "th-parent",
  parentRunId: "run-parent",
  childThreadId: "th-child-1",
  childRunId: "run-child-1",
  title: "First subagent",
  promptSummary: "Inspect module A",
  role: "review",
  targetInstanceId: "claude",
  targetModel: "claude-sonnet-4",
  isolation: "shared",
  permissionMode: "supervised",
  status: "running",
  summary: null,
  error: null,
  startedAt: Date.now() - 4_000,
  finishedAt: null,
  durationMs: null,
  ...overrides,
});

describe("SubagentGroupCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders collapsed group header for 2 tasks and toggles SubagentCard children on click", () => {
    const tasks = [
      makeTask({
        taskId: "task-1",
        title: "Review auth",
        targetInstanceId: "claude",
        status: "running",
      }),
      makeTask({
        taskId: "task-2",
        childThreadId: "th-child-2",
        title: "Write tests",
        targetInstanceId: "codex",
        status: "completed",
        finishedAt: Date.now(),
      }),
    ];

    const { container } = render(<SubagentGroupCard tasks={tasks} />);

    expect(container.querySelectorAll("[data-subagent-group]")).toHaveLength(1);
    const toggle = screen.getByRole("button", { name: /2 subagents/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("2 subagents")).toBeVisible();
    expect(screen.getByText("1 working")).toBeVisible();
    expect(container.querySelector('[data-provider-logo="claude"]')).toBeInTheDocument();
    expect(container.querySelector('[data-provider-logo="codex"]')).toBeInTheDocument();

    expect(container.querySelectorAll("[data-subagent-card]")).toHaveLength(0);
    expect(screen.queryByText("Review auth")).toBeNull();
    expect(screen.queryByText("Write tests")).toBeNull();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelectorAll("[data-subagent-card]")).toHaveLength(2);
    expect(screen.getByText("Review auth")).toBeVisible();
    expect(screen.getByText("Write tests")).toBeVisible();

    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelectorAll("[data-subagent-card]")).toHaveLength(0);
  });

  it("shows failed count and done summary when no tasks are active, and caps stacked logos at 4", () => {
    const failedTasks = [
      makeTask({
        taskId: "t1",
        status: "failed",
        finishedAt: Date.now(),
        targetInstanceId: "claude",
      }),
      makeTask({
        taskId: "t2",
        status: "completed",
        finishedAt: Date.now(),
        targetInstanceId: "codex",
      }),
    ];
    const { container, rerender } = render(<SubagentGroupCard tasks={failedTasks} />);
    expect(screen.getByText("1 failed")).toBeVisible();

    const fiveCompleted = [
      makeTask({
        taskId: "t1",
        status: "completed",
        finishedAt: Date.now(),
        targetInstanceId: "claude",
      }),
      makeTask({
        taskId: "t2",
        status: "completed",
        finishedAt: Date.now(),
        targetInstanceId: "codex",
      }),
      makeTask({
        taskId: "t3",
        status: "completed",
        finishedAt: Date.now(),
        targetInstanceId: "gemini",
      }),
      makeTask({
        taskId: "t4",
        status: "completed",
        finishedAt: Date.now(),
        targetInstanceId: "opencode",
      }),
      makeTask({
        taskId: "t5",
        status: "completed",
        finishedAt: Date.now(),
        targetInstanceId: "cursor",
      }),
    ];
    rerender(<SubagentGroupCard tasks={fiveCompleted} />);
    expect(screen.getByText("5 subagents")).toBeVisible();
    expect(screen.getByText("done")).toBeVisible();
    expect(container.querySelectorAll("[data-provider-logo]")).toHaveLength(4);
  });
});
