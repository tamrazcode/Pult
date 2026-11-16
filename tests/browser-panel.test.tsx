import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";

const {
  browserNavigate,
  browserSetBounds,
  browserHistory,
  browserState,
  onBrowserNavigated,
  openExternalUrl,
} = vi.hoisted(() => ({
  browserNavigate: vi.fn(async (target: string, _threadId: string | null) => target),
  browserSetBounds: vi.fn(
    async (_bounds: { x: number; y: number; width: number; height: number; visible: boolean }) =>
      undefined,
  ),
  browserHistory: vi.fn(async (_action: string) => undefined),
  browserState: vi.fn(async (): Promise<string | null> => null),
  onBrowserNavigated: vi.fn(
    async (_listener: (event: { url: string; event: string }) => void) => () => {},
  ),
  openExternalUrl: vi.fn(async (_url: string) => undefined),
}));

vi.mock("../src/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("../src/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof IpcModule>()),
  browserNavigate,
  browserSetBounds,
  browserHistory,
  browserState,
  onBrowserNavigated,
  openExternalUrl,
}));

import { BrowserPanel } from "../src/components/browser/BrowserPanel";
import { useLocaleStore } from "../src/lib/i18n";
import { useRunsStore } from "../src/stores/runs";
import { useUiStore } from "../src/stores/ui";

function navigateTo(target: string) {
  const input = screen.getByLabelText("Browser URL");
  fireEvent.change(input, { target: { value: target } });
  fireEvent.submit(input.closest("form")!);
}

async function expectVisibility(visible: boolean) {
  await waitFor(() =>
    expect(browserSetBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible })),
  );
}

