import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";

const {
  openInEditor,
  workspaceTree,
  workspaceReadText,
  readImageDataUrl,
  settingsGet,
  settingsSet,
} = vi.hoisted(() => ({
  openInEditor: vi.fn(async () => undefined),
  workspaceTree: vi.fn(async () => ({
    entries: [
      { path: "src", name: "src", isDir: true, size: 0 },
      { path: "src/app.ts", name: "app.ts", isDir: false, size: 10 },
    ],
    truncated: false,
  })),
  workspaceReadText: vi.fn(async () => "const x = 1;"),
  readImageDataUrl: vi.fn(async () => ""),
  settingsGet: vi.fn(async () => null),
  settingsSet: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/tauri", () => ({ isTauri: () => true }));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    openInEditor,
    workspaceTree,
    workspaceReadText,
    readImageDataUrl,
    settingsGet,
    settingsSet,
  };
});

import { FilesPanel } from "../src/components/files/FilesPanel";
import { EditorLogo } from "../src/components/ui/EditorLogo";
import { EditorSplitButton } from "../src/components/ui/EditorSplitButton";
import { EDITORS, getEditorMeta, isEditorId } from "../src/lib/editors";
import { useProjectsStore } from "../src/stores/projects";
import { useSettingsStore } from "../src/stores/settings";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

const ASSET_DIR = path.resolve(process.cwd(), "src/assets/editors");
const FILES = ["vscode.svg", "zed.svg", "antigravity.svg", "explorer.svg"];

describe("editor brand assets and metadata", () => {
  it("defines metadata and bundled local SVG assets for all four editors", () => {
    expect(EDITORS.map((editor) => editor.id)).toEqual([
      "vscode",
      "zed",
      "antigravity",
      "explorer",
    ]);
    expect(EDITORS.map((editor) => editor.label)).toEqual([
      "VS Code",
      "Zed",
      "Antigravity",
      "File Explorer",
    ]);
    for (const editor of EDITORS) {
      expect(editor.logoUrl).toBeTruthy();
      expect(editor.logoUrl).not.toMatch(/^https?:\/\//);
      expect(editor.accent).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(getEditorMeta("unknown").id).toBe("zed");
    expect(isEditorId("vscode")).toBe(true);
    expect(isEditorId("unknown")).toBe(false);
  });

  it("verifies bundled SVG files and LICENSES.md exist under src/assets/editors/", () => {
    for (const file of FILES) {
      const svg = readFileSync(path.join(ASSET_DIR, file), "utf8");
      expect(svg).toContain("<svg");
      expect(svg).toContain("</svg>");
      expect(svg).not.toContain("<script");
      expect(svg).not.toMatch(/<image[^>]+https?:/);
    }
    const licenses = readFileSync(path.join(ASSET_DIR, "LICENSES.md"), "utf8");
    for (const file of FILES) expect(licenses).toContain(file);
  });

  it("renders bundled img logo for each editor and falls back to a neutral glyph", () => {
    for (const editor of EDITORS) {
      const { unmount } = render(<EditorLogo editor={editor.id} />);
      const img = document.querySelector(`img[data-editor-logo="${editor.id}"]`);
      expect(img).toBeTruthy();
      expect(img?.getAttribute("src")).toBeTruthy();
      unmount();
    }

    const { unmount } = render(
      <EditorLogo
        editor={{
          id: "vscode",
          label: "VS Code",
          logoUrl: null,
          accent: "#1f9cf0",
          fallbackGlyph: "code",
        }}
      />,
    );
    expect(document.querySelector('img[data-editor-logo="vscode"]')).toBeNull();
    expect(document.querySelector('[data-editor-fallback="vscode"]')).toBeTruthy();
    unmount();

    render(<EditorLogo editor="zed" />);
    const img = document.querySelector('img[data-editor-logo="zed"]');
    expect(img).toBeTruthy();
    fireEvent.error(img!);
    expect(document.querySelector('[data-editor-fallback="zed"]')).toBeTruthy();
  });
});

describe("FilesPanel editor chooser", () => {
  beforeEach(() => {
    openInEditor.mockClear();
    settingsSet.mockClear();
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
          id: "th",
          projectId: "p1",
          title: "UI parity",
          workspace: "C:\\work\\alpha",
          status: "working",
          pinned: false,
          createdAt: 100,
          updatedAt: 200,
        },
      ],
      activeThreadId: "th",
      unreadIds: [],
      loaded: true,
    });
    useUiStore.setState({ filePreview: "src/app.ts" });
    useSettingsStore.setState({ preferredEditor: "zed" });
  });

  it("lists every editor with its logo and persists the chosen one", async () => {
    render(<FilesPanel threadId="th" />);
    await waitFor(() => expect(workspaceReadText).toHaveBeenCalled());

    for (const [id, label] of [
      ["vscode", "VS Code"],
      ["zed", "Zed"],
      ["antigravity", "Antigravity"],
      ["explorer", "File Explorer"],
    ] as const) {
      fireEvent.click(screen.getByRole("button", { name: "Choose editor" }));
      const menu = screen.getByRole("menu", { name: "Editor" });
      const item = within(menu).getByRole("menuitem", { name: label });
      expect(item.querySelector(`img[data-editor-logo="${id}"]`)).toBeTruthy();
      fireEvent.click(item);
      expect(openInEditor).toHaveBeenCalledWith("C:\\work\\alpha\\src\\app.ts", id);
      expect(useSettingsStore.getState().preferredEditor).toBe(id);
      expect(settingsSet).toHaveBeenCalledWith("preferred_editor", id);
    }
  });

  it("closes the chooser on Escape and outside click", () => {
    render(<FilesPanel threadId="th" />);

    fireEvent.click(screen.getByRole("button", { name: "Choose editor" }));
    expect(screen.getByRole("menu", { name: "Editor" })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Editor" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Choose editor" }));
    expect(screen.getByRole("menu", { name: "Editor" })).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu", { name: "Editor" })).toBeNull();
  });

  it("dismisses a sibling editor menu when another split button is pressed", () => {
    render(
      <>
        <EditorSplitButton onOpen={() => {}} />
        <EditorSplitButton onOpen={() => {}} />
      </>,
    );

    const triggers = screen.getAllByRole("button", { name: "Choose editor" });
    fireEvent.click(triggers[0]);
    expect(screen.getAllByRole("menu", { name: "Editor" })).toHaveLength(1);

    fireEvent.mouseDown(triggers[1]);
    expect(screen.queryAllByRole("menu", { name: "Editor" })).toHaveLength(0);
  });
});
