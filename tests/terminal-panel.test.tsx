import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as IpcModule from "../src/lib/ipc";
import type { PtyInfo } from "../src/lib/types";

const { terminalPtyList, terminalPtyCreate, terminalPtyKill } = vi.hoisted(() => ({
  terminalPtyList: vi.fn(async (): Promise<PtyInfo[]> => []),
  terminalPtyCreate: vi.fn(async (): Promise<PtyInfo> => ({
    terminalId: "pty-1",
    threadId: "t1",
    title: "pwsh",
    exit: null,
  })),
  terminalPtyKill: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    terminalPtyList,
    terminalPtyCreate,
    terminalPtyKill,
  };
});

vi.mock("../src/components/terminal/TerminalPane", () => ({
  TerminalPane: ({ terminalId }: { terminalId: string }) => (
    <div data-testid="terminal-pane">{terminalId}</div>
  ),
}));

import { TerminalPanel } from "../src/components/terminal/TerminalPanel";
import { useRunsStore } from "../src/stores/runs";
import { useTerminalsStore } from "../src/stores/terminals";
import { useThreadsStore } from "../src/stores/threads";

describe("TerminalPanel", () => {
  beforeEach(() => {
    terminalPtyList.mockReset().mockResolvedValue([]);
    terminalPtyCreate.mockReset().mockResolvedValue({
      terminalId: "pty-1",
      threadId: "t1",
      title: "pwsh",
      exit: null,
    });
    terminalPtyKill.mockReset().mockResolvedValue(undefined);
    useTerminalsStore.setState({ byThread: {}, activeByThread: {}, backfill: {} });
    useRunsStore.setState({ runsByThread: {}, viewsByRun: {} });
    useThreadsStore.setState({
      threads: [
        {
          id: "t1",
          projectId: null,
          title: "Thread 1",
          workspace: "/repo",
          status: "draft",
          pinned: false,
          createdAt: 100,
          updatedAt: 100,
        },
      ],
      activeThreadId: "t1",
      unreadIds: [],
      loaded: true,
    });
  });

  it("shows an inline alert with the error message when terminalPtyCreate rejects", async () => {
    const user = userEvent.setup();
    terminalPtyCreate.mockRejectedValueOnce(new Error("pty spawn failed"));

    render(<TerminalPanel threadId="t1" />);

    await user.click(screen.getByRole("button", { name: /New terminal/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("pty spawn failed");
  });

  it("keeps the tab visible and shows an alert when terminalPtyKill rejects, then removes on success", async () => {
    const user = userEvent.setup();
    terminalPtyList.mockResolvedValueOnce([
      { terminalId: "pty-1", threadId: "t1", title: "pwsh", exit: null },
    ]);
    terminalPtyKill.mockRejectedValueOnce(new Error("kill failed"));

    render(<TerminalPanel threadId="t1" />);

    const tab = await screen.findByRole("button", { name: /pwsh/i });
    expect(tab).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Kill terminal" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("kill failed");
    expect(screen.getByRole("button", { name: /pwsh/i })).toBeVisible();

    terminalPtyKill.mockResolvedValueOnce(undefined);
    await user.click(screen.getByRole("button", { name: "Kill terminal" }));

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /pwsh/i })).toBeNull();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
