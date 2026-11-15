import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEvent, fireEvent, render, screen, within } from "@testing-library/react";

const { navigate } = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
}));

vi.mock("@tanstack/react-router", () => ({
  createRootRoute: (options: unknown) => ({ options }),
  Outlet: () => <textarea aria-label="Editor" defaultValue="hello world" />,
  useRouter: () => ({ navigate }),
}));

vi.mock("../src/lib/tauri", () => ({
  isTauri: () => false,
}));

vi.mock("../src/components/layout/Sidebar", () => ({
  Sidebar: () => null,
}));
vi.mock("../src/components/layout/RightPanel", () => ({
  RightPanel: () => null,
}));
vi.mock("../src/components/ui/CommandPalette", () => ({
  CommandPalette: () => null,
  useGlobalHotkeys: () => undefined,
}));
vi.mock("../src/components/ui/ErrorBanner", () => ({
  ErrorBanner: () => null,
  RouteErrorCard: () => null,
}));
vi.mock("../src/components/ui/FpsOverlay", () => ({
  FpsOverlay: () => null,
}));
vi.mock("../src/components/ui/ResizeHandle", () => ({
  ResizeHandle: () => null,
}));
vi.mock("../src/components/chat/ElicitationModal", () => ({
  ElicitationModal: () => null,
}));

import { Route } from "../src/routes/__root";
import { useRunsStore } from "../src/stores/runs";
import { useUiStore } from "../src/stores/ui";

const RootLayout = Route.options.component!;

describe("RootLayout context menu", () => {
  beforeEach(() => {
    navigate.mockReset().mockResolvedValue(undefined);
    useUiStore.setState({
      sidebarOpen: false,
      rightPanelOpen: false,
      paletteOpen: false,
      pendingThreadId: null,
      selectedInstanceId: null,
    });
    useRunsStore.setState({
      activeElicitation: null,
    });
  });

  it("prevents default on textarea contextmenu and opens a menu with Cut, Copy, Paste, and Select All", () => {
    render(<RootLayout />);

    const textarea = screen.getByLabelText("Editor") as HTMLTextAreaElement;
    const event = createEvent.contextMenu(textarea, { clientX: 40, clientY: 60 });
    fireEvent(textarea, event);

    expect(event.defaultPrevented).toBe(true);

    const menu = screen.getByRole("menu", { name: "Context menu" });
    expect(menu).toBeVisible();
    expect(within(menu).getByRole("menuitem", { name: /^Cut/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /^Copy/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /^Paste/ })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /^Select All/ })).toBeInTheDocument();
  });
});
