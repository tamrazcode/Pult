import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InstanceInfo } from "../src/lib/types";

const { navigate } = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate }),
}));

vi.mock("../src/components/chat/Composer", () => ({
  Composer: () => <div data-testid="composer-mock" />,
}));

vi.mock("../src/components/chat/LivingAscii", () => ({
  LivingAscii: () => <div data-testid="living-ascii-mock" />,
}));

import { NewChatEmptyState } from "../src/components/chat/NewChatEmptyState";
import { useProjectsStore } from "../src/stores/projects";
import { useUiStore } from "../src/stores/ui";

function makeInstance(overrides: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    id: "inst-1",
    displayName: "Agent",
    enabled: true,
    driver: "acp",
    command: "agent",
    args: [],
    env: {},
    status: "stopped",
    promptImage: false,
    loadSession: false,
    modes: [],
    configOptions: [],
    authMethods: [],
    ...overrides,
  };
}

describe("NewChatEmptyState", () => {
  beforeEach(() => {
    navigate.mockReset();
    useProjectsStore.setState({ projects: [], selectedProjectId: null, loaded: true });
    useUiStore.setState({ instances: [] });
  });

  it("shows Connect an agent CTA when no enabled providers exist and navigates to /settings/providers", async () => {
    const user = userEvent.setup();
    useUiStore.setState({
      instances: [makeInstance({ id: "disabled", enabled: false })],
    });

    render(<NewChatEmptyState />);

    const cta = screen.getByRole("button", { name: "Connect an agent" });
    expect(cta).toBeVisible();
    expect(screen.queryByText(/Dev mock active/i)).toBeNull();

    await user.click(cta);
    expect(navigate).toHaveBeenCalledWith({ to: "/settings/providers" });
  });

  it("labels built-in dev mock without blocking chat and navigates to /settings/providers", async () => {
    const user = userEvent.setup();
    useUiStore.setState({
      instances: [makeInstance({ id: "mock", displayName: "Mock", driver: "mock", enabled: true })],
    });

    render(<NewChatEmptyState />);

    expect(screen.queryByRole("button", { name: "Connect an agent" })).toBeNull();
    const mockPill = screen.getByRole("button", { name: /Dev mock active/i });
    expect(mockPill).toBeVisible();

    await user.click(mockPill);
    expect(navigate).toHaveBeenCalledWith({ to: "/settings/providers" });
  });

  it("renders neither missing-agent CTA nor dev-mock label when a real provider is enabled", () => {
    useUiStore.setState({
      instances: [
        makeInstance({ id: "claude", displayName: "Claude", driver: "acp", enabled: true }),
      ],
    });

    render(<NewChatEmptyState />);

    expect(screen.queryByRole("button", { name: "Connect an agent" })).toBeNull();
    expect(screen.queryByText(/Dev mock active/i)).toBeNull();
  });
});
