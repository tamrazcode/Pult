import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as IpcModule from "../src/lib/ipc";
import type { ProviderUpdate } from "../src/lib/ipc";

const {
  navigate,
  providersUpdateCheck,
  providersUpdateInstall,
  projectsList,
  threadsList,
  providersInstancesList,
  settingsGet,
  settingsSet,
} = vi.hoisted(() => ({
  navigate: vi.fn(),
  providersUpdateCheck: vi.fn(),
  providersUpdateInstall: vi.fn(),
  projectsList: vi.fn(async () => []),
  threadsList: vi.fn(async () => []),
  providersInstancesList: vi.fn(async () => []),
  settingsGet: vi.fn(async () => null),
  settingsSet: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/tauri", () => ({ isTauri: () => true }));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    providersUpdateCheck,
    providersUpdateInstall,
    projectsList,
    threadsList,
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
    history: { back: vi.fn(), forward: vi.fn(), canGoBack: () => false },
  }),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/chat" } }),
}));

import { Sidebar, formatUpdateProgress } from "../src/components/layout/Sidebar";
import { useProjectsStore } from "../src/stores/projects";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

const codex: ProviderUpdate = {
  instanceId: "codex",
  displayName: "Codex",
  package: "@openai/codex",
  current: "0.169.0",
  latest: "0.170.0",
  managed: true,
};

const opencode: ProviderUpdate = {
  instanceId: "opencode",
  displayName: "OpenCode",
  package: "opencode",
  current: "1.0.0",
  latest: "1.1.0",
  managed: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function openUpdates() {
  const user = userEvent.setup();
  const { container } = render(<Sidebar width={288} />);
  const footer = container.querySelector<HTMLElement>("aside footer");
  if (!footer) throw new Error("Sidebar footer not found");

  const refreshButton = within(footer).getByRole("button", { name: /^refresh$/i });
  await user.click(refreshButton);
  await waitFor(() => expect(refreshButton.getAttribute("title")).toMatch(/^Update \d+ provider/));
  await user.click(refreshButton);
  return { user, footer, refreshButton };
}

describe("sidebar provider updates", () => {
  beforeEach(() => {
    navigate.mockClear();
    providersUpdateCheck.mockReset();
    providersUpdateInstall.mockReset();
    projectsList.mockClear();
    threadsList.mockClear();
    providersInstancesList.mockClear();
    useProjectsStore.setState({ projects: [], selectedProjectId: null, loaded: true });
    useThreadsStore.setState({ threads: [], activeThreadId: null, unreadIds: [], loaded: true });
    useUiStore.setState({ instances: [], selectedInstanceId: null, collapsedProjects: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("formats and displays per-provider progress while installing sequential updates", async () => {
    expect(formatUpdateProgress(codex)).toBe("Updating Codex 0.169.0 -> 0.170.0");

    const first = deferred<void>();
    const second = deferred<void>();
    providersUpdateCheck.mockResolvedValueOnce([codex, opencode]).mockResolvedValueOnce([]);
    providersUpdateInstall.mockImplementation((id: string) =>
      id === "codex" ? first.promise : second.promise,
    );

    const { user, footer, refreshButton } = await openUpdates();

    await waitFor(() => {
      const progress = footer.querySelector("[data-update-progress]");
      expect(progress).not.toBeNull();
      expect(progress).toHaveAttribute("role", "status");
      expect(progress).toHaveTextContent("Updating Codex 0.169.0 -> 0.170.0");
    });
    expect(providersUpdateInstall).toHaveBeenCalledTimes(1);
    expect(providersUpdateInstall).toHaveBeenCalledWith("codex");

    first.resolve();
    await waitFor(() => {
      const progress = footer.querySelector("[data-update-progress]");
      expect(progress).not.toBeNull();
      expect(progress).toHaveTextContent("Updating OpenCode 1.0.0 -> 1.1.0");
    });
    expect(providersUpdateInstall).toHaveBeenCalledTimes(2);
    expect(providersUpdateInstall).toHaveBeenNthCalledWith(2, "opencode");

    second.resolve();
    await waitFor(() => {
      expect(footer.querySelector("[data-update-progress]")).toBeNull();
      expect(footer.querySelector("[data-update-error]")).toBeNull();
      expect(refreshButton).toHaveAttribute("title", "Check provider updates");
    });
    expect(providersUpdateCheck).toHaveBeenCalledTimes(2);
    expect(refreshButton.querySelector("span")).toBeNull();

    await user.unhover(refreshButton);
    refreshButton.blur();
  });

  it("keeps failed updates with a visible error, retry badge, tooltip error, and post-loop check", async () => {
    providersUpdateCheck.mockResolvedValueOnce([codex, opencode]).mockResolvedValueOnce([codex]);
    providersUpdateInstall.mockImplementation(async (id: string) => {
      if (id === "codex") throw new Error("codex update failed: permission denied");
    });

    const { user, footer, refreshButton } = await openUpdates();

    await waitFor(() => {
      const errorEl = footer.querySelector("[data-update-error]");
      expect(errorEl).not.toBeNull();
      expect(errorEl).toHaveAttribute("role", "alert");
      expect(errorEl).toHaveTextContent("Codex: codex update failed: permission denied");
    });
    expect(providersUpdateInstall).toHaveBeenCalledTimes(2);
    expect(providersUpdateCheck).toHaveBeenCalledTimes(2);
    expect(refreshButton.querySelector("span")).not.toBeNull();
    expect(refreshButton).toHaveAttribute("title", "Codex: codex update failed: permission denied");

    await user.hover(refreshButton);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("Codex: codex update failed: permission denied");

    await user.unhover(refreshButton);
    refreshButton.blur();
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("retains a failed update when the post-loop check rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    providersUpdateCheck
      .mockResolvedValueOnce([codex])
      .mockRejectedValueOnce(new Error("network down"));
    providersUpdateInstall.mockRejectedValue(new Error("network timeout"));

    const { user, footer, refreshButton } = await openUpdates();

    await waitFor(() => {
      const errorEl = footer.querySelector("[data-update-error]");
      expect(errorEl).not.toBeNull();
      expect(errorEl).toHaveAttribute("role", "alert");
      expect(errorEl).toHaveTextContent("Codex: network timeout");
    });
    expect(providersUpdateCheck).toHaveBeenCalledTimes(2);
    expect(refreshButton.querySelector("span")).not.toBeNull();
    expect(refreshButton).toHaveAttribute("title", "Codex: network timeout");
    expect(errorSpy).toHaveBeenCalledWith("provider update check failed", expect.any(Error));

    await user.hover(refreshButton);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Codex: network timeout");

    await user.unhover(refreshButton);
    refreshButton.blur();
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });
});
