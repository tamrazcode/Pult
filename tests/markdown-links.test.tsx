import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { Markdown } from "../src/components/chat/Markdown";

const { openExternalUrl } = vi.hoisted(() => ({
  openExternalUrl: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("../src/lib/ipc", () => ({
  readImageDataUrl: vi.fn(),
  openExternalUrl,
}));

describe("Markdown links", () => {
  afterEach(() => {
    openExternalUrl.mockReset();
  });

  it("opens http(s) links externally instead of navigating the webview", () => {
    const { getByRole } = render(<Markdown text={"[site](https://example.com/a)"} />);
    const link = getByRole("link", { name: "site" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(fireEvent.click(link)).toBe(false);
    expect(openExternalUrl).toHaveBeenCalledWith("https://example.com/a");
  });
});
