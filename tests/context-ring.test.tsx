import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";

const { mcpActiveForThread, mcpSetBinding } = vi.hoisted(() => ({
  mcpActiveForThread: vi.fn(async (): Promise<unknown> => []),
  mcpSetBinding: vi.fn(async (): Promise<void> => undefined),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return { ...actual, mcpActiveForThread, mcpSetBinding };
});

vi.mock("../src/lib/tauri", () => ({ isTauri: () => true }));

import { ContextRing } from "../src/components/chat/ContextRing";
import { useRunsStore } from "../src/stores/runs";
import { useUiStore } from "../src/stores/ui";

const THREAD = "t1";

describe("ContextRing", () => {
  beforeEach(() => {
    mcpActiveForThread.mockReset().mockResolvedValue([]);
    mcpSetBinding.mockReset().mockResolvedValue(undefined);
    useRunsStore.setState({ runsByThread: {}, viewsByRun: {} });
    useUiStore.setState({ selectedInstanceId: "inst", instanceByThread: {} });
  });

  it("shows the latest usage percentage and compacts on click", async () => {
    const onCompact = vi.fn();
    useRunsStore.setState({
      runsByThread: {
        [THREAD]: [
          {
            id: "r1",
            threadId: THREAD,
            idx: 0,
            status: "finished",
            instanceId: "inst",
            startedAt: 0,
          },
        ],
      },
      viewsByRun: { r1: { items: [], streaming: false, usage: { used: 50, size: 200 } } },
    });

    render(<ContextRing threadId={THREAD} onCompact={onCompact} />);

    const ring = screen.getByRole("button", { name: "Compact context (/compact)" });
    expect(ring).toHaveTextContent("25%");
    fireEvent.click(ring);
    expect(onCompact).toHaveBeenCalledTimes(1);
  });

  it("renders nothing without a context window or active servers", async () => {
    const { container } = render(<ContextRing threadId={THREAD} />);

    await waitFor(() => expect(mcpActiveForThread).toHaveBeenCalledWith(THREAD, "inst"));
    expect(container).toBeEmptyDOMElement();
  });

  it("lists active MCP servers and excludes one", async () => {
    mcpActiveForThread.mockResolvedValue([{ id: "s1", name: "Files" }]);

    render(<ContextRing threadId={THREAD} />);

    const counter = await screen.findByRole("button", { name: "1 MCP active" });
    expect(counter).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(counter);

    expect(screen.getByText("Files")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));

    expect(mcpSetBinding).toHaveBeenCalledWith("thread", THREAD, "s1", "exclude");
    await waitFor(() => expect(screen.queryByRole("button", { name: "1 MCP active" })).toBeNull());
  });
});