describe("BrowserPanel native webview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browserNavigate.mockImplementation(async (target) => target);
    browserState.mockResolvedValue(null);
    onBrowserNavigated.mockImplementation(async () => () => {});
    useLocaleStore.getState().setLocale("en");
    useUiStore.setState({
      browserTarget: null,
      rightPanelOpen: true,
      rightPanelTab: "browser",
      paletteOpen: false,
      imagePreview: null,
    });
    useRunsStore.setState({ activeElicitation: null });
  });

  afterEach(() => {
    act(() => useLocaleStore.getState().setLocale("en"));
  });

  it.each([
    "http://localhost:5173",
    "https://github.com/org/repo",
    "C:\\project\\page.html",
    "/tmp/project/page.html",
  ])("navigates to %s without an iframe or srcDoc", async (target) => {
    const { container } = render(<BrowserPanel threadId="th" />);
    navigateTo(target);
    await waitFor(() => expect(browserNavigate).toHaveBeenCalledWith(target, "th"));
    await expectVisibility(true);
    expect(screen.getByLabelText("Browser URL")).toHaveValue(target);
    expect(container.querySelector("iframe, [srcdoc]")).toBeNull();
  });

  it.each(["https://localhost/queued", "C:\\project\\queued.html"])(
    "consumes queued target %s once with its thread",
    async (target) => {
      useUiStore.setState({ browserTarget: target });
      render(<BrowserPanel threadId="th" />);
      await waitFor(() => expect(browserNavigate).toHaveBeenCalledExactlyOnceWith(target, "th"));
      expect(useUiStore.getState().browserTarget).toBeNull();
      expect(screen.getByLabelText("Browser URL")).toHaveValue(target);
    },
  );

  it("sends Back, Forward and Reload to native history", () => {
    render(<BrowserPanel threadId="th" />);
    for (const action of ["Back", "Forward", "Reload"]) {
      fireEvent.click(screen.getByRole("button", { name: action }));
      expect(browserHistory).toHaveBeenLastCalledWith(action.toLowerCase());
    }
    expect(browserHistory).toHaveBeenCalledTimes(3);
  });

  it("hides bounds until a page opens, rounds host geometry and hides on unmount", async () => {
    const { container, unmount } = render(<BrowserPanel threadId="th" />);
    await expectVisibility(false);
    const host = container.querySelector(".absolute.inset-0")!;
    vi.spyOn(host, "getBoundingClientRect").mockReturnValue({
      left: 10.4,
      top: 20.6,
      width: 300.2,
      height: 200.8,
    } as DOMRect);
    navigateTo("https://example.com");
    await waitFor(() =>
      expect(browserSetBounds).toHaveBeenLastCalledWith({
        x: 10,
        y: 21,
        width: 300,
        height: 201,
        visible: true,
      }),
    );
    unmount();
    await expectVisibility(false);
  });

  it.each(["palette", "image", "elicitation", "panel closed", "other tab"])(
    "hides an open page under %s and restores it afterward",
    async (overlay) => {
      browserState.mockResolvedValue("https://example.com");
      render(<BrowserPanel threadId="th" />);
      await expectVisibility(true);
      act(() => {
        if (overlay === "palette") useUiStore.setState({ paletteOpen: true });
        if (overlay === "image")
          useUiStore.setState({
            imagePreview: { src: "data:image/png;base64,AA", alt: "Preview" },
          });
        if (overlay === "elicitation")
          useRunsStore.setState({
            activeElicitation: { requestId: "req" } as NonNullable<
              ReturnType<typeof useRunsStore.getState>["activeElicitation"]
            >,
          });
        if (overlay === "panel closed") useUiStore.setState({ rightPanelOpen: false });
        if (overlay === "other tab") useUiStore.setState({ rightPanelTab: "diff" });
      });
      await expectVisibility(false);
      act(() => {
        useUiStore.setState({
          paletteOpen: false,
          imagePreview: null,
          rightPanelOpen: true,
          rightPanelTab: "browser",
        });
        useRunsStore.setState({ activeElicitation: null });
      });
      await expectVisibility(true);
    },
  );

  it("restores state and updates addresses only on finished non-loopback navigation", async () => {
    browserState.mockResolvedValue("https://example.com/restored");
    render(<BrowserPanel threadId="th" />);
    await waitFor(() =>
      expect(screen.getByLabelText("Browser URL")).toHaveValue("https://example.com/restored"),
    );
    const listener = onBrowserNavigated.mock.calls[0][0];
    act(() => listener({ url: "https://example.com/loading", event: "started" }));
    expect(screen.getByLabelText("Browser URL")).toHaveValue("https://example.com/restored");
    act(() => listener({ url: "http://127.0.0.1:1234/token/page.html", event: "finished" }));
    expect(screen.getByLabelText("Browser URL")).toHaveValue("https://example.com/restored");
    act(() => listener({ url: "https://example.com/done", event: "finished" }));
    expect(screen.getByLabelText("Browser URL")).toHaveValue("https://example.com/done");
  });

  it("opens the current URL externally", async () => {
    browserState.mockResolvedValue("https://example.com");
    render(<BrowserPanel threadId="th" />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Open externally" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Open externally" }));
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com");
  });

  it("shows native validation failures inline without creating an iframe", async () => {
    browserNavigate.mockRejectedValueOnce(new Error("Unsupported browser URL scheme"));
    const { container } = render(<BrowserPanel threadId="th" />);
    navigateTo("javascript:alert(1)");
    expect(await screen.findByRole("alert")).toHaveTextContent("Unsupported browser URL scheme");
    expect(browserNavigate).toHaveBeenCalledWith("javascript:alert(1)", "th");
    expect(container.querySelector("iframe, [srcdoc]")).toBeNull();
    await expectVisibility(false);
  });

  it("hides bounds when a DOM dialog is appended to document.body and restores them on removal", async () => {
    render(<BrowserPanel threadId="th" />);
    navigateTo("https://example.com");
    await expectVisibility(true);

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    try {
      await expectVisibility(false);
      dialog.remove();
      await expectVisibility(true);
    } finally {
      dialog.remove();
    }
  });

  it("calls the unlisten function returned by onBrowserNavigated on unmount", async () => {
    const unlisten = vi.fn();
    onBrowserNavigated.mockResolvedValueOnce(unlisten);
    const { unmount } = render(<BrowserPanel threadId="th" />);
    await waitFor(() => expect(onBrowserNavigated).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(unlisten).not.toHaveBeenCalled();
    unmount();
    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
  });

  it("shows localized IPC error messages in English and after switching locale to Russian", async () => {
    browserNavigate.mockRejectedValueOnce({ code: "browser.local_file", message: "x" });
    render(<BrowserPanel threadId="th" />);

    navigateTo("C:\\missing.html");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That local file could not be previewed.",
    );

    act(() => useLocaleStore.getState().setLocale("ru"));
    browserNavigate.mockRejectedValueOnce({ code: "browser.local_file", message: "x" });
    const ruInput = screen.getByLabelText("URL в браузере");
    fireEvent.change(ruInput, { target: { value: "C:\\missing.html" } });
    fireEvent.submit(ruInput.closest("form")!);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Не удалось открыть локальный файл.",
    );
  });
});
