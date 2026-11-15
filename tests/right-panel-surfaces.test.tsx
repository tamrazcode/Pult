import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";

vi.mock("../src/lib/tauri", () => ({
  isTauri: () => true,
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    gitStatus: vi.fn(async () => null),
    gitDiffSummary: vi.fn(async () => ({
      repoRoot: "",
      base: "HEAD",
      totalAdded: 0,
      totalRemoved: 0,
      files: [],
    })),
    gitGhAvailable: vi.fn(async () => false),
    terminalPtyList: vi.fn(async () => []),
    workspaceTree: vi.fn(async () => ({ entries: [], truncated: false })),
  };
});

import { RightPanel } from "../src/components/layout/RightPanel";
import { useProjectsStore } from "../src/stores/projects";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

const EXPECTED_SURFACES = [
  { label: "Browser", shortcut: "B", enabled: true, tab: "browser" },
  { label: "Terminal", shortcut: "T", enabled: true, tab: "terminal" },
  { label: "Files", shortcut: "F", enabled: true, tab: "files" },
  { label: "Diff", shortcut: "D", enabled: true, tab: "diff" },
  { label: "Pull request", shortcut: "P", enabled: false, tab: "pull-request" },
  { label: "Linked pull requests", shortcut: "L", enabled: false, tab: "linked-pull-requests" },
  { label: "Device", shortcut: "M", enabled: false, tab: "device" },
  { label: "Side chat", shortcut: "S", enabled: false, tab: "side-chat" },
] as const;

describe("RightPanel Open a surface menu", () => {
  beforeEach(() => {
    useUiStore.setState({
      rightPanelOpen: true,
      rightPanelTab: "diff",
      instances: [],
      selectedInstanceId: null,
    });
    useProjectsStore.setState({ projects: [], selectedProjectId: null, loaded: true });
    useThreadsStore.setState({ threads: [], activeThreadId: null, unreadIds: [], loaded: true });
  });

  it("lists all 8 surfaces with shortcut badges, enabling the first four and disabling the rest with reasons", () => {
    render(<RightPanel width={420} />);

    fireEvent.click(screen.getByRole("button", { name: "Open a surface" }));
    const menu = screen.getByRole("menu", { name: "Open a surface" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items).toHaveLength(8);

    items.forEach((item, index) => {
      const spec = EXPECTED_SURFACES[index]!;
      expect(item).toHaveTextContent(spec.label);
      expect(item).toHaveTextContent(spec.shortcut);
      if (spec.enabled) {
        expect(item).not.toBeDisabled();
      } else {
        expect(item).toBeDisabled();
        const reason = item.textContent?.replace(spec.label, "").replace(spec.shortcut, "").trim();
        expect(reason?.length).toBeGreaterThan(0);
      }
    });
  });

  it("switches to enabled surfaces on click and keyboard shortcut letters while menu is open", () => {
    useUiStore.setState({ rightPanelOpen: false, rightPanelTab: "diff" });
    render(<RightPanel width={420} />);

    fireEvent.click(screen.getByRole("button", { name: "Open a surface" }));
    fireEvent.keyDown(window, { key: "b" });
    expect(useUiStore.getState().rightPanelTab).toBe("browser");
    expect(useUiStore.getState().rightPanelOpen).toBe(true);
    expect(screen.queryByRole("menu", { name: "Open a surface" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Open a surface" }));
    fireEvent.keyDown(window, { key: "T" });
    expect(useUiStore.getState().rightPanelTab).toBe("terminal");

    fireEvent.click(screen.getByRole("button", { name: "Open a surface" }));
    fireEvent.keyDown(window, { key: "f" });
    expect(useUiStore.getState().rightPanelTab).toBe("files");

    fireEvent.click(screen.getByRole("button", { name: "Open a surface" }));
    fireEvent.keyDown(window, { key: "d" });
    expect(useUiStore.getState().rightPanelTab).toBe("diff");

    // Disabled shortcut letters must not switch away from diff
    fireEvent.click(screen.getByRole("button", { name: "Open a surface" }));
    for (const key of ["p", "l", "m", "s"]) {
      fireEvent.keyDown(window, { key });
      expect(useUiStore.getState().rightPanelTab).toBe("diff");
    }
  });

  it("shows the centered 'Open a surface' list when rightPanelTab is 'none' and switches on selection", () => {
    useUiStore.setState({ rightPanelOpen: true, rightPanelTab: "none" });
    render(<RightPanel width={420} />);

    const heading = screen.getByText("Open a surface");
    expect(heading).toBeVisible();
    const list = heading.parentElement as HTMLElement;
    expect(list).toHaveClass("items-center", "justify-center");

    for (const spec of EXPECTED_SURFACES) {
      const btn = within(list).getByRole("button", { name: new RegExp(`^${spec.label}`, "i") });
      if (spec.enabled) {
        expect(btn).not.toBeDisabled();
      } else {
        expect(btn).toBeDisabled();
      }
    }

    fireEvent.click(within(list).getByRole("button", { name: /Files/i }));
    expect(useUiStore.getState().rightPanelTab).toBe("files");
    expect(screen.queryByText("Open a surface")).toBeNull();
  });
});
