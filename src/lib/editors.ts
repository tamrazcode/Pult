import vscodeLogo from "../assets/editors/vscode.svg";
import zedLogo from "../assets/editors/zed.svg";
import antigravityLogo from "../assets/editors/antigravity.svg";
import explorerLogo from "../assets/editors/explorer.svg";

export type EditorId = "zed" | "vscode" | "antigravity" | "explorer";

export type EditorFallbackGlyph = "code" | "terminal" | "sparkles" | "folder";

export interface EditorMeta {
  id: EditorId;
  label: string;
  logoUrl: string | null;
  accent: string;
  fallbackGlyph: EditorFallbackGlyph;
}

/** Bundled marks in chooser order; no runtime network fetching. */
export const EDITORS: readonly EditorMeta[] = [
  { id: "vscode", label: "VS Code", logoUrl: vscodeLogo, accent: "#1f9cf0", fallbackGlyph: "code" },
  { id: "zed", label: "Zed", logoUrl: zedLogo, accent: "#5b9bf8", fallbackGlyph: "terminal" },
  {
    id: "antigravity",
    label: "Antigravity",
    logoUrl: antigravityLogo,
    accent: "#4285f4",
    fallbackGlyph: "sparkles",
  },
  {
    id: "explorer",
    label: "File Explorer",
    logoUrl: explorerLogo,
    accent: "#c09553",
    fallbackGlyph: "folder",
  },
];

export function isEditorId(value: unknown): value is EditorId {
  return EDITORS.some((editor) => editor.id === value);
}

/** Unknown stored ids fall back to Zed, the same default the setting uses. */
export function getEditorMeta(id: string | null | undefined): EditorMeta {
  return EDITORS.find((editor) => editor.id === id) ?? EDITORS[1];
}
