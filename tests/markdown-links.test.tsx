import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEvent, fireEvent, render, waitFor } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";

const { openExternalUrl, openInEditor, readImageDataUrl } = vi.hoisted(() => ({
  openExternalUrl: vi.fn(async () => undefined),
  openInEditor: vi.fn(async () => undefined),
  readImageDataUrl: vi.fn(),
}));

vi.mock("../src/lib/tauri", () => ({ isTauri: () => true }));
vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    readImageDataUrl,
    openExternalUrl,
    openInEditor,
  };
});

import { Markdown } from "../src/components/chat/Markdown";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

describe("Markdown links", () => {
  beforeEach(() => {
    openExternalUrl.mockReset().mockResolvedValue(undefined);
    openInEditor.mockReset().mockResolvedValue(undefined);
    useUiStore.setState({
      filePreview: null,
      rightPanelOpen: false,
      rightPanelTab: "diff",
      globalError: null,
    });
    useThreadsStore.setState({
      threads: [
        {
          id: "t1",
          projectId: "p1",
          title: "Links",
          workspace: "C:\\work\\alpha",
          status: "draft",
          pinned: false,
          createdAt: 100,
          updatedAt: 100,
        },
      ],
      activeThreadId: "t1",
      unreadIds: [],
      loaded: true,
    });
  });

  afterEach(() => {
    openExternalUrl.mockReset();
    openInEditor.mockReset();
  });

  it("opens https URLs with query and fragment externally and prevents default", () => {
    const url = "https://example.com/a?x=1&y=2#section";
    const { getByRole } = render(<Markdown text={`[site](${url})`} />);
    const link = getByRole("link", { name: "site" });
    expect(link).not.toHaveAttribute("target", "_blank");
    const event = createEvent.click(link);
    fireEvent(link, event);
    expect(event.defaultPrevented).toBe(true);
    expect(openExternalUrl).toHaveBeenCalledWith(url);
  });

  it("opens workspace file links in filePreview", () => {
    const { getByRole } = render(<Markdown text={"[mod](src/lib/ipc.ts)"} />);
    const link = getByRole("link", { name: "mod" });
    const event = createEvent.click(link);
    fireEvent(link, event);
    expect(event.defaultPrevented).toBe(true);
    expect(useUiStore.getState().filePreview).toBe("src/lib/ipc.ts");
    expect(useUiStore.getState().rightPanelTab).toBe("files");
    expect(useUiStore.getState().rightPanelOpen).toBe(true);
  });

  it("does nothing for unsupported javascript: links", () => {
    const { container } = render(<Markdown text={"[bad](javascript:alert(1))"} />);
    const anchor = container.querySelector("a");
    if (anchor) {
      fireEvent.click(anchor);
    }
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(openInEditor).not.toHaveBeenCalled();
    expect(useUiStore.getState().filePreview).toBeNull();
  });

  it("surfaces a global error when openExternalUrl rejects", async () => {
    openExternalUrl.mockRejectedValueOnce(new Error("browser launch failed"));
    const { getByRole } = render(<Markdown text={"[site](https://example.com/docs)"} />);
    fireEvent.click(getByRole("link", { name: "site" }));
    await waitFor(() => {
      expect(useUiStore.getState().globalError?.message).toContain("browser launch failed");
    });
  });
});
