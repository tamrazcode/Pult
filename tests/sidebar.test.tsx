import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as IpcModule from "../src/lib/ipc";
import type { Project, Run, Thread } from "../src/lib/types";

const {
  navigate,
  historyBack,
  historyForward,
  threadsList,
  threadsRename,
  threadsSetPinned,
  threadsSetStatus,
  threadsDelete,
  projectsList,
  projectsUpdate,
  projectsDelete,
  providersInstancesList,
  settingsGet,
  settingsSet,
  runsCancel,
  workspaceFiles,
} = vi.hoisted(() => ({
  navigate: vi.fn(),
  historyBack: vi.fn(),
  historyForward: vi.fn(),
  threadsList: vi.fn(async (): Promise<Thread[]> => []),
  threadsRename: vi.fn(async () => undefined),
  threadsSetPinned: vi.fn(async () => undefined),
  threadsSetStatus: vi.fn(async () => undefined),
  threadsDelete: vi.fn(async () => undefined),
  projectsList: vi.fn(async (): Promise<Project[]> => []),
  projectsUpdate: vi.fn(async (id: string, patch: Partial<Project>): Promise<Project> => ({
    id,
    name: patch.name ?? "Project",
    rootPath: `C:\\work\\${id}`,
    color: patch.color ?? "#346bf1",
    worktreeStrategy: patch.worktreeStrategy ?? "root",
    pinned: patch.pinned ?? false,
    createdAt: 100,
  })),
  projectsDelete: vi.fn(async () => undefined),
  providersInstancesList: vi.fn(async () => []),
  settingsGet: vi.fn(async (): Promise<unknown> => null),
  settingsSet: vi.fn(async () => undefined),
  runsCancel: vi.fn(async () => undefined),
  workspaceFiles: vi.fn(async () => []),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    threadsList,
    threadsRename,
    threadsSetPinned,
    threadsSetStatus,
    threadsDelete,
    projectsList,
    projectsUpdate,
    projectsDelete,
    providersInstancesList,
    settingsGet,
    settingsSet,
    runsCancel,
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

import { Composer } from "../src/components/chat/Composer";
import { Sidebar } from "../src/components/layout/Sidebar";
import { useProjectsStore } from "../src/stores/projects";
import { useRunsStore } from "../src/stores/runs";
import { buildSidebarGroups, useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

const makeProject = (
  id: string,
  name: string,
  opts: Partial<Omit<Project, "id" | "name">> = {},
): Project => ({
  id,
  name,
  rootPath: `C:\\work\\${id}`,
  color: "#346bf1",
  worktreeStrategy: "root",
  pinned: false,
  createdAt: 100,
  ...opts,
});

const makeThread = (
  id: string,
  title: string,
  opts: Partial<Omit<Thread, "id" | "title">> = {},
): Thread => ({
  id,
  projectId: null,
  title,
  status: "draft",
  pinned: false,
  createdAt: 100,
  updatedAt: 100,
  ...opts,
});

describe("buildSidebarGroups", () => {
  it("sorts pinned projects above unpinned and alphabetically within each tier", () => {
    const projects = [
      makeProject("p-z", "Zeta", { pinned: false }),
      makeProject("p-b", "Beta", { pinned: true }),
      makeProject("p-a", "Alpha", { pinned: false }),
      makeProject("p-g", "Gamma", { pinned: true }),
    ];

    const groups = buildSidebarGroups(projects, [], {
      query: "",
      filter: "all",
      unreadIds: new Set(),
    });

    expect(groups.map((g) => g.project?.name)).toEqual(["Beta", "Gamma", "Alpha", "Zeta"]);
  });

  it("sorts pinned threads above unpinned inside a project, then by updatedAt descending", () => {
    const projects = [makeProject("p1", "Alpha")];
    const threads = [
      makeThread("u-old", "Unpinned Old", { projectId: "p1", pinned: false, updatedAt: 100 }),
      makeThread("u-new", "Unpinned New", { projectId: "p1", pinned: false, updatedAt: 300 }),
      makeThread("p-old", "Pinned Old", { projectId: "p1", pinned: true, updatedAt: 50 }),
      makeThread("p-new", "Pinned New", { projectId: "p1", pinned: true, updatedAt: 200 }),
    ];

    const groups = buildSidebarGroups(projects, threads, {
      query: "",
      filter: "all",
      unreadIds: new Set(),
    });

    expect(groups[0].threads.map((t) => t.id)).toEqual(["p-new", "p-old", "u-new", "u-old"]);
  });

  it("excludes archived threads by default and shows only archived threads for filter 'archived'", () => {
    const projects = [makeProject("p1", "Alpha")];
    const threads = [
      makeThread("active", "Active thread", { projectId: "p1", status: "draft" }),
      makeThread("arch", "Archived thread", { projectId: "p1", status: "archived" }),
    ];

    const defaultGroups = buildSidebarGroups(projects, threads, {
      query: "",
      filter: "all",
      unreadIds: new Set(),
    });
    expect(defaultGroups.flatMap((g) => g.threads.map((t) => t.id))).toEqual(["active"]);

    const archivedGroups = buildSidebarGroups(projects, threads, {
      query: "",
      filter: "archived",
      unreadIds: new Set(),
    });
    expect(archivedGroups.flatMap((g) => g.threads.map((t) => t.id))).toEqual(["arch"]);
  });

  it("filters by unreadIds when filter is 'unread'", () => {
    const projects = [makeProject("p1", "Alpha")];
    const threads = [
      makeThread("t1", "Unread one", { projectId: "p1", status: "draft" }),
      makeThread("t2", "Read one", { projectId: "p1", status: "draft" }),
      makeThread("t3", "Archived unread", { projectId: "p1", status: "archived" }),
    ];

    const groups = buildSidebarGroups(projects, threads, {
      query: "",
      filter: "unread",
      unreadIds: new Set(["t1", "t3"]),
    });

    expect(groups.flatMap((g) => g.threads.map((t) => t.id))).toEqual(["t1"]);
  });

  it("filters thread titles by query across groups", () => {
    const projects = [makeProject("p1", "Alpha"), makeProject("p2", "Beta")];
    const threads = [
      makeThread("t1", "Fix auth bug", { projectId: "p1", updatedAt: 300 }),
      makeThread("t2", "Update readme", { projectId: "p1", updatedAt: 200 }),
      makeThread("t3", "Auth token refresh", { projectId: "p2", updatedAt: 100 }),
      makeThread("t4", "Auth modal", { projectId: null, updatedAt: 50 }),
    ];

    const groups = buildSidebarGroups(projects, threads, {
      query: "auth",
      filter: "all",
      unreadIds: new Set(),
    });

    expect(groups.flatMap((g) => g.threads.map((t) => t.id))).toEqual(["t1", "t3", "t4"]);
  });

  it("places 'No project' group last only when non-empty", () => {
    const projects = [makeProject("p1", "Alpha")];
    const withOrphan = [
      makeThread("t1", "In Alpha", { projectId: "p1" }),
      makeThread("t2", "Loose thread", { projectId: null }),
    ];

    const groupsWithOrphan = buildSidebarGroups(projects, withOrphan, {
      query: "",
      filter: "all",
      unreadIds: new Set(),
    });
    expect(groupsWithOrphan.map((g) => g.project?.id ?? null)).toEqual(["p1", null]);
    expect(groupsWithOrphan.at(-1)?.threads.map((t) => t.id)).toEqual(["t2"]);

    const withoutOrphan = [makeThread("t1", "In Alpha", { projectId: "p1" })];
    const groupsWithoutOrphan = buildSidebarGroups(projects, withoutOrphan, {
      query: "",
      filter: "all",
      unreadIds: new Set(),
    });
    expect(groupsWithoutOrphan.some((g) => g.project === null)).toBe(false);
  });
});

describe("Sidebar", () => {
  const alpha = makeProject("p1", "Alpha", { color: "#346bf1" });
  const beta = makeProject("p2", "Beta", { color: "#10b981", pinned: true });
  const seededThreads: Thread[] = [
    makeThread("t1", "Fix login bug", { projectId: "p1", status: "draft", updatedAt: 400 }),
    makeThread("t2", "Refactor sidebar", { projectId: "p2", status: "draft", updatedAt: 300 }),
    makeThread("t3", "Standalone note", { projectId: null, status: "draft", updatedAt: 200 }),
  ];

  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    navigate.mockReset().mockResolvedValue(undefined);
    historyBack.mockReset();
    historyForward.mockReset();
    projectsList.mockReset().mockResolvedValue([alpha, beta]);
    projectsUpdate.mockReset().mockImplementation(async (id: string, patch: Partial<Project>) => ({
      ...(id === alpha.id ? alpha : beta),
      ...patch,
    }));
    projectsDelete.mockReset().mockResolvedValue(undefined);
    threadsList.mockReset().mockResolvedValue(seededThreads);
    threadsRename.mockReset().mockResolvedValue(undefined);
    threadsSetPinned.mockReset().mockResolvedValue(undefined);
    threadsSetStatus.mockReset().mockResolvedValue(undefined);
    threadsDelete.mockReset().mockResolvedValue(undefined);
    providersInstancesList.mockReset().mockResolvedValue([]);
    settingsGet.mockReset().mockResolvedValue(null);
    settingsSet.mockReset().mockResolvedValue(undefined);
    runsCancel.mockReset().mockResolvedValue(undefined);
    workspaceFiles.mockReset().mockResolvedValue([]);

    useProjectsStore.setState({
      projects: [alpha, beta],
      selectedProjectId: null,
      loaded: true,
    });
    useThreadsStore.setState({
      threads: seededThreads,
      activeThreadId: null,
      loaded: true,
      unreadIds: ["t1"],
    } as never);
    useUiStore.setState({
      instances: [],
      selectedInstanceId: null,
      collapsedProjects: [],
      paletteOpen: false,
    });
    useRunsStore.setState({
      runsByThread: {},
      viewsByRun: {},
      appliedEvents: {},
      commandsByThread: {},
      queueByThread: {},
      activeElicitation: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("omits legacy shelf headings and 'New thread with workspace' button", () => {
    render(<Sidebar width={288} />);

    expect(screen.queryByText(/^drafts$/i)).toBeNull();
    expect(screen.queryByText(/^snoozed$/i)).toBeNull();
    expect(screen.queryByText(/^settled$/i)).toBeNull();
    expect(screen.queryByText(/^pinned$/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /new thread with workspace/i })).toBeNull();
  });

  it("renders project rows with colored initials badge and right-aligned chevron", () => {
    render(<Sidebar width={288} />);

    const alphaName = screen.getByText("Alpha");
    expect(alphaName).toBeVisible();
    const row = alphaName.closest("[data-project-row]");
    expect(row).not.toBeNull();

    const badge = row!.querySelector<HTMLElement>("[data-project-badge]");
    expect(badge).not.toBeNull();
    expect(badge!.textContent?.trim()).toBe("AL");
    expect(badge!.style.color).toBe("rgb(52, 107, 241)");

    const toggle = row!.querySelector<HTMLButtonElement>("button[aria-expanded]");
    expect(toggle).not.toBeNull();
    expect(toggle).toHaveAttribute("data-project-chevron", "right");

    const nameInToggle = within(toggle!).getByText("Alpha");
    const chevron = toggle!.querySelector("svg.lucide-chevron-down, svg.lucide-chevron-right");
    expect(chevron).not.toBeNull();
    expect(nameInToggle.compareDocumentPosition(chevron!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("collapsing a project hides its nested threads", async () => {
    render(<Sidebar width={288} />);

    expect(screen.getByText("Fix login bug")).toBeVisible();

    const alphaText = screen.getByText("Alpha");
    const toggle =
      alphaText.closest("button") ??
      alphaText.parentElement?.querySelector("button") ??
      alphaText.closest("[data-project-row]")?.querySelector("button");
    expect(toggle).not.toBeNull();

    await userEvent.click(toggle!);

    expect(screen.queryByText("Fix login bug")).toBeNull();
  });

  it("search input filters threads across groups", async () => {
    render(<Sidebar width={288} />);

    const searchInput =
      screen.queryByRole("searchbox") ??
      screen.queryByPlaceholderText(/search/i) ??
      screen.getByLabelText(/search/i);

    await userEvent.type(searchInput, "login");

    expect(screen.getByText("Fix login bug")).toBeVisible();
    expect(screen.queryByText("Refactor sidebar")).toBeNull();
    expect(screen.queryByText("Standalone note")).toBeNull();
  });

  it("renders an unread dot for threads in unreadIds", () => {
    render(<Sidebar width={288} />);

    const unreadRow = screen.getByText("Fix login bug").closest("a, button");
    const readRow = screen.getByText("Refactor sidebar").closest("a, button");
    expect(unreadRow).not.toBeNull();
    expect(readRow).not.toBeNull();

    const unreadDotSelector =
      '[data-unread="true"], [aria-label*="unread" i], [title*="unread" i], span.rounded-full';
    expect(unreadRow!.querySelector(unreadDotSelector)).not.toBeNull();
    expect(readRow!.querySelector(unreadDotSelector)).toBeNull();
  });

  it("renders footer navigation and a footer refresh action", async () => {
    render(<Sidebar width={288} />);

    const settingsBtn = screen.getByRole("button", { name: /^settings$/i });
    const prsBtn = screen.getByRole("button", { name: /^pull requests$/i });
    const usageBtn = screen.getByRole("button", { name: /^usage$/i });
    const refreshBtn = screen.getByRole("button", { name: /^refresh$/i });

    await userEvent.click(settingsBtn);
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: expect.stringMatching(/^\/settings/) }),
    );

    await userEvent.click(prsBtn);
    expect(navigate).toHaveBeenCalledWith({ to: "/pull-requests" });

    await userEvent.click(usageBtn);
    expect(navigate).toHaveBeenCalledWith({ to: "/usage" });

    projectsList.mockClear();
    threadsList.mockClear();
    providersInstancesList.mockClear();

    await userEvent.click(refreshBtn);

    await waitFor(() => {
      expect(projectsList).toHaveBeenCalled();
      expect(threadsList).toHaveBeenCalled();
    });
  });

  it("renders Search placeholder and icon-only footer buttons with tooltips", async () => {
    const user = userEvent.setup();
    render(<Sidebar width={288} />);

    const searchInput = screen.getByPlaceholderText("Search");
    expect(searchInput).toHaveAttribute("aria-label", "Search threads");

    const footer = document.querySelector<HTMLElement>("aside footer");
    expect(footer).not.toBeNull();

    const footerButtons = [
      { name: /^settings$/i, label: /settings/i },
      { name: /^pull requests$/i, label: /pull requests/i },
      { name: /^usage$/i, label: /usage/i },
      { name: /^refresh$/i, label: /check provider updates/i },
    ];

    for (const entry of footerButtons) {
      const btn = within(footer!).getByRole("button", { name: entry.name });
      expect(btn.textContent?.trim()).toBe("");
      expect(btn.querySelector("svg")).not.toBeNull();

      await user.hover(btn);
      await waitFor(() => {
        expect(screen.getByRole("tooltip")).toHaveTextContent(entry.label);
      });
      await user.unhover(btn);
      await waitFor(() => {
        expect(screen.queryByRole("tooltip")).toBeNull();
      });
    }
  });

  it("opens project context menu with exact items and requires two-step Delete confirmation", async () => {
    render(<Sidebar width={288} />);

    const alphaRow = screen.getByText("Alpha").closest("[data-project-row]");
    expect(alphaRow).not.toBeNull();
    fireEvent.contextMenu(alphaRow!);

    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent?.trim())).toEqual([
      "New thread",
      "Copy path",
      "Pin",
      "Project settings",
      "Delete",
    ]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(projectsDelete).not.toHaveBeenCalled();
    const confirmItem = screen.getByRole("menuitem", { name: /confirm delete/i });
    expect(confirmItem).toBeVisible();

    fireEvent.click(confirmItem);
    await waitFor(() => expect(projectsDelete).toHaveBeenCalledWith(alpha.id));
  });

  it("opens thread context menu with exact items and dispatches store and clipboard actions", async () => {
    const pinSpy = vi.spyOn(useThreadsStore.getState(), "setThreadPinned");
    const statusSpy = vi.spyOn(useThreadsStore.getState(), "setThreadStatus");
    const unreadSpy = vi.spyOn(useThreadsStore.getState(), "markUnread");

    render(<Sidebar width={288} />);

    fireEvent.contextMenu(screen.getByText("Refactor sidebar"));
    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(screen.getAllByRole("menuitem").map((el) => el.textContent?.trim())).toEqual([
      "Pin",
      "Settle",
      "Snooze",
      "Rename",
      "Mark unread",
      "Copy path",
      "Project settings",
      "Archive",
      "Delete",
    ]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }));
    expect(pinSpy).toHaveBeenCalledWith("t2", true);

    fireEvent.contextMenu(screen.getByText("Refactor sidebar"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Settle" }));
    expect(statusSpy).toHaveBeenCalledWith("t2", "settled");

    fireEvent.contextMenu(screen.getByText("Refactor sidebar"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Snooze" }));
    expect(statusSpy).toHaveBeenCalledWith("t2", "snoozed");

    fireEvent.contextMenu(screen.getByText("Refactor sidebar"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(statusSpy).toHaveBeenCalledWith("t2", "archived");

    fireEvent.contextMenu(screen.getByText("Refactor sidebar"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark unread" }));
    expect(unreadSpy).toHaveBeenCalledWith("t2", true);

    fireEvent.contextMenu(screen.getByText("Refactor sidebar"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy path" }));
    expect(writeText).toHaveBeenCalledWith(beta.rootPath);
  });

  it("disables Project settings in thread context menu when projectId is null", () => {
    render(<Sidebar width={288} />);

    fireEvent.contextMenu(screen.getByText("Standalone note"));
    expect(screen.getByRole("menuitem", { name: "Project settings" })).toBeDisabled();
  });

  it("closes context menu on Escape without calling runsCancel", () => {
    const runningRun: Run = {
      id: "r1",
      threadId: "t2",
      idx: 0,
      status: "running",
      instanceId: "mock",
      startedAt: 0,
    };
    useRunsStore.getState().registerRun(runningRun);

    render(
      <>
        <Sidebar width={288} />
        <Composer threadId="t2" />
      </>,
    );

    fireEvent.contextMenu(screen.getByText("Refactor sidebar"));
    expect(screen.getByRole("menu")).toBeVisible();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(runsCancel).not.toHaveBeenCalled();
  });

  it("selects the next menu item with ArrowDown + Enter", () => {
    const statusSpy = vi.spyOn(useThreadsStore.getState(), "setThreadStatus");

    render(<Sidebar width={288} />);

    fireEvent.contextMenu(screen.getByText("Refactor sidebar"));
    const menu = screen.getByRole("menu");
    fireEvent.keyDown(document.activeElement ?? menu, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement ?? menu, { key: "Enter" });

    expect(statusSpy).toHaveBeenCalledWith("t2", "settled");
  });
});

describe("Sidebar branding", () => {
  beforeEach(() => {
    navigate.mockReset().mockResolvedValue(undefined);
    useProjectsStore.setState({ projects: [], selectedProjectId: null, loaded: true });
    useThreadsStore.setState({
      threads: [],
      activeThreadId: null,
      loaded: true,
      unreadIds: [],
    } as never);
    useUiStore.setState({
      sidebarOpen: true,
      rightPanelOpen: false,
      collapsedProjects: [],
      instances: [],
      selectedInstanceId: null,
      paletteOpen: false,
    });
  });

  it("renders the sole pult brand header label and PultLogo with no Settings gear in top chrome", () => {
    const { container } = render(<Sidebar width={288} />);

    const aside = container.querySelector("aside");
    expect(aside).not.toBeNull();

    const logos = aside!.querySelectorAll('svg[aria-label="pult"]');
    expect(logos).toHaveLength(1);
    expect(screen.getAllByText("pult")).toHaveLength(1);

    const topChrome = logos[0].closest("div");
    expect(topChrome).not.toBeNull();
    expect(topChrome).toHaveClass("h-10");
    expect(topChrome!.querySelector('button[aria-label*="settings" i]')).toBeNull();
  });
});
