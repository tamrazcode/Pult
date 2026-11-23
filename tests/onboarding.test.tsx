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
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/chat" } }),
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

const CLAUDE_AGENT: DetectedAgent = {
  id: "claude-code",
  displayName: "Claude Code",
  command: "claude",
  suggestedInstanceId: "claude-code",
  suggestedCommand: ["npx", "-y", "@zed-industries/claude-code-acp"],
  notes: "Anthropic CLI",
};

const CODEX_AGENT: DetectedAgent = {
  id: "codex",
  displayName: "Codex CLI",
  command: "codex",
  suggestedInstanceId: "codex",
  suggestedCommand: ["npx", "-y", "@agentclientprotocol/codex-acp"],
  notes: "OpenAI CLI",
};

function expectCenteredShell(titleText: string, primaryAction: RegExp) {
  const heading = screen.getByRole("heading", { name: titleText });
  expect(heading.parentElement).toHaveClass("mx-auto", "text-center");
  const action = screen.getByRole("button", { name: primaryAction });
  expect(action.parentElement).toHaveClass("flex", "items-center", "justify-center");
  expect(screen.queryByRole("button", { name: /skip intro/i })).toBeNull();
  expect(screen.queryByText(/skip intro/i)).toBeNull();
  expect(screen.queryByText(/\b0[1-4]\s*\/\s*04\b/)).toBeNull();
  expect(screen.queryByText(/\b0[2-4]\s*—/)).toBeNull();
}

describe("Onboarding wizard (WelcomePage)", () => {
  beforeEach(() => {
    navigate.mockReset().mockResolvedValue(undefined);
    settingsSet.mockReset().mockResolvedValue(undefined);
    providersDetectInstalled.mockReset().mockResolvedValue([CLAUDE_AGENT, CODEX_AGENT]);
    useSettingsStore.setState({ profile: null });
    useUiStore.setState({ sidebarOpen: true, rightPanelOpen: false, projectWidgetOpen: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders centered Pult logo with scattered floating provider pills, real logos, and short names on step 1", async () => {
    const { container } = render(<WelcomePage />);

    expect(await screen.findByText("Claude Code")).toBeVisible();
    expect(screen.getByText("Codex")).toBeVisible();
    expect(screen.queryByText("Codex CLI")).toBeNull();
    expectCenteredShell("Meet Pult. Every agent in one workspace.", /get started/i);

    const pultLogo = container.querySelector('svg[aria-label="Pult"]');
    expect(pultLogo).not.toBeNull();
    expect(pultLogo!.parentElement).toHaveClass(
      "top-1/2",
      "left-1/2",
      "-translate-x-1/2",
      "-translate-y-1/2",
    );

    expect(container.querySelectorAll("line")).toHaveLength(0);
    expect(container.querySelector('[data-provider-logo="claude"]')).toBeInTheDocument();
    expect(container.querySelector('[data-provider-logo="codex"]')).toBeInTheDocument();

    const claudePill = screen.getByText("Claude Code").closest(".pult-float") as HTMLElement | null;
    const codexPill = screen.getByText("Codex").closest(".pult-float") as HTMLElement | null;
    expect(claudePill).not.toBeNull();
    expect(codexPill).not.toBeNull();
    expect(claudePill!.style.animationDelay).toBe("0s");
    expect(codexPill!.style.animationDelay).toBe("0.85s");

    expect(parseFloat(claudePill!.parentElement!.style.left)).toBeLessThan(50);
    expect(parseFloat(codexPill!.parentElement!.style.left)).toBeGreaterThan(50);
  });

  it("advances through agents, workflow, and profile steps with shared centered shell and no eyebrows or step counters", async () => {
    render(<WelcomePage />);
    expect(await screen.findByText("Claude Code")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /get started/i }));
    expectCenteredShell("Bring your agents.", /continue/i);
    expect(screen.queryByText(/02\s*—\s*agents/i)).toBeNull();

    const claudeCard = screen.getByTestId("connect-row-claude-code").parentElement!;
    const codexCard = screen.getByTestId("connect-row-codex").parentElement!;
    expect(claudeCard).toHaveTextContent("Claude Code");
    expect(codexCard).toHaveTextContent("Codex");
    expect(codexCard).not.toHaveTextContent("Codex CLI");
    expect(claudeCard).toHaveClass("min-w-0");
    expect(codexCard).toHaveClass("min-w-0");
    expect(claudeCard.parentElement).toHaveClass("grid-cols-1", "sm:grid-cols-2");

    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expectCenteredShell("One thread, all the tools.", /continue/i);
    expect(screen.queryByText(/03\s*—\s*workflow/i)).toBeNull();
    expect(screen.getByText("Git & worktrees")).toBeVisible();
    expect(screen.getByText("Built-in browser")).toBeVisible();
    expect(screen.getByText("Terminal")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    expectCenteredShell("Pick your local profile.", /finish/i);
    expect(screen.queryByText(/04\s*—\s*profile/i)).toBeNull();
    expect(screen.getByLabelText("Nickname")).toBeVisible();
    expect(screen.getByLabelText("Handle")).toBeVisible();
  });

  it("validates nickname and @handle on Finish, saves profile, persists onboarding_completed, and navigates after exit animation", async () => {
    const { container } = render(<WelcomePage />);
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
    expect(container.querySelector(".onboarding-exit")).not.toBeNull();
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(navigate).toHaveBeenCalledWith({ to: "/chat", replace: true });
  });
});
