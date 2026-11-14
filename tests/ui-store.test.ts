import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "../src/stores/ui";

describe("ui store", () => {
  beforeEach(() => {
    useUiStore.setState({ sidebarOpen: true, rightPanelOpen: false, rightPanelTab: "diff" });
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
});
