import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as IpcModule from "../src/lib/ipc";

const { settingsGet, settingsSet } = vi.hoisted(() => ({
  settingsGet: vi.fn(async (): Promise<unknown> => null),
  settingsSet: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return { ...actual, settingsGet, settingsSet };
});

vi.mock("../src/lib/tauri", () => ({
  isTauri: () => true,
}));

import { useUiStore } from "../src/stores/ui";

describe("ui store", () => {
  beforeEach(() => {
    settingsGet.mockClear();
    settingsSet.mockClear();
    useUiStore.setState({
      sidebarOpen: true,
      rightPanelOpen: false,
      rightPanelTab: "diff",
      instanceByThread: {},
      processEvents: {},
      globalError: null,
    });
  });

  it("toggles the sidebar", () => {
    expect(useUiStore.getState().sidebarOpen).toBe(true);
    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarOpen).toBe(false);
  });

  it("toggles the right panel", () => {
    useUiStore.getState().toggleRightPanel();
    expect(useUiStore.getState().rightPanelOpen).toBe(true);
  });

  it("keeps the process event detail", () => {
    useUiStore.setState({ processEvents: {} });
    useUiStore.getState().applyProcessEvent("mock", "crashed", "exit code 1");
    expect(useUiStore.getState().processEvents["mock"]).toEqual([
      expect.objectContaining({ kind: "crashed", detail: "exit code 1" }),
    ]);
  });

  it("selecting a tab opens the right panel", () => {
    useUiStore.getState().setRightPanelTab("terminal");
    expect(useUiStore.getState().rightPanelTab).toBe("terminal");
    expect(useUiStore.getState().rightPanelOpen).toBe(true);
  });

  it("keeps only one side rail below the narrow breakpoint", () => {
    const original = window.innerWidth;
    try {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
      useUiStore.setState({ sidebarOpen: true, rightPanelOpen: false });
      useUiStore.getState().toggleRightPanel();
      expect(useUiStore.getState().rightPanelOpen).toBe(true);
      expect(useUiStore.getState().sidebarOpen).toBe(false);

      Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
      useUiStore.setState({ sidebarOpen: true, rightPanelOpen: false });
      useUiStore.getState().toggleRightPanel();
      expect(useUiStore.getState().sidebarOpen).toBe(true);
    } finally {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: original });
    }
  });

  it("does not expose newThreadOptions or setNewThreadOptions", () => {
    expect("newThreadOptions" in useUiStore.getState()).toBe(false);
    expect("setNewThreadOptions" in useUiStore.getState()).toBe(false);
  });

  it("persists both pane widths as one atomic write without reading layout first", async () => {
    useUiStore.setState({ sidebarWidth: 288, rightPanelWidth: 420 });

    useUiStore.getState().setSidebarWidth(320, true);
    useUiStore.getState().setRightPanelWidth(500, true);

    await vi.waitFor(() =>
      expect(settingsSet).toHaveBeenLastCalledWith("layout", {
        sidebarWidth: 320,
        rightPanelWidth: 500,
      }),
    );
    expect(settingsGet).not.toHaveBeenCalledWith("layout");
  });

  it("clearThreadState drops only that thread's remembered agent", () => {
    useUiStore.setState({ instanceByThread: { a: "inst-a", b: "inst-b" } });

    useUiStore.getState().clearThreadState("a");

    expect(useUiStore.getState().instanceByThread).toEqual({ b: "inst-b" });
  });
});
