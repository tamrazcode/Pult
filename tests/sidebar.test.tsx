import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as IpcModule from "../src/lib/ipc";
import type { Project, Thread } from "../src/lib/types";

const {
  navigate,
  historyBack,
  historyForward,
  threadsList,
  projectsList,
  providersInstancesList,
  settingsGet,
  settingsSet,
} = vi.hoisted(() => ({
  navigate: vi.fn(),
  historyBack: vi.fn(),
  historyForward: vi.fn(),
  threadsList: vi.fn(async (): Promise<Thread[]> => []),
  projectsList: vi.fn(async (): Promise<Project[]> => []),
  providersInstancesList: vi.fn(async () => []),
  settingsGet: vi.fn(async (): Promise<unknown> => null),
  settingsSet: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    threadsList,
    projectsList,
    providersInstancesList,
    settingsGet,
    settingsSet,
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

import { Sidebar } from "../src/components/layout/Sidebar";
import { Topbar } from "../src/components/layout/Topbar";
import { useProjectsStore } from "../src/stores/projects";
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

  beforeEach(() => {
    navigate.mockReset().mockResolvedValue(undefined);
    historyBack.mockReset();
    historyForward.mockReset();
    projectsList.mockReset().mockResolvedValue([alpha, beta]);
    threadsList.mockReset().mockResolvedValue(seededThreads);
    providersInstancesList.mockReset().mockResolvedValue([]);
    settingsGet.mockReset().mockResolvedValue(null);
    settingsSet.mockReset().mockResolvedValue(undefined);

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
    });
  });

  it("omits legacy shelf headings and 'New thread with workspace' button", () => {
    render(<Sidebar width={288} />);

    expect(screen.queryByText(/^drafts$/i)).toBeNull();
    expect(screen.queryByText(/^snoozed$/i)).toBeNull();
    expect(screen.queryByText(/^settled$/i)).toBeNull();
    expect(screen.queryByText(/^pinned$/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /new thread with workspace/i })).toBeNull();
  });

  it("renders project rows with colored initials", () => {
    render(<Sidebar width={288} />);

    expect(screen.getByText("Alpha")).toBeVisible();
    const alphaBadge = Array.from(document.querySelectorAll("[style]")).find(
      (el) =>
        (el as HTMLElement).style.backgroundColor === "rgb(52, 107, 241)" &&
        /^a/i.test(el.textContent?.trim() ?? ""),
    );
    expect(alphaBadge).toBeTruthy();
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

  it("renders footer buttons (Settings, Pull requests, Usage, Refresh) and triggers actions", async () => {
    render(<Sidebar width={288} />);

    const settingsBtn = screen.getByRole("button", { name: /settings/i });
    const prsBtn = screen.getByRole("button", { name: /pull requests/i });
    const usageBtn = screen.getByRole("button", { name: /usage/i });
    const refreshBtn = screen.getByRole("button", { name: /refresh/i });

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
});

describe("Topbar", () => {
  beforeEach(() => {
    navigate.mockReset().mockResolvedValue(undefined);
    useThreadsStore.setState({ threads: [], activeThreadId: null, loaded: true });
    useUiStore.setState({ sidebarOpen: true, rightPanelOpen: false, appVersion: null });
  });

  it("does not render a Settings gear button", () => {
    render(<Topbar />);

    expect(screen.queryByRole("button", { name: /settings/i })).toBeNull();
  });
});
