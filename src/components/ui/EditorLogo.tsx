import { useEffect, useState, type ReactElement } from "react";
import { Code, Folder, Sparkles, Terminal } from "lucide-react";
import {
  getEditorMeta,
  type EditorFallbackGlyph,
  type EditorId,
  type EditorMeta,
} from "../../lib/editors";

const FALLBACK_GLYPHS: Record<EditorFallbackGlyph, typeof Code> = {
  code: Code,
  terminal: Terminal,
  sparkles: Sparkles,
  folder: Folder,
};

/** Bundled editor brand mark, with a neutral glyph when a mark fails to load. */
export function EditorLogo({
  editor,
  size = 16,
  className,
}: {
  editor: EditorId | EditorMeta;
  size?: number;
  className?: string;
}): ReactElement {
  const meta = typeof editor === "string" ? getEditorMeta(editor) : editor;
  const [errored, setErrored] = useState(false);

  useEffect(() => setErrored(false), [meta.logoUrl]);

  if (!meta.logoUrl || errored) {
    const Glyph = FALLBACK_GLYPHS[meta.fallbackGlyph];
    return (
      <Glyph
        aria-hidden
        data-editor-fallback={meta.id}
        size={size}
        className={`${className ?? ""} shrink-0 text-text-tertiary`}
      />
    );
  }

  return (
    <img
      src={meta.logoUrl}
      alt=""
      aria-hidden
      width={size}
      height={size}
      data-editor-logo={meta.id}
      onError={() => setErrored(true)}
      className={`${className ?? ""} shrink-0 object-contain`}
    />
  );
}
