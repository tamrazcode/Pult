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
import { classifyMarkdownHref } from "../src/lib/links";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

describe("classifyMarkdownHref", () => {
  const root = "C:\\work\\alpha";

  it("rejects mid-path traversal", () => {
    expect(classifyMarkdownHref("src/../../etc/passwd", root)).toEqual({
      kind: "unsupported",
      raw: "src/../../etc/passwd",
    });
    expect(classifyMarkdownHref("C:/work/alpha/../../win.ini", root)).toEqual({
      kind: "unsupported",
      raw: "C:/work/alpha/../../win.ini",
    });
  });

  it("rejects unknown schemes, POSIX absolute paths, and remote file:// hosts", () => {
    expect(classifyMarkdownHref("about:blank", root)).toEqual({
      kind: "unsupported",
      raw: "about:blank",
    });
    expect(classifyMarkdownHref("mailto:x@y", root)).toEqual({
      kind: "unsupported",
      raw: "mailto:x@y",
    });
    expect(classifyMarkdownHref("/etc/passwd", root)).toEqual({
      kind: "unsupported",
      raw: "/etc/passwd",
    });
    expect(classifyMarkdownHref("file://server/share/doc.md", root)).toEqual({
      kind: "unsupported",
      raw: "file://server/share/doc.md",
    });
  });

  it("accepts http(s), workspace-relative, and in-root absolute paths", () => {
    expect(classifyMarkdownHref("https://example.com/docs?q=1", root)).toEqual({
      kind: "external",
      url: "https://example.com/docs?q=1",
    });
    expect(classifyMarkdownHref("http://localhost:5173", root)).toEqual({
      kind: "external",
      url: "http://localhost:5173",
    });
    expect(classifyMarkdownHref("src/lib/ipc.ts", root)).toEqual({
      kind: "workspace",
      relativePath: "src/lib/ipc.ts",
      fullPath: "C:\\work\\alpha\\src\\lib\\ipc.ts",
      isDir: false,
    });
    expect(classifyMarkdownHref("C:/work/alpha/src/App.tsx", root)).toEqual({
      kind: "workspace",
      relativePath: "src/App.tsx",
      fullPath: "C:\\work\\alpha\\src\\App.tsx",
      isDir: false,
    });
  });
});

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

  it("calls preventDefault when clicking an unsupported href", () => {
    const { getByRole } = render(
      <Markdown text={"[mail](mailto:x@y) [escape](src/../../etc/passwd)"} />,
    );
    for (const name of ["mail", "escape"]) {
      const link = getByRole("link", { name });
      const event = createEvent.click(link);
      fireEvent(link, event);
      expect(event.defaultPrevented).toBe(true);
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
