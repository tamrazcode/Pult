import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

function classTokens(element: Element): string[] {
  return element.className.split(/\s+/).filter(Boolean);
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
    expect(within(header).getByRole("button", { name: "Toggle sidebar" })).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Toggle right panel" })).toBeInTheDocument();
    expect(header.querySelector('[aria-label="pult"]')).toBeNull();
    expect(header.querySelector('svg[aria-label="pult"]')).toBeNull();
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
    expect(within(header).getByRole("button", { name: "Toggle sidebar" })).toBeInTheDocument();
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
      expect(within(header).getByRole("button", { name: "Toggle sidebar" })).toBeInTheDocument();
      expect(
        within(header).getByRole("button", { name: "Toggle right panel" }),
      ).toBeInTheDocument();
      expect(header.querySelector('[aria-label="pult"]')).toBeNull();
      expect(header.querySelector('svg[aria-label="pult"]')).toBeNull();

      unmount();
    }
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
