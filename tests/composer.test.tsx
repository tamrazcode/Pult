import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Run } from "../src/lib/types";

const { runsCancel, runsDispatch, runsRespondPermission, runsQueueRemove, workspaceFiles } =
  vi.hoisted(() => ({
    runsCancel: vi.fn(),
    runsDispatch: vi.fn(),
    runsRespondPermission: vi.fn(),
    runsQueueRemove: vi.fn(),
    workspaceFiles: vi.fn(),
  }));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    runsCancel,
    runsDispatch,
    runsRespondPermission,
    runsQueueRemove,
    workspaceFiles,
  };
});

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: vi.fn() }),
}));

import {
  Composer,
  extractMentionQuery,
  formatSlashInsertion,
  modeForSend,
  shouldCancelOnEscape,
} from "../src/components/chat/Composer";
import { pickerModeId } from "../src/components/chat/ComposerControls";
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
    workspaceFiles.mockReset().mockResolvedValue([]);
    useRunsStore.setState({
      runsByThread: {},
      viewsByRun: {},
      appliedEvents: {},
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

  it("does not cancel while a picker layer owns Escape", () => {
    render(<Composer threadId="th" />);
    const layer = document.createElement("div");
    layer.setAttribute("data-escape-layer", "");
    document.body.appendChild(layer);
    try {
      fireEvent.keyDown(window, { key: "Escape" });
      expect(runsCancel).not.toHaveBeenCalled();
    } finally {
      layer.remove();
    }
  });

  it("picks a slash command with the leading slash in the textarea", () => {
    render(<Composer threadId="th" />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "/com" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("/commit ");
  });

  it("detects an @ token at the caret and ignores emails", () => {
    expect(extractMentionQuery("look at @src/ma", 15)).toEqual({ start: 8, query: "src/ma" });
    expect(extractMentionQuery("foo@bar.com", 11)).toBeNull();
    expect(extractMentionQuery("done @main.ts ", 14)).toBeNull();
  });

  it("picks a workspace file for an @ mention", async () => {
    workspaceFiles.mockResolvedValue(["src/main.ts", "docs/readme.md"]);
    render(<Composer threadId="th" />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "look @mai" } });
    expect(await screen.findByText("src/main.ts")).toBeTruthy();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("look @src/main.ts ");
  });

  it("keeps the /chat mode out of existing threads", () => {
    const desired = { "": "architect", th2: "code" };
    expect(modeForSend(desired, "th2")).toBe("code");
    expect(modeForSend(desired, "th3")).toBeNull();
    expect(modeForSend(desired)).toBe("architect");
  });

  it("prefers the remembered mode over a finished run's mode", () => {
    expect(pickerModeId({ status: "finished" }, "code", "architect")).toBe("architect");
    expect(pickerModeId({ status: "running" }, "code", undefined)).toBe("code");
    expect(pickerModeId({ status: "running" }, "code", "architect")).toBe("architect");
  });

  it("keeps Esc priority rules explicit", () => {
    expect(shouldCancelOnEscape({ runActive: true, overlayOpen: false })).toBe(true);
    expect(shouldCancelOnEscape({ runActive: true, overlayOpen: true })).toBe(false);
    expect(shouldCancelOnEscape({ runActive: false, overlayOpen: false })).toBe(false);
  });
});
