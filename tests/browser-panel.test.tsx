import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";

const { openExternalUrl, workspaceReadHtml, browserCheckFrameHeaders, browserValidateTarget } =
  vi.hoisted(() => ({
    openExternalUrl: vi.fn(async () => undefined),
    workspaceReadHtml: vi.fn(async () => "<html><body><h1>Local Preview</h1></body></html>"),
    browserCheckFrameHeaders: vi.fn(async () => ({
      embeddable: true as boolean,
      reason: undefined as string | undefined,
    })),
    browserValidateTarget: vi.fn(async (target: string) => ({ kind: "url", target })),
  }));

vi.mock("../src/lib/tauri", () => ({
  isTauri: () => true,
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    openExternalUrl,
    workspaceReadHtml,
    browserCheckFrameHeaders,
    browserValidateTarget,
  };
});

import { BrowserPanel } from "../src/components/browser/BrowserPanel";

function navigateTo(target: string) {
  const input = screen.getByLabelText("Browser URL") as HTMLInputElement;
  fireEvent.change(input, { target: { value: target } });
  fireEvent.submit(input.closest("form")!);
}

describe("BrowserPanel", () => {
  beforeEach(() => {
    openExternalUrl.mockReset().mockResolvedValue(undefined);
    workspaceReadHtml
      .mockReset()
      .mockResolvedValue("<html><body><h1>Local Preview</h1></body></html>");
    browserCheckFrameHeaders.mockReset().mockResolvedValue({ embeddable: true, reason: undefined });
    browserValidateTarget.mockReset().mockImplementation(async (target: string) => ({
      kind: "url",
      target,
    }));
  });

  it("renders a sandboxed iframe for http(s) URL targets", async () => {
    render(<BrowserPanel threadId="th" />);

    navigateTo("http://localhost:5173");

    const iframe = await screen.findByTitle("Browser preview");
    expect(iframe.tagName).toBe("IFRAME");
    expect(iframe).toHaveAttribute("src", "http://localhost:5173");
    expect(iframe).toHaveAttribute("sandbox");
  });

  it("loads local workspace HTML via workspaceReadHtml into a srcDoc iframe", async () => {
    render(<BrowserPanel threadId="th" />);

    navigateTo("dist/preview.html");

    await waitFor(() => {
      expect(workspaceReadHtml).toHaveBeenCalledWith("th", "dist/preview.html");
    });
    const iframe = await screen.findByTitle("Browser preview");
    expect(iframe).toHaveAttribute("sandbox");
    expect(iframe.getAttribute("srcdoc")).toContain("Local Preview");
  });

  it("supports Back, Forward, and Reload history controls", async () => {
    render(<BrowserPanel threadId="th" />);

    navigateTo("http://localhost:5173/one");
    await screen.findByTitle("Browser preview");

    navigateTo("http://localhost:5173/two");
    await waitFor(() => {
      expect(screen.getByTitle("Browser preview")).toHaveAttribute(
        "src",
        "http://localhost:5173/two",
      );
    });

    const back = screen.getByRole("button", { name: "Back" });
    const forward = screen.getByRole("button", { name: "Forward" });
    const reload = screen.getByRole("button", { name: "Reload" });

    expect(back).not.toBeDisabled();
    expect(forward).toBeDisabled();

    fireEvent.click(back);
    await waitFor(() => {
      expect(screen.getByTitle("Browser preview")).toHaveAttribute(
        "src",
        "http://localhost:5173/one",
      );
    });
    expect(forward).not.toBeDisabled();

    fireEvent.click(forward);
    await waitFor(() => {
      expect(screen.getByTitle("Browser preview")).toHaveAttribute(
        "src",
        "http://localhost:5173/two",
      );
    });

    const beforeReload = screen.getByTitle("Browser preview");
    fireEvent.click(reload);
    await waitFor(() => {
      expect(screen.getByTitle("Browser preview")).toHaveAttribute(
        "src",
        "http://localhost:5173/two",
      );
    });
    expect(beforeReload).toBeDefined();
  });

  it("shows Open in system browser fallback when embed is blocked", async () => {
    browserCheckFrameHeaders.mockResolvedValueOnce({
      embeddable: false,
      reason: "Blocked by X-Frame-Options: DENY",
    });

    render(<BrowserPanel threadId="th" />);
    navigateTo("https://github.com/org/repo");

    const fallbackBtn = await screen.findByRole("button", { name: /Open in system browser/i });
    expect(screen.queryByTitle("Browser preview")).toBeNull();
    expect(screen.getByText(/X-Frame-Options/i)).toBeInTheDocument();

    fireEvent.click(fallbackBtn);
    expect(openExternalUrl).toHaveBeenCalledWith("https://github.com/org/repo");
  });

  it("shows an inline alert and renders no iframe for javascript: URLs", async () => {
    render(<BrowserPanel threadId="th" />);

    navigateTo("javascript:alert(1)");

    const alert = await screen.findByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(screen.queryByTitle("Browser preview")).toBeNull();
  });
});
