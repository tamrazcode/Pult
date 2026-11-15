import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";
import type { Project } from "../src/lib/types";

const { navigate, providersInstancesList } = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
  providersInstancesList: vi.fn(async () => []),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    providersInstancesList,
    onAgentProcess: vi.fn(async () => () => {}),
  };
});

vi.mock("../src/lib/tauri", () => ({
  isTauri: () => false,
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate }),
}));

import { NewChatEmptyState } from "../src/components/chat/NewChatEmptyState";
import { useProjectsStore } from "../src/stores/projects";
import { useRunsStore } from "../src/stores/runs";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

const project: Project = {
  id: "proj-1",
  name: "Pult App",
  rootPath: "C:\\work\\pult",
  color: "#346bf1",
  worktreeStrategy: "root",
  pinned: false,
  createdAt: 0,
};

describe("NewChatEmptyState", () => {
  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    useProjectsStore.setState({ projects: [], selectedProjectId: null, loaded: true });
    useThreadsStore.setState({ threads: [], activeThreadId: null, unreadIds: [], loaded: true });
    useRunsStore.setState({
      runsByThread: {},
      viewsByRun: {},
      appliedEvents: {},
      commandsByThread: {},
      queueByThread: {},
      desiredModeByThread: {},
      desiredConfigByThread: {},
      activeElicitation: null,
    });
    useUiStore.setState({ selectedInstanceId: null, instances: [] });
  });

  it("renders heading 'What should we work on?', living ASCII canvas, and no giant PultLogo", () => {
    useProjectsStore.setState({ projects: [project], selectedProjectId: null });

    const { container } = render(<NewChatEmptyState />);

    expect(screen.getByRole("heading", { name: "What should we work on?" })).toBeVisible();
    expect(screen.getByText("No project")).toBeVisible();
    expect(container.querySelector("canvas")).not.toBeNull();
    expect(screen.queryByRole("img", { name: "pult" })).toBeNull();
    expect(container.querySelector('[aria-label="pult"]')).toBeNull();
  });

  it("renders the selected project name subtitle when selectedProjectId is set", () => {
    useProjectsStore.setState({ projects: [project], selectedProjectId: "proj-1" });

    render(<NewChatEmptyState />);

    expect(screen.getByRole("heading", { name: "What should we work on?" })).toBeVisible();
    expect(screen.getByText("Pult App")).toBeVisible();
  });
});
