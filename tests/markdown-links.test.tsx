import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { ImageLightbox } from "../src/components/ui/ImageLightbox";
import { activeWorkspaceRoot } from "../src/lib/activeWorkspace";
import { classifyMarkdownHref } from "../src/lib/links";
import { useProjectsStore } from "../src/stores/projects";
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

  it("classifies POSIX absolute workspace paths and joins with forward slashes", () => {
    expect(classifyMarkdownHref("/repo/outputs/x.html", "/repo")).toEqual({
      kind: "workspace",
      relativePath: "outputs/x.html",
      fullPath: "/repo/outputs/x.html",
      isDir: false,
    });
    expect(classifyMarkdownHref("/etc/passwd", "/repo")).toEqual({
      kind: "unsupported",
      raw: "/etc/passwd",
    });
    expect(classifyMarkdownHref("/repo-other/outputs/x.html", "/repo")).toEqual({
      kind: "unsupported",
      raw: "/repo-other/outputs/x.html",
    });
  });
});

describe("Markdown links", () => {
  beforeEach(() => {
    openExternalUrl.mockReset().mockResolvedValue(undefined);
    openInEditor.mockReset().mockResolvedValue(undefined);
    useUiStore.setState({
      filePreview: null,
      browserTarget: null,
      imagePreview: null,
      rightPanelOpen: false,
      rightPanelTab: "diff",
      globalError: null,
    });
    useProjectsStore.setState({
      projects: [],
      selectedProjectId: null,
      loaded: true,
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
    vi.restoreAllMocks();
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

  it("opens workspace HTML links in browserPanel instead of filePreview", () => {
    const openInBrowserPanelSpy = vi.spyOn(useUiStore.getState(), "openInBrowserPanel");
    const openFilePreviewSpy = vi.spyOn(useUiStore.getState(), "openFilePreview");

    const { getByRole } = render(<Markdown text={"[sandbox](outputs/sandbox.html)"} />);
    const link = getByRole("link", { name: "sandbox" });
    const event = createEvent.click(link);
    fireEvent(link, event);

    expect(event.defaultPrevented).toBe(true);
    expect(openInBrowserPanelSpy).toHaveBeenCalledWith("outputs/sandbox.html");
    expect(openFilePreviewSpy).not.toHaveBeenCalled();
    expect(useUiStore.getState().browserTarget).toBe("outputs/sandbox.html");
    expect(useUiStore.getState().rightPanelTab).toBe("browser");
    expect(useUiStore.getState().rightPanelOpen).toBe(true);
    expect(useUiStore.getState().filePreview).toBeNull();
  });

  it("preserves C:/ drive hrefs via urlTransform and opens the browser panel for workspace HTML files", () => {
    const absHref = "C:/Users/borch/Desktop/manimaDocs/outputs/sandbox.html";
    useThreadsStore.setState({
      threads: [
        {
          id: "t1",
          projectId: "p1",
          title: "Links",
          workspace: "C:\\Users\\borch\\Desktop\\manimaDocs",
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

    const openInBrowserPanelSpy = vi.spyOn(useUiStore.getState(), "openInBrowserPanel");
    const { getByRole } = render(<Markdown text={`[x](${absHref})`} />);
    const link = getByRole("link", { name: "x" });
    expect(link).toHaveAttribute("href", absHref);

    const event = createEvent.click(link);
    fireEvent(link, event);
    expect(event.defaultPrevented).toBe(true);
    expect(openInBrowserPanelSpy).toHaveBeenCalledWith("outputs/sandbox.html");
    expect(useUiStore.getState().browserTarget).toBe("outputs/sandbox.html");
    expect(useUiStore.getState().rightPanelTab).toBe("browser");
    expect(useUiStore.getState().rightPanelOpen).toBe(true);
  });

  it("classifies an absolute path inside project root as workspace when active thread has workspace:null", () => {
    useProjectsStore.setState({
      projects: [
        {
          id: "p1",
          name: "Alpha",
          rootPath: "C:\\work\\alpha",
          color: "#346bf1",
          worktreeStrategy: "root",
          pinned: false,
          createdAt: 100,
        },
      ],
      selectedProjectId: "p1",
      loaded: true,
    });
    useThreadsStore.setState({
      threads: [
        {
          id: "t1",
          projectId: "p1",
          title: "Fallback",
          workspace: null,
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

    const root = activeWorkspaceRoot();
    expect(root).toBe("C:\\work\\alpha");
    expect(classifyMarkdownHref("C:/work/alpha/outputs/sandbox.html", root)).toEqual({
      kind: "workspace",
      relativePath: "outputs/sandbox.html",
      fullPath: "C:\\work\\alpha\\outputs\\sandbox.html",
      isDir: false,
    });
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

  it("opens Markdown images in the image preview dialog instead of a new tab", () => {
    function MarkdownWithLightbox() {
      const imagePreview = useUiStore((s) => s.imagePreview);
      const closeImagePreview = useUiStore((s) => s.closeImagePreview);
      return (
        <>
          <Markdown text={"![Diagram](https://example.com/diagram.png)"} />
          {imagePreview && (
            <ImageLightbox
              src={imagePreview.src}
              alt={imagePreview.alt}
              onClose={closeImagePreview}
            />
          )}
        </>
      );
    }

    render(<MarkdownWithLightbox />);
    expect(screen.queryByRole("link")).toBeNull();

    const trigger = screen.getByRole("button", { name: "Open image" });
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Image preview" });
    expect(dialog.querySelector("img")).toHaveAttribute("src", "https://example.com/diagram.png");
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("loads a local Windows image even when the path was encoded", async () => {
    readImageDataUrl.mockReset().mockResolvedValue("data:image/png;base64,SHOT");

    render(
      <Markdown text={"![shot](C:%5CUsers%5Cborch%5Cpult-workspace%5Coutputs%5Cdesktop.png)"} />,
    );

    await waitFor(() =>
      expect(readImageDataUrl.mock.calls[0]?.[0]).toBe(
        "C:\\Users\\borch\\pult-workspace\\outputs\\desktop.png",
      ),
    );
    expect(await screen.findByRole("button", { name: "Open image" })).toBeTruthy();
  });

  it("loads a raw Windows image path from Markdown", async () => {
    readImageDataUrl.mockReset().mockResolvedValue("data:image/png;base64,SHOT");

    render(
      <Markdown
        text={"![shot](C:\\Users\\borch\\pult-workspace\\outputs\\screenshots\\desktop.png)"}
      />,
    );

    await waitFor(() =>
      expect(readImageDataUrl.mock.calls[0]?.[0]).toBe(
        "C:\\Users\\borch\\pult-workspace\\outputs\\screenshots\\desktop.png",
      ),
    );
    expect(await screen.findByRole("button", { name: "Open image" })).toBeTruthy();
  });

  it("opens a Markdown image nested inside a link in the image preview dialog without calling openExternalUrl", () => {
    function MarkdownWithLightbox() {
      const imagePreview = useUiStore((s) => s.imagePreview);
      const closeImagePreview = useUiStore((s) => s.closeImagePreview);
      return (
        <>
          <Markdown text={"[![alt](img.png)](https://example.com)"} />
          {imagePreview && (
            <ImageLightbox
              src={imagePreview.src}
              alt={imagePreview.alt}
              onClose={closeImagePreview}
            />
          )}
        </>
      );
    }

    render(<MarkdownWithLightbox />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "https://example.com");

    fireEvent.click(screen.getByAltText("alt"));

    const dialog = screen.getByRole("dialog", { name: "Image preview" });
    expect(dialog.querySelector("img")).toHaveAttribute("src", "img.png");
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("passes the active thread id as the second argument to readImageDataUrl for raw and %5C Windows paths", async () => {
    readImageDataUrl.mockReset().mockResolvedValue("data:image/png;base64,SHOT");
    useThreadsStore.setState({ activeThreadId: "thread-img" });

    render(
      <Markdown
        text={"![raw](C:\\work\\alpha\\raw.png)\n\n![enc](C:%5Cwork%5Calpha%5Cencoded.png)"}
      />,
    );

    await waitFor(() => {
      expect(readImageDataUrl).toHaveBeenCalledWith("C:\\work\\alpha\\raw.png", "thread-img");
      expect(readImageDataUrl).toHaveBeenCalledWith("C:\\work\\alpha\\encoded.png", "thread-img");
    });
  });
});
