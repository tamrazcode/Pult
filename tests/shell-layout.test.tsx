import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as IpcModule from "../src/lib/ipc";
import type { Project, Thread } from "../src/lib/types";

const {
  navigate,
  historyBack,
  historyForward,
  appVersion,
  gitDiff,
  gitGhAvailable,
  gitStatus,
  projectsList,
  providersInstancesList,
  runsCancel,
  settingsGet,
  settingsSet,
  terminalPtyList,
  threadsList,
  workspaceFiles,
} = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
  historyBack: vi.fn(),
  historyForward: vi.fn(),
  appVersion: vi.fn(async () => "0.1.0"),
  gitDiff: vi.fn(async () => ({ base: "HEAD", files: [] })),
  gitGhAvailable: vi.fn(async () => false),
  gitStatus: vi.fn(async () => null),
  projectsList: vi.fn(async (): Promise<Project[]> => []),
  providersInstancesList: vi.fn(async () => []),
  runsCancel: vi.fn(async () => undefined),
  settingsGet: vi.fn(async (): Promise<unknown> => null),
  settingsSet: vi.fn(async () => undefined),
  terminalPtyList: vi.fn(async () => []),
  threadsList: vi.fn(async (): Promise<Thread[]> => []),
  workspaceFiles: vi.fn(async () => []),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    appVersion,
    gitDiff,
    gitGhAvailable,
    gitStatus,
    projectsList,
    providersInstancesList,
    runsCancel,
    settingsGet,
    settingsSet,
    terminalPtyList,
    threadsList,
    workspaceFiles,
    onThreadUpdate: vi.fn(async () => () => {}),
    onAgentProcess: vi.fn(async () => () => {}),
  };
});

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({
    navigate,
    history: {
      back: historyBack,
      forward: historyForward,
      canGoBack: () => false,
    },
  }),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/chat" } }),
}));

import { ChatColumn } from "../src/components/chat/ChatColumn";
import { ChatHeader } from "../src/components/chat/ChatHeader";
import { RightPanel } from "../src/components/layout/RightPanel";
import { Sidebar } from "../src/components/layout/Sidebar";
import { Topbar } from "../src/components/layout/Topbar";
import { useGitStore } from "../src/stores/git";
import { useProjectsStore } from "../src/stores/projects";
import { useRunsStore } from "../src/stores/runs";
import { useTerminalsStore } from "../src/stores/terminals";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

function classTokens(element: Element): string[] {
  return element.className.split(/\s+/).filter(Boolean);
}

function hasCompactHeaderHeight(element: Element): boolean {
  const tokens = classTokens(element);
  return tokens.some((token) => token === "h-10" || token === "h-11");
}

function hasActiveTabAccentClass(element: Element): boolean {
  return classTokens(element).some((token) =>
    /(?:^|:)(?:text|border(?:-[trblxy])?|bg)-(?:\(--accent\)|accent)(?:$|\/)/.test(token),
  );
}

function hasAnyActiveTabIndicator(element: Element): boolean {
  return classTokens(element).some(
    (token) =>
      token === "bg-active" ||
      /(?:^|:)(?:text|border(?:-[trblxy])?|bg)-(?:\(--accent\)|accent)(?:$|\/)/.test(token),
  );
}

describe("shell layout polish", () => {
  beforeEach(() => {
    navigate.mockReset().mockResolvedValue(undefined);
    historyBack.mockReset();
    historyForward.mockReset();

    useProjectsStore.setState({
      projects: [],
      selectedProjectId: null,
      loaded: true,
    });
    useThreadsStore.setState({
      threads: [
        {
          id: "t1",
          projectId: null,
          title: "Polish shell",
          status: "draft",
          pinned: false,
          createdAt: 100,
          updatedAt: 100,
        },
      ],
      activeThreadId: null,
      unreadIds: [],
      loaded: true,
    });
    useUiStore.setState({
      sidebarOpen: true,
      rightPanelOpen: true,
      rightPanelTab: "diff",
      collapsedProjects: [],
      instances: [],
      selectedInstanceId: null,
      paletteOpen: false,
      appVersion: null,
      newThreadOptions: { workspace: "", worktree: false },
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
    useGitStore.setState({
      byThread: {},
      viewMode: "unified",
      ghAvailable: false,
      prHistory: [],
    });
    useTerminalsStore.setState({
      byThread: {},
      activeByThread: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies bg-panel (not bg-canvas or bg-chrome) to Sidebar and RightPanel aside roots", () => {
    const { container: sidebarContainer } = render(<Sidebar width={288} />);
    const sidebarAside = sidebarContainer.querySelector("aside");
    expect(sidebarAside).not.toBeNull();
    expect(sidebarAside).toHaveClass("bg-panel");
    expect(sidebarAside).not.toHaveClass("bg-canvas");
    expect(sidebarAside).not.toHaveClass("bg-chrome");

    const { container: rightContainer } = render(<RightPanel width={420} />);
    const rightAside = rightContainer.querySelector("aside");
    expect(rightAside).not.toBeNull();
    expect(rightAside).toHaveClass("bg-panel");
    expect(rightAside).not.toHaveClass("bg-canvas");
    expect(rightAside).not.toHaveClass("bg-chrome");
  });

  it("keeps bg-canvas on the chat column root", () => {
    render(<ChatColumn title="New thread" />);

    const headerHeading = screen.getByRole("heading", { name: "New thread" });
    const chatHeaderRoot = headerHeading.parentElement;
    const chatColumnRoot = chatHeaderRoot?.parentElement;
    expect(chatColumnRoot).not.toBeNull();
    expect(chatColumnRoot).toHaveClass("bg-canvas");
    expect(chatColumnRoot).not.toHaveClass("bg-panel");
    expect(chatColumnRoot).not.toHaveClass("bg-chrome");
  });

  it("uses compact h-10 or h-11 rhythm for Topbar and ChatHeader", () => {
    const { container: topbarContainer } = render(<Topbar />);
    const topbarHeader = topbarContainer.querySelector("header");
    expect(topbarHeader).not.toBeNull();
    expect(hasCompactHeaderHeight(topbarHeader!)).toBe(true);
    expect(topbarHeader).not.toHaveClass("h-12");

    render(<ChatHeader title="Polish shell" threadId="t1" />);
    const chatHeaderRoot = screen.getByRole("heading", { name: "Polish shell" }).parentElement;
    expect(chatHeaderRoot).not.toBeNull();
    expect(hasCompactHeaderHeight(chatHeaderRoot!)).toBe(true);
    expect(chatHeaderRoot).not.toHaveClass("h-12");
  });

  it("applies pill/underline active accent styling on the selected RightPanel tab", async () => {
    render(<RightPanel width={420} />);

    const diffTab = screen.getByRole("button", { name: /diff/i });
    const filesTab = screen.getByRole("button", { name: /files/i });
    const terminalTab = screen.getByRole("button", { name: /terminal/i });

    expect(hasActiveTabAccentClass(diffTab)).toBe(true);
    expect(hasAnyActiveTabIndicator(filesTab)).toBe(false);
    expect(hasAnyActiveTabIndicator(terminalTab)).toBe(false);

    await userEvent.click(filesTab);

    expect(hasActiveTabAccentClass(filesTab)).toBe(true);
    expect(hasAnyActiveTabIndicator(diffTab)).toBe(false);
    expect(hasAnyActiveTabIndicator(terminalTab)).toBe(false);
  });
});
