import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";

import type { RememberedPermission } from "../src/lib/types";

const {
  navigate,
  routerState,
  settingsSet,
  permissionsRememberedList,
  permissionsRememberedClear,
  mockWindow,
} = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
  routerState: { pathname: "/settings/general" },
  settingsSet: vi.fn(async () => undefined),
  permissionsRememberedList: vi.fn(async (): Promise<RememberedPermission[]> => []),
  permissionsRememberedClear: vi.fn<
    (filters?: { workspace?: string; instanceId?: string; toolKind?: string }) => Promise<void>
  >(async () => undefined),
  mockWindow: {
    minimize: vi.fn(async () => undefined),
    toggleMaximize: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    isMaximized: vi.fn(async () => false),
    onResized: vi.fn(async () => () => {}),
  },
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
    settingsSet,
    permissionsRememberedList,
    permissionsRememberedClear,
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
  Outlet: () => <div data-testid="settings-outlet" />,
  useRouter: () => ({
    navigate,
    history: {
      back: vi.fn(),
      forward: vi.fn(),
      canGoBack: () => false,
    },
  }),
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: routerState.pathname } }),
}));

import { Route as GeneralRoute } from "../src/routes/settings.general";
import { Route as ChatRoute } from "../src/routes/settings.chat";
import { SettingsLayout } from "../src/routes/settings";
import { useSettingsStore } from "../src/stores/settings";

const GeneralSettings = GeneralRoute.options.component!;
const ChatSettings = ChatRoute.options.component!;

describe("settings pages", () => {
  beforeEach(() => {
    settingsSet.mockReset().mockResolvedValue(undefined);
    permissionsRememberedList.mockReset().mockResolvedValue([]);
    permissionsRememberedClear.mockReset().mockResolvedValue(undefined);
    routerState.pathname = "/settings/general";
    useSettingsStore.setState({
      confirmDeleteThread: true,
      sendKey: "enter",
      followStreaming: true,
      showTimestamps: true,
      notificationsEnabled: true,
      notificationSound: true,
    });
  });

  it("toggles GeneralSettings switch and persists via settingsSet", () => {
    render(<GeneralSettings />);

    const toggle = screen.getByRole("switch", { name: "Confirm before deleting threads" });
    expect(toggle).toHaveAttribute("aria-checked", "true");

    fireEvent.click(toggle);
    expect(useSettingsStore.getState().confirmDeleteThread).toBe(false);
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(settingsSet).toHaveBeenCalledWith("confirm_delete_thread", false);

    fireEvent.click(toggle);
    expect(useSettingsStore.getState().confirmDeleteThread).toBe(true);
    expect(settingsSet).toHaveBeenCalledWith("confirm_delete_thread", true);
  });

  it("GeneralSettings lists and revokes remembered permissions", async () => {
    permissionsRememberedList.mockResolvedValue([
      {
        workspace: "C:\\work\\alpha",
        instanceId: "claude",
        toolKind: "edit",
        optionId: "allow_always",
      },
      {
        workspace: "C:\\work\\beta",
        instanceId: "codex",
        toolKind: "execute",
        optionId: "allow_always",
      },
    ]);

    render(<GeneralSettings />);

    expect(await screen.findByText("Remembered permissions")).toBeInTheDocument();
    expect(await screen.findByText(/C:\\work\\alpha/)).toBeInTheDocument();
    expect(screen.getByText(/claude/)).toBeInTheDocument();
    expect(screen.getByText(/edit/)).toBeInTheDocument();

    const revokeButtons = screen.getAllByRole("button", { name: /revoke/i });
    fireEvent.click(revokeButtons[0]!);
    await waitFor(() =>
      expect(permissionsRememberedClear).toHaveBeenCalledWith({
        workspace: "C:\\work\\alpha",
        instanceId: "claude",
        toolKind: "edit",
      }),
    );

    const clearAllButton = screen.getByRole("button", { name: /clear all/i });
    fireEvent.click(clearAllButton);
    await waitFor(() => expect(permissionsRememberedClear).toHaveBeenCalledTimes(2));
    expect(permissionsRememberedClear.mock.calls[1]?.[0]).toBeUndefined();
  });

  it("toggles ChatSettings switches and send-key radio and persists via settingsSet", () => {
    render(<ChatSettings />);

    const modEnterRadio = screen.getByRole("radio", { name: "Mod+Enter" });
    fireEvent.click(modEnterRadio);
    expect(useSettingsStore.getState().sendKey).toBe("mod-enter");
    expect(settingsSet).toHaveBeenCalledWith("send_key", "mod-enter");

    const followSwitch = screen.getByRole("switch", { name: "Follow streaming output" });
    fireEvent.click(followSwitch);
    expect(useSettingsStore.getState().followStreaming).toBe(false);
    expect(settingsSet).toHaveBeenCalledWith("follow_streaming", false);

    const timestampsSwitch = screen.getByRole("switch", { name: "Show message timestamps" });
    fireEvent.click(timestampsSwitch);
    expect(useSettingsStore.getState().showTimestamps).toBe(false);
    expect(settingsSet).toHaveBeenCalledWith("show_timestamps", false);

    const notificationsSwitch = screen.getByRole("switch", { name: "Notifications" });
    expect(notificationsSwitch).toHaveAttribute("aria-checked", "true");
    fireEvent.click(notificationsSwitch);
    expect(useSettingsStore.getState().notificationsEnabled).toBe(false);
    expect(notificationsSwitch).toHaveAttribute("aria-checked", "false");
    expect(settingsSet).toHaveBeenCalledWith("notifications_enabled", false);

    const soundSwitch = screen.getByRole("switch", { name: "Notification sound" });
    expect(soundSwitch).toHaveAttribute("aria-checked", "true");
    fireEvent.click(soundSwitch);
    expect(useSettingsStore.getState().notificationSound).toBe(false);
    expect(soundSwitch).toHaveAttribute("aria-checked", "false");
    expect(settingsSet).toHaveBeenCalledWith("notification_sound", false);
  });

  it("filters SettingsLayout nav items via the search input", () => {
    render(<SettingsLayout />);

    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(nav).toBeVisible();
    expect(screen.getByRole("link", { name: "General" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Appearance" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Providers" })).toBeVisible();

    const search = screen.getByLabelText("Search settings");
    fireEvent.change(search, { target: { value: "appear" } });

    expect(screen.getByRole("link", { name: "Appearance" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "General" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Providers" })).toBeNull();

    fireEvent.change(search, { target: { value: "zzzz" } });
    expect(screen.getByText(/Nothing matches/)).toBeVisible();
    expect(screen.queryByRole("link", { name: "Appearance" })).toBeNull();
  });
});
