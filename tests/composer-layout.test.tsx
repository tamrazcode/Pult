import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";

vi.mock("../src/lib/tauri", () => ({
  isTauri: () => true,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(async () => undefined),
    toggleMaximize: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    isMaximized: vi.fn(async () => false),
    onResized: vi.fn(async () => () => {}),
  }),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    providersInstancesList: vi.fn(async () => []),
    workspaceFiles: vi.fn(async () => []),
    onThreadUpdate: vi.fn(async () => () => {}),
    onAgentProcess: vi.fn(async () => () => {}),
  };
});

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    navigate: vi.fn(async () => undefined),
  }),
}));

import { ChatColumn } from "../src/components/chat/ChatColumn";
import { Composer } from "../src/components/chat/Composer";
import { useProjectsStore } from "../src/stores/projects";
import { useRunsStore } from "../src/stores/runs";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

describe("Composer and ChatColumn layout invariants", () => {
  beforeEach(() => {
    useUiStore.setState({
      sidebarOpen: true,
      rightPanelOpen: false,
      instances: [],
      selectedInstanceId: null,
    });
    useProjectsStore.setState({ projects: [], selectedProjectId: null, loaded: true });
    useThreadsStore.setState({
      threads: [
        {
          id: "t1",
          projectId: null,
          title: "Layout check",
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
    useRunsStore.setState({
      runsByThread: {},
      viewsByRun: {},
      appliedEvents: {},
      commandsByThread: {},
      queueByThread: {},
      filesByThread: {},
      activeElicitation: null,
    });
  });

  it("uses invariant px-6 padding on Composer instead of breakpoint-shrunk px-3 sm:px-6", () => {
    const { container } = render(<Composer threadId="t1" />);
    const outer = container.firstElementChild as HTMLElement;
    expect(outer).not.toBeNull();
    expect(outer).toHaveClass("px-6");
    expect(outer).not.toHaveClass("px-3");
    expect(outer).not.toHaveClass("sm:px-6");
  });

  it("enforces min-w-[400px] on ChatColumn for both empty and thread states", () => {
    const empty = render(<ChatColumn title="New thread" />);
    const emptyHeader = screen.getByRole("heading", { name: "New thread" }).parentElement;
    const emptyRoot = emptyHeader?.parentElement;
    expect(emptyRoot).not.toBeNull();
    expect(emptyRoot).toHaveClass("min-w-[400px]");
    empty.unmount();

    render(<ChatColumn title="Layout check" threadId="t1" />);
    const threadHeader = screen.getByRole("heading", { name: "Layout check" }).parentElement;
    const threadRoot = threadHeader?.parentElement;
    expect(threadRoot).not.toBeNull();
    expect(threadRoot).toHaveClass("min-w-[400px]");
  });

  it("sets tauri.conf.json window minWidth >= 1024 and minHeight >= 660", () => {
    const confPath = resolve(process.cwd(), "src-tauri", "tauri.conf.json");
    const conf = JSON.parse(readFileSync(confPath, "utf8")) as {
      app?: { windows?: Array<{ minWidth?: number; minHeight?: number }> };
    };
    const mainWindow = conf.app?.windows?.[0];
    expect(mainWindow?.minWidth).toBeGreaterThanOrEqual(1024);
    expect(mainWindow?.minHeight).toBeGreaterThanOrEqual(660);
  });
});
