import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Run } from "../src/lib/types";

const { runsCancel, runsDispatch, runsRespondPermission, runsQueueRemove } = vi.hoisted(() => ({
  runsCancel: vi.fn(),
  runsDispatch: vi.fn(),
  runsRespondPermission: vi.fn(),
  runsQueueRemove: vi.fn(),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, runsCancel, runsDispatch, runsRespondPermission, runsQueueRemove };
});

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: vi.fn() }),
}));

import { Composer, formatSlashInsertion, shouldCancelOnEscape } from "../src/components/chat/Composer";
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

describe("composer", () => {
  beforeEach(() => {
    runsCancel.mockReset().mockResolvedValue(undefined);
    runsRespondPermission.mockReset().mockResolvedValue(undefined);
    useRunsStore.setState({
      runsByThread: {},
      viewsByRun: {},
      commandsByThread: {},
      queueByThread: {},
      activeElicitation: null,
    });
    useRunsStore.getState().registerRun(runningRun);
    useUiStore.setState({ selectedInstanceId: "mock", paletteOpen: false, instances: [] });
  });

  it("inserts the leading slash for a picked command", () => {
    expect(formatSlashInsertion({ name: "commit", description: "" })).toBe("/commit ");
  });

  it("cancels the active run on Escape", () => {
    render(<Composer threadId="th" />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(runsCancel).toHaveBeenCalledWith("r1");
  });

  it("does not cancel while the slash menu owns Escape", () => {
    render(<Composer threadId="th" />);
    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "/" } });
    fireEvent.keyDown(textarea, { key: "Escape" });
    expect(runsCancel).not.toHaveBeenCalled();
  });

  it("shows a clickable allow_always option next to allow_once and reject", () => {
    useRunsStore.setState((s) => ({
      viewsByRun: {
        ...s.viewsByRun,
        r1: {
          ...s.viewsByRun.r1,
          pendingApproval: {
            requestId: "req",
            title: "Run the tests?",
            options: [
              { optionId: "o1", name: "Allow once", kind: "allow_once" },
              { optionId: "o2", name: "Always allow", kind: "allow_always" },
              { optionId: "o3", name: "Reject", kind: "reject_once" },
            ],
          },
        },
      },
    }));
    render(<Composer threadId="th" />);
    const always = screen.getByRole("button", { name: /Always allow/ });
    fireEvent.click(always);
    expect(runsRespondPermission).toHaveBeenCalledWith("r1", "req", "o2");
  });

  it("keeps Esc priority rules explicit", () => {
    expect(shouldCancelOnEscape({ runActive: true, overlayOpen: false })).toBe(true);
    expect(shouldCancelOnEscape({ runActive: true, overlayOpen: true })).toBe(false);
    expect(shouldCancelOnEscape({ runActive: false, overlayOpen: false })).toBe(false);
  });
});
