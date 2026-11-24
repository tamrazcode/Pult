import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";
import type { InstanceInfo, Thread } from "../src/lib/types";

const { navigate, providersInstancesList, workspaceFiles, runsCancel } = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
  providersInstancesList: vi.fn(async () => []),
  workspaceFiles: vi.fn(async () => []),
  runsCancel: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    providersInstancesList,
    workspaceFiles,
    runsCancel,
    onThreadUpdate: vi.fn(async () => () => {}),
    onAgentProcess: vi.fn(async () => () => {}),
  };
});

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/thread/th" } }),
  useRouter: () => ({ navigate }),
}));

import { ChatColumn } from "../src/components/chat/ChatColumn";
import { ChatHeader } from "../src/components/chat/ChatHeader";
import { useProjectsStore } from "../src/stores/projects";
import { useRunsStore } from "../src/stores/runs";
import { useSubagentsStore } from "../src/stores/subagents";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

const mockInstance: InstanceInfo = {
  id: "mock",
  displayName: "Mock",
  enabled: true,
  driver: "mock",
  command: "node",
  args: [],
  env: {},
  status: "running",
  promptImage: false,
  loadSession: true,
  modes: [],
  configOptions: [],
  authMethods: [],
};

const makeThread = (overrides: Partial<Thread> = {}): Thread => ({
  id: "th-1",
  projectId: null,
  title: "Thread",
  status: "draft",
  pinned: false,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
});

describe("Subagent thread view", () => {
  beforeEach(() => {
    navigate.mockReset().mockResolvedValue(undefined);
    Element.prototype.scrollIntoView = vi.fn();
    useProjectsStore.setState({ projects: [], selectedProjectId: null, loaded: true });
    useThreadsStore.setState({ threads: [], activeThreadId: null, unreadIds: [], loaded: true });
    useSubagentsStore.setState({ tasks: {}, order: [], finished: {} });
    useRunsStore.setState({
      runsByThread: {},
      viewsByRun: {},
      appliedEvents: {},
      commandsByThread: {},
      queueByThread: {},
      pendingUserByThread: {},
      desiredModeByThread: {},
      desiredConfigByThread: {},
      activeElicitation: null,
    });
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [mockInstance],
      instanceByThread: {},
      paletteOpen: false,
      projectWidgetOpen: false,
      rightPanelOpen: false,
      sidebarOpen: true,
    });
  });

  it("ChatColumn hides Composer for a child thread without a read-only banner", () => {
    const parent = makeThread({ id: "th-parent", title: "Root task" });
    const child = makeThread({
      id: "th-child",
      title: "Inspect logs",
      parentThreadId: "th-parent",
      parentRunId: "run-1",
      depth: 1,
      lineageKind: "app",
      childRole: "research",
    });
    useThreadsStore.setState({ threads: [parent, child], activeThreadId: "th-child" });

    render(<ChatColumn threadId="th-child" />);

    expect(
      screen.queryByText("Read-only subagent thread. Continue in the parent chat."),
    ).toBeNull();
    // No composer, so no ambient backdrop either.
    expect(document.querySelector("[data-composer-ambient]")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send message" })).toBeNull();
  });

  it("ChatColumn renders Composer for a regular thread", () => {
    const regular = makeThread({ id: "th-regular", title: "Normal chat" });
    useThreadsStore.setState({ threads: [regular], activeThreadId: "th-regular" });

    render(<ChatColumn threadId="th-regular" />);

    expect(screen.getByRole("textbox")).toBeVisible();
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
  });

  it("ChatHeader shows parent breadcrumb and hides Pin/Rename for a child thread", () => {
    const parent = makeThread({ id: "th-parent", title: "Build feature X" });
    const child = makeThread({
      id: "th-child",
      title: "Write unit tests",
      parentThreadId: "th-parent",
      depth: 1,
    });
    useThreadsStore.setState({ threads: [parent, child], activeThreadId: "th-child" });

    render(<ChatHeader threadId="th-child" />);

    const breadcrumb = screen.getByRole("button", { name: "Subagent of Build feature X" });
    expect(breadcrumb).toBeVisible();
    expect(screen.getByRole("heading", { name: "Write unit tests" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Rename thread" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Pin thread" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Unpin thread" })).toBeNull();

    fireEvent.click(breadcrumb);
    expect(navigate).toHaveBeenCalledWith({
      to: "/thread/$threadId",
      params: { threadId: "th-parent" },
    });
  });

  it("ChatHeader shows Pin and Rename and omits breadcrumb for a regular thread", () => {
    const regular = makeThread({ id: "th-regular", title: "Main chat" });
    useThreadsStore.setState({ threads: [regular], activeThreadId: "th-regular" });

    render(<ChatHeader threadId="th-regular" />);

    expect(screen.queryByText(/Subagent of/)).toBeNull();
    expect(screen.getByRole("button", { name: "Rename thread" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pin thread" })).toBeInTheDocument();
  });
});
