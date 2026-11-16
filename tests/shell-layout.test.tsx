import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";
import type { Project, Thread, UsageReport } from "../src/lib/types";

const {
  navigate,
  historyBack,
  historyForward,
  routerState,
  mockWindow,
  appVersion,
  gitDiff,
  gitDiffSummary,
  gitDiffFile,
  gitGhAvailable,
  gitStatus,
  projectsList,
  providersDetectInstalled,
  providersInstancesList,
  runsCancel,
  settingsGet,
  settingsSet,
  terminalPtyList,
  threadsList,
  usageReport,
  workspaceFiles,
} = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
  historyBack: vi.fn(),
  historyForward: vi.fn(),
  routerState: { pathname: "/chat" },
  mockWindow: {
    minimize: vi.fn(async () => undefined),
    toggleMaximize: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    isMaximized: vi.fn(async () => false),
    onResized: vi.fn(async () => () => {}),
  },
  appVersion: vi.fn(async () => "0.1.0"),
  gitDiff: vi.fn(async () => ({ base: "HEAD", files: [] })),
  gitDiffSummary: vi.fn(async () => ({
    repoRoot: "",
    base: "HEAD",
    totalAdded: 0,
    totalRemoved: 0,
    files: [],
  })),
  gitDiffFile: vi.fn(),
  gitGhAvailable: vi.fn(async () => false),
  gitStatus: vi.fn(async () => null),
  projectsList: vi.fn(async (): Promise<Project[]> => []),
  providersDetectInstalled: vi.fn(async () => []),
  providersInstancesList: vi.fn(async () => []),
  runsCancel: vi.fn(async () => undefined),
  settingsGet: vi.fn(async (): Promise<unknown> => null),
  settingsSet: vi.fn(async () => undefined),
  terminalPtyList: vi.fn(async () => []),
  threadsList: vi.fn(async (): Promise<Thread[]> => []),
  usageReport: vi.fn(async (): Promise<UsageReport> => ({
    totalRuns: 0,
    runs: [],
    byThread: [],
    byInstance: [],
  })),
  workspaceFiles: vi.fn(async () => []),
}));

vi.mock("../src/lib/tauri", () => ({
  isTauri: () => true,
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => mockWindow,
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    appVersion,
    gitDiff,
    gitDiffSummary,
    gitDiffFile,
    gitGhAvailable,
    gitStatus,
    projectsList,
    providersDetectInstalled,
    providersInstancesList,
    runsCancel,
    settingsGet,
    settingsSet,
    terminalPtyList,
    threadsList,
    usageReport,
    workspaceFiles,
    onThreadUpdate: vi.fn(async () => () => {}),
    onAgentProcess: vi.fn(async () => () => {}),
  };
});

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  Link: ({
    children,
    to,
    ...props
  }: {
    children?: ReactNode;
    to?: string;
    [key: string]: unknown;
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  Outlet: () => <div data-testid="outlet" />,
  useRouter: () => ({
    navigate,
    history: {
      back: historyBack,
      forward: historyForward,
      canGoBack: () => false,
    },
  }),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: routerState.pathname } }),
}));

import { ChatColumn } from "../src/components/chat/ChatColumn";
import { ChatHeader } from "../src/components/chat/ChatHeader";
import { RightPanel } from "../src/components/layout/RightPanel";
import { Sidebar } from "../src/components/layout/Sidebar";
import { RouteHeader } from "../src/components/layout/WindowChrome";
import { PullRequestsPage } from "../src/routes/pull-requests";
import { SettingsLayout } from "../src/routes/settings";
import { UsagePage } from "../src/routes/usage";
import { WelcomePage } from "../src/routes/welcome";
import { useGitStore } from "../src/stores/git";
import { useProjectsStore } from "../src/stores/projects";
import { useRunsStore } from "../src/stores/runs";
import { useTerminalsStore } from "../src/stores/terminals";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

