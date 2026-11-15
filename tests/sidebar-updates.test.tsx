import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
  render(<Sidebar width={288} />);
  await user.click(screen.getByRole("button", { name: /^refresh$/i }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: /^refresh$/i }).getAttribute("title")).toMatch(
      /^Update \d+ provider/,
    ),
  );
  await user.click(screen.getByRole("button", { name: /^refresh$/i }));
  return user;
}

describe("sidebar provider updates", () => {
  beforeEach(() => {
    navigate.mockClear();
    providersUpdateCheck.mockReset();
    providersUpdateInstall.mockReset();
  });

  it("formats and displays per-provider progress while installing sequential updates", async () => {
    expect(formatUpdateProgress(codex)).toBe("Updating Codex 0.169.0 -> 0.170.0");

    const first = deferred<void>();
    const second = deferred<void>();
    providersUpdateCheck.mockResolvedValueOnce([codex, opencode]).mockResolvedValue([]);
    providersUpdateInstall.mockImplementation((id: string) =>
      id === "codex" ? first.promise : second.promise,
    );

    await openUpdates();

    expect(await screen.findByText("Updating Codex 0.169.0 -> 0.170.0")).toBeInTheDocument();
    first.resolve();
    expect(await screen.findByText("Updating OpenCode 1.0.0 -> 1.1.0")).toBeInTheDocument();
    second.resolve();

    await waitFor(() => expect(screen.queryByText(/Updating Codex|Updating OpenCode/)).toBeNull());
    expect(providersUpdateCheck).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: /^refresh$/i })).toHaveAttribute(
      "title",
      "Check provider updates",
    );
  });

  it("keeps failed updates with a visible error and re-checks after the loop", async () => {
    providersUpdateCheck.mockResolvedValueOnce([codex, opencode]).mockResolvedValueOnce([codex]);
    providersUpdateInstall.mockImplementation(async (id: string) => {
      if (id === "codex") throw new Error("codex update failed: permission denied");
    });

    const user = await openUpdates();

    expect(
      await screen.findByText("Codex: codex update failed: permission denied"),
    ).toBeInTheDocument();
    expect(providersUpdateCheck).toHaveBeenCalledTimes(2);
    const button = screen.getByRole("button", { name: /^refresh$/i });
    expect(button.querySelector("span")).not.toBeNull();
    await user.hover(button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Codex: codex update failed: permission denied",
    );
  });

  it("retains a failed update when the post-loop check rejects", async () => {
    providersUpdateCheck
      .mockResolvedValueOnce([codex])
      .mockRejectedValueOnce(new Error("network down"));
    providersUpdateInstall.mockRejectedValue(new Error("network timeout"));

    await openUpdates();

    expect(await screen.findByText("Codex: network timeout")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^refresh$/i }).querySelector("span")).not.toBeNull();
  });
});
