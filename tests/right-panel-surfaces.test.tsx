import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

describe("RightPanel surfaces", () => {
  beforeEach(() => {
    useUiStore.setState({
      rightPanelOpen: true,
      rightPanelTab: "none",
      instances: [],
      selectedInstanceId: null,
    });
    useProjectsStore.setState({ projects: [], selectedProjectId: null, loaded: true });
    useThreadsStore.setState({ threads: [], activeThreadId: null, unreadIds: [], loaded: true });
  });

  it("omits the top tab-icon strip and + menu button when tab is 'none' and shows the centered surface list", () => {
    const { container } = render(<RightPanel width={420} />);

    expect(screen.queryByRole("button", { name: "Open a surface" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Back to surfaces" })).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();

    const header = container.querySelector("aside > div") as HTMLElement;
    expect(within(header).queryAllByRole("button")).toHaveLength(0);

    const heading = screen.getByText("Open a surface");
    expect(heading).toBeVisible();
    const list = heading.parentElement as HTMLElement;
    expect(list).toHaveClass("items-center", "justify-center");

    for (const spec of EXPECTED_SURFACES) {
      const btn = within(list).getByRole("button", { name: new RegExp(`^${spec.label}`, "i") });
      expect(btn).toHaveTextContent(spec.shortcut);
      if (spec.enabled) {
        expect(btn).not.toBeDisabled();
      } else {
        expect(btn).toBeDisabled();
        expect(btn.getAttribute("title")?.length).toBeGreaterThan(0);
      }
    }
  });

  it("opens Diff from the centered list without top tab-icon buttons and returns via 'Back to surfaces'", async () => {
    const { container } = render(<RightPanel width={420} />);

    const list = screen.getByText("Open a surface").parentElement as HTMLElement;
    fireEvent.click(within(list).getByRole("button", { name: /^Diff/i }));

    expect(useUiStore.getState().rightPanelTab).toBe("diff");
    await waitFor(() => {
      expect(screen.queryByText("Open a surface")).toBeNull();
    });

    const header = container.querySelector("aside > div") as HTMLElement;
    const headerButtons = within(header).getAllByRole("button");
    expect(headerButtons).toHaveLength(1);
    const backBtn = within(header).getByRole("button", { name: "Back to surfaces" });
    expect(headerButtons[0]).toBe(backBtn);

    expect(within(header).queryByRole("button", { name: "Open a surface" })).toBeNull();
    for (const label of ["Browser", "Terminal", "Files", "Diff"]) {
      expect(within(header).queryByRole("button", { name: new RegExp(label, "i") })).toBeNull();
    }

    fireEvent.click(backBtn);
    expect(useUiStore.getState().rightPanelTab).toBe("none");
    expect(screen.getByText("Open a surface")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Back to surfaces" })).toBeNull();
  });
});