describe("shell layout polish", () => {
  beforeEach(() => {
    navigate.mockReset().mockResolvedValue(undefined);
    historyBack.mockReset();
    historyForward.mockReset();
    routerState.pathname = "/chat";
    mockWindow.isMaximized.mockResolvedValue(false);
    mockWindow.onResized.mockResolvedValue(() => {});

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

  it("renders a single 40px header in ChatHeader with panel toggles and no duplicate PultLogo", () => {
    const { container } = render(<ChatHeader title="Polish shell" threadId="t1" />);

    const headers = container.querySelectorAll("header");
    expect(headers).toHaveLength(1);
    const header = headers[0]!;
    expect(header).toHaveClass("h-10");
    expect(header).not.toHaveClass("border-b");
    expect(within(header).queryByRole("button", { name: "Toggle sidebar" })).toBeNull();
    expect(within(header).getByRole("button", { name: "Toggle right panel" })).toBeInTheDocument();
    expect(header.querySelector('[aria-label="Pult"]')).toBeNull();
    expect(header.querySelector('svg[aria-label="Pult"]')).toBeNull();
  });

  it("renders RouteHeader with h-10, drag region, title, and panel toggles for non-thread routes", () => {
    const { container } = render(<RouteHeader title="Settings" subtitle="Appearance" />);

    const headers = container.querySelectorAll("header");
    expect(headers).toHaveLength(1);
    const header = headers[0]!;
    expect(header).toHaveClass("h-10");
    expect(header).toHaveAttribute("data-tauri-drag-region");
    expect(within(header).getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(within(header).getByText("Appearance")).toBeInTheDocument();
    expect(within(header).queryByRole("button", { name: "Toggle sidebar" })).toBeNull();
    expect(within(header).getByRole("button", { name: "Toggle right panel" })).toBeInTheDocument();
  });

  it("every route renders exactly one <header> with WindowControls, panel toggles, and no PultLogo", () => {
    const routes: Array<{ name: string; pathname: string; renderRoute: () => ReactNode }> = [
      { name: "/chat", pathname: "/chat", renderRoute: () => <ChatColumn /> },
      {
        name: "/thread/$threadId",
        pathname: "/thread/t1",
        renderRoute: () => <ChatColumn threadId="t1" title="Polish shell" />,
      },
      {
        name: "/settings/*",
        pathname: "/settings/appearance",
        renderRoute: () => <SettingsLayout />,
      },
      { name: "/usage", pathname: "/usage", renderRoute: () => <UsagePage /> },
      {
        name: "/pull-requests",
        pathname: "/pull-requests",
        renderRoute: () => <PullRequestsPage />,
      },
      { name: "/welcome", pathname: "/welcome", renderRoute: () => <WelcomePage /> },
    ];

    for (const route of routes) {
      routerState.pathname = route.pathname;
      const { container, unmount } = render(route.renderRoute());

      const headers = container.querySelectorAll("header");
      expect(headers, `expected 1 <header> on ${route.name}`).toHaveLength(1);
      const header = headers[0]!;
      expect(within(header).getByRole("button", { name: /minimize/i })).toBeInTheDocument();
      expect(
        within(header).getByRole("button", { name: /(?:maximize|restore)/i }),
      ).toBeInTheDocument();
      expect(within(header).getByRole("button", { name: /close/i })).toBeInTheDocument();
      expect(within(header).queryByRole("button", { name: "Toggle sidebar" })).toBeNull();
      expect(
        within(header).getByRole("button", { name: "Toggle right panel" }),
      ).toBeInTheDocument();
      expect(header.querySelector('[aria-label="Pult"]')).toBeNull();
      expect(header.querySelector('svg[aria-label="Pult"]')).toBeNull();

      unmount();
    }
  });

  it("keeps window controls at the window edge when the right panel opens", () => {
    const { container } = render(<ChatHeader title="Polish shell" threadId="t1" />);
    const header = container.querySelector("header")!;
    const close = within(header).getByRole("button", { name: "Close window" });
    const controls = close.parentElement!;
    expect(controls).toHaveClass("fixed", "top-0", "right-0");
    expect(header).not.toHaveClass("pr-[136px]");
    act(() => useUiStore.setState({ rightPanelOpen: false }));
    expect(header).toHaveClass("pr-[136px]");
  });

  it("puts the sidebar toggle before the logo and refresh last after the footer spacer", () => {
    const { container } = render(<Sidebar width={288} />);
    const top = container.querySelector("aside")!.firstElementChild!;
    const toggle = within(top as HTMLElement).getByRole("button", { name: "Toggle sidebar" });
    const logo = top.querySelector('svg[aria-label="Pult"]')!;
    expect(top.firstElementChild).toBe(toggle);
    expect(toggle.compareDocumentPosition(logo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(top as HTMLElement).getByText("Pult")).toBeVisible();
    expect(top).not.toHaveClass("border-b");
    const footer = container.querySelector("footer")!;
    expect(footer).not.toHaveClass("border-b", "border-t");
    const refresh = within(footer).getByRole("button", { name: "Refresh" });
    const row = footer.firstElementChild!;
    expect(row.lastElementChild).toBe(refresh.parentElement);
    expect(refresh.parentElement!.previousElementSibling).toHaveClass("flex-1");
    fireEvent.click(toggle);
    expect(useUiStore.getState().sidebarOpen).toBe(false);
  });

  it.each(["chat", "route"])(
    "shows the %s header sidebar toggle only when the sidebar is closed",
    (kind) => {
      render(kind === "chat" ? <ChatHeader title="Title" /> : <RouteHeader title="Title" />);
      expect(screen.queryByRole("button", { name: "Toggle sidebar" })).toBeNull();
      act(() => useUiStore.setState({ sidebarOpen: false }));
      const toggle = screen.getByRole("button", { name: "Toggle sidebar" });
      expect(toggle).toBeVisible();
      fireEvent.click(toggle);
      expect(useUiStore.getState().sidebarOpen).toBe(true);
      expect(screen.queryByRole("button", { name: "Toggle sidebar" })).toBeNull();
    },
  );

  it.each(["chat", "route"])(
    "reserves window-control space only with the right panel closed in %s",
    (kind) => {
      const { container } = render(
        kind === "chat" ? <ChatHeader title="Title" /> : <RouteHeader title="Title" />,
      );
      const header = container.querySelector("header")!;
      expect(header).not.toHaveClass("pr-[136px]");
      act(() => useUiStore.setState({ rightPanelOpen: false }));
      expect(header).toHaveClass("pr-[136px]");
      act(() => useUiStore.setState({ rightPanelOpen: true }));
      expect(header).not.toHaveClass("pr-[136px]");
    },
  );

  it("uses a small chat title and a page icon for the middle project-info toggle", () => {
    useUiStore.setState({ rightPanelOpen: false, projectWidgetOpen: false });
    const { container } = render(<ChatHeader title="Title" />);
    expect(screen.getByRole("heading", { name: "Title" })).toHaveClass("text-sm");
    expect(container.querySelector("header")).not.toHaveClass("border-b");
    const middle = screen.getByRole("button", { name: "Toggle project info" });
    const icon = middle.querySelector("svg")!;
    expect(icon.querySelector("rect")).toHaveAttribute("height", "18");
    expect(icon.querySelector("path")).toHaveAttribute("d", "M8 9h8M8 13h8");
    expect(middle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(middle);
    expect(useUiStore.getState().projectWidgetOpen).toBe(true);
    expect(middle).toHaveAttribute("aria-pressed", "true");
    expect(
      middle.compareDocumentPosition(screen.getByRole("button", { name: "Toggle right panel" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps the RightPanel header borderless", () => {
    const { container } = render(<RightPanel width={420} />);
    expect(container.querySelector("aside")!.firstElementChild).toHaveClass("h-10");
    expect(container.querySelector("aside")!.firstElementChild).not.toHaveClass("border-b");
  });
});
