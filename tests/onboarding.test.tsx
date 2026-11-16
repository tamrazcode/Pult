import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";
import type * as AgentConnectModule from "../src/components/settings/AgentConnect";
import type { DetectedAgent } from "../src/lib/types";

const { navigate, settingsSet, providersDetectInstalled, mockWindow } = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
  settingsSet: vi.fn(async () => undefined),
  providersDetectInstalled: vi.fn(async (): Promise<DetectedAgent[]> => []),
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
    providersDetectInstalled,
  };
});

vi.mock("../src/components/settings/AgentConnect", async (importOriginal) => {
  const actual = await importOriginal<typeof AgentConnectModule>();
  return {
    ...actual,
    ConnectRow: ({ agent }: { agent: DetectedAgent }) => (
      <div data-testid={`connect-row-${agent.id}`}>{agent.displayName}</div>
    ),
  };
});

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  useRouter: () => ({
    navigate,
    history: {
      back: vi.fn(),
      forward: vi.fn(),
      canGoBack: () => false,
    },
  }),
}));

import { WelcomePage } from "../src/routes/welcome";
import { useSettingsStore } from "../src/stores/settings";
import { useUiStore } from "../src/stores/ui";

const MOCK_AGENT: DetectedAgent = {
  id: "claude",
  displayName: "Claude Code",
  command: "claude",
  suggestedInstanceId: "claude",
  suggestedCommand: ["claude"],
  notes: "Anthropic CLI",
};

describe("Onboarding wizard (WelcomePage)", () => {
  beforeEach(() => {
    navigate.mockReset().mockResolvedValue(undefined);
    settingsSet.mockReset().mockResolvedValue(undefined);
    providersDetectInstalled.mockReset().mockResolvedValue([MOCK_AGENT]);
    useSettingsStore.setState({ profile: null });
    useUiStore.setState({ sidebarOpen: true, rightPanelOpen: false, projectWidgetOpen: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders step 1 greeting and Get started, and advances through agents, workflow, and profile steps", async () => {
    render(<WelcomePage />);

    expect(screen.getByText("01 / 04")).toBeVisible();
    expect(screen.getByText("Meet Pult. Every agent in one workspace.")).toBeVisible();
    expect(await screen.findByText("Claude Code")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    expect(screen.getByText("02 / 04")).toBeVisible();
    expect(screen.getByText("Bring your agents.")).toBeVisible();
    expect(screen.getByTestId("connect-row-claude")).toHaveTextContent("Claude Code");

    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(screen.getByText("03 / 04")).toBeVisible();
    expect(screen.getByText("One thread, all the tools.")).toBeVisible();
    expect(screen.getByText("Git & worktrees")).toBeVisible();
    expect(screen.getByText("Built-in browser")).toBeVisible();
    expect(screen.getByText("Terminal")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(screen.getByText("04 / 04")).toBeVisible();
    expect(screen.getByText("Pick your local profile.")).toBeVisible();
    expect(screen.getByLabelText("Nickname")).toBeVisible();
    expect(screen.getByLabelText("Handle")).toBeVisible();
    expect(screen.getByRole("button", { name: /finish/i })).toBeVisible();
  });

  it("validates nickname and @handle on Finish, saves profile via useSettingsStore, and persists onboarding_completed", async () => {
    render(<WelcomePage />);
    await waitFor(() => expect(providersDetectInstalled).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    fireEvent.click(screen.getByRole("button", { name: /finish/i }));
    expect(screen.getByRole("alert")).toHaveTextContent("Give your profile a name.");
    expect(settingsSet).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().profile).toBeNull();

    fireEvent.change(screen.getByLabelText("Nickname"), { target: { value: "Ada Lovelace" } });
    fireEvent.change(screen.getByLabelText("Handle"), { target: { value: "a!" } });
    fireEvent.click(screen.getByRole("button", { name: /finish/i }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Handle must be 2–24 characters: a–z, 0–9 or _.",
    );
    expect(settingsSet).not.toHaveBeenCalled();

    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText("Handle"), { target: { value: "ada_l" } });
    fireEvent.click(screen.getByRole("button", { name: /finish/i }));

    const expectedProfile = {
      version: 1 as const,
      nickname: "Ada Lovelace",
      handle: "ada_l",
      avatar: { kind: "initials" as const, value: "", hue: 215 },
    };
    expect(useSettingsStore.getState().profile).toEqual(expectedProfile);
    expect(settingsSet).toHaveBeenCalledWith("profile", expectedProfile);
    expect(settingsSet).toHaveBeenCalledWith("onboarding_completed", true);

    act(() => {
      vi.advanceTimersByTime(520);
    });
    expect(navigate).toHaveBeenCalledWith({ to: "/chat", replace: true });
  });

  it("navigates to /chat when Skip intro is clicked", async () => {
    render(<WelcomePage />);
    await waitFor(() => expect(providersDetectInstalled).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /skip intro/i }));
    expect(navigate).toHaveBeenCalledWith({ to: "/chat" });
    expect(settingsSet).not.toHaveBeenCalled();
  });
});
