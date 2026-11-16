import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";
import type { AppUpdateInfo } from "../src/lib/ipc";

type ProgressHandler = (payload: { downloaded: number; total: number | null }) => void;

const { navigate, appUpdateCheck, appUpdateInstall, progressRef, projectsList, threadsList } =
  vi.hoisted(() => ({
    navigate: vi.fn(),
    appUpdateCheck: vi.fn(),
    appUpdateInstall: vi.fn(),
    progressRef: { current: null as ProgressHandler | null },
    projectsList: vi.fn(async () => []),
    threadsList: vi.fn(async () => []),
  }));

vi.mock("../src/lib/tauri", () => ({ isTauri: () => true }));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    appUpdateCheck,
    appUpdateInstall,
    onAppUpdateProgress: vi.fn(async (handler: ProgressHandler) => {
      progressRef.current = handler;
      return () => {
        progressRef.current = null;
      };
    }),
    projectsList,
    threadsList,
    providersInstancesList: vi.fn(async () => []),
    settingsGet: vi.fn(async () => null),
    settingsSet: vi.fn(async () => undefined),
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

import { Sidebar } from "../src/components/layout/Sidebar";
import { useProjectsStore } from "../src/stores/projects";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

const update: AppUpdateInfo = {
  version: "0.2.0",
  currentVersion: "0.1.0",
  body: "Fixes and polish",
};

function footerButton() {
  const { container } = render(<Sidebar width={288} />);
  const footer = container.querySelector<HTMLElement>("aside footer");
  if (!footer) throw new Error("Sidebar footer not found");
  return { footer, button: within(footer).getByRole("button", { name: /Pult updates/i }) };
}

describe("sidebar app updates", () => {
  beforeEach(() => {
    navigate.mockClear();
    appUpdateCheck.mockReset();
    appUpdateInstall.mockReset();
    progressRef.current = null;
    useProjectsStore.setState({ projects: [], selectedProjectId: null, loaded: true });
    useThreadsStore.setState({ threads: [], activeThreadId: null, unreadIds: [], loaded: true });
    useUiStore.setState({ instances: [], selectedInstanceId: null, collapsedProjects: [] });
  });

  it("reports when Pult is up to date", async () => {
    appUpdateCheck.mockResolvedValueOnce(null);
    const { button } = footerButton();

    fireEvent.click(button);

    await waitFor(() => expect(button).toHaveAttribute("title", "Pult is up to date"));
    expect(appUpdateInstall).not.toHaveBeenCalled();
  });

  it("shows the available version, then installs with a circular progress and status", async () => {
    appUpdateCheck.mockResolvedValueOnce(update);
    const install = new Promise<void>(() => {});
    appUpdateInstall.mockReturnValueOnce(install);
    const { footer, button } = footerButton();

    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("title", "Update Pult to 0.2.0"));
    expect(button.querySelector("span.rounded-full")).not.toBeNull();

    fireEvent.click(button);
    await waitFor(() => expect(appUpdateInstall).toHaveBeenCalledTimes(1));
    expect(footer.querySelector("[data-update-progress]")).not.toBeNull();

    progressRef.current?.({ downloaded: 50, total: 100 });
    await waitFor(() =>
      expect(footer.querySelector("[data-update-progress]")).toHaveTextContent(
        "Installing update · 50%",
      ),
    );
    expect(footer.querySelector("svg circle:last-of-type")).not.toBeNull();
  });

  it("shows a short error when the update feed is not configured", async () => {
    appUpdateCheck.mockRejectedValueOnce({
      code: "updater.unconfigured",
      message: "not configured",
    });
    const { footer, button } = footerButton();

    fireEvent.click(button);

    await waitFor(() => {
      const error = footer.querySelector("[data-update-error]");
      expect(error).not.toBeNull();
      expect(error).toHaveAttribute("role", "alert");
    });
    expect(screen.getByRole("button", { name: /not configured|update/i })).toBeInTheDocument();
  });
});
