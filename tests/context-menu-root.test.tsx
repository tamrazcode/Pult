import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";

const { navigate, openExternalUrl, openInEditor } = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
  openExternalUrl: vi.fn(async () => undefined),
  openInEditor: vi.fn(async () => undefined),
}));

vi.mock("@tanstack/react-router", () => ({
  createRootRoute: (options: unknown) => ({ options }),
  Outlet: () => (
    <div>
      <textarea aria-label="Editor" defaultValue="hello world" />
      <a href="https://example.com/docs?q=1#top" data-link-href="https://example.com/docs?q=1#top">
        External docs
      </a>
      <a href="src/App.tsx" data-link-href="src/App.tsx">
        App source
      </a>
      <a href="outputs/sandbox.html" data-link-href="outputs/sandbox.html">
        Sandbox preview
      </a>
    </div>
  ),
  useRouter: () => ({ navigate }),
}));

vi.mock("../src/lib/tauri", () => ({
  isTauri: () => false,
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    openExternalUrl,
    openInEditor,
    providersWarmup: vi.fn(async () => undefined),
    runsRespondElicitation: vi.fn(async () => undefined),
  };
});

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
import { useSettingsStore } from "../src/stores/settings";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

const RootLayout = Route.options.component!;

describe("RootLayout context menu", () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    navigate.mockReset().mockResolvedValue(undefined);
    openExternalUrl.mockReset().mockResolvedValue(undefined);
    openInEditor.mockReset().mockResolvedValue(undefined);
    writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText, readText: vi.fn(async () => "") },
      configurable: true,
    });

    useUiStore.setState({
      sidebarOpen: false,
      rightPanelOpen: false,
      rightPanelTab: "diff",
      browserTarget: null,
      paletteOpen: false,
      pendingThreadId: null,
      selectedInstanceId: null,
    });
    useRunsStore.setState({
      activeElicitation: null,
    });
    useSettingsStore.setState({ preferredEditor: "zed" });
    useThreadsStore.setState({
      threads: [
        {
          id: "th",
          projectId: "p1",
          title: "Context links",
          workspace: "C:\\work\\alpha",
          status: "draft",
          pinned: false,
          createdAt: 100,
          updatedAt: 100,
        },
      ],
      activeThreadId: "th",
      unreadIds: [],
      loaded: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("offers Open in browser and Copy link using raw href on external link right-click", () => {
    render(<RootLayout />);

    const link = screen.getByRole("link", { name: "External docs" });
    fireEvent.contextMenu(link, { clientX: 50, clientY: 70 });

    const menu = screen.getByRole("menu", { name: "Context menu" });
    const openItem = within(menu).getByRole("menuitem", { name: "Open in browser" });
    const copyItem = within(menu).getByRole("menuitem", { name: "Copy link" });

    fireEvent.click(openItem);
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/docs?q=1#top");

    fireEvent.contextMenu(link, { clientX: 50, clientY: 70 });
    fireEvent.click(
      within(screen.getByRole("menu", { name: "Context menu" })).getByRole("menuitem", {
        name: "Copy link",
      }),
    );
    expect(writeText).toHaveBeenCalledWith("https://example.com/docs?q=1#top");
    expect(copyItem).toBeDefined();
  });

  it("offers Reveal in File Explorer, Open in editor, and Copy path on workspace file link right-click", () => {
    render(<RootLayout />);

    const link = screen.getByRole("link", { name: "App source" });
    fireEvent.contextMenu(link, { clientX: 50, clientY: 70 });

    const menu = screen.getByRole("menu", { name: "Context menu" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Reveal in File Explorer" }));
    expect(openInEditor).toHaveBeenCalledWith("C:\\work\\alpha\\src\\App.tsx", "explorer");

    fireEvent.contextMenu(link, { clientX: 50, clientY: 70 });
    fireEvent.click(
      within(screen.getByRole("menu", { name: "Context menu" })).getByRole("menuitem", {
        name: "Open in editor",
      }),
    );
    expect(openInEditor).toHaveBeenCalledWith("C:\\work\\alpha\\src\\App.tsx", "zed");

    fireEvent.contextMenu(link, { clientX: 50, clientY: 70 });
    fireEvent.click(
      within(screen.getByRole("menu", { name: "Context menu" })).getByRole("menuitem", {
        name: "Copy path",
      }),
    );
    expect(writeText).toHaveBeenCalledWith("C:\\work\\alpha\\src\\App.tsx");
  });

  it("offers Open in browser on workspace .html link right-click and calls openInBrowserPanel", () => {
    const openInBrowserPanelSpy = vi.spyOn(useUiStore.getState(), "openInBrowserPanel");
    render(<RootLayout />);

    const link = screen.getByRole("link", { name: "Sandbox preview" });
    fireEvent.contextMenu(link, { clientX: 50, clientY: 70 });

    const menu = screen.getByRole("menu", { name: "Context menu" });
    const openItem = within(menu).getByRole("menuitem", { name: "Open in browser" });
    fireEvent.click(openItem);

    expect(openInBrowserPanelSpy).toHaveBeenCalledWith("outputs/sandbox.html");
    expect(useUiStore.getState().browserTarget).toBe("outputs/sandbox.html");
    expect(useUiStore.getState().rightPanelTab).toBe("browser");
    expect(useUiStore.getState().rightPanelOpen).toBe(true);
  });

  it("still offers link actions when right-clicking selected text inside a link", () => {
    vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "External",
    } as Selection);

    render(<RootLayout />);

    const link = screen.getByRole("link", { name: "External docs" });
    fireEvent.contextMenu(link, { clientX: 50, clientY: 70 });

    const menu = screen.getByRole("menu", { name: "Context menu" });
    expect(within(menu).getByRole("menuitem", { name: "Open in browser" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Copy link" })).toBeInTheDocument();
  });
});
