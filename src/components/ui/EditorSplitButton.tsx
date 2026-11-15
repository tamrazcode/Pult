import { useEffect, useRef, useState, type ReactElement } from "react";
import { Check, ChevronDown } from "lucide-react";
import { EDITORS, getEditorMeta, type EditorId } from "../../lib/editors";
import { useSettingsStore } from "../../stores/settings";
import { EditorLogo } from "./EditorLogo";

/**
 * Editor choice shared by the Files toolbar and the project card.
 * `compact` is the small toolbar split button; `card` fills a card row.
 */
export function EditorSplitButton({
  onOpen,
  variant = "compact",
  className = "",
}: {
  onOpen: (editor: EditorId) => void;
  variant?: "compact" | "card";
  className?: string;
}): ReactElement {
  const preferred = useSettingsStore((s) => s.preferredEditor);
  const setPreferred = useSettingsStore((s) => s.setPreferredEditor);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const active = getEditorMeta(preferred);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (editor: EditorId) => {
    setPreferred(editor);
    onOpen(editor);
    setOpen(false);
  };

  const compact = variant === "compact";

  return (
    <div
      ref={containerRef}
      className={`relative flex shrink-0 ${className}`}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        title={`Open in ${active.label}`}
        aria-label={`Open in ${active.label}`}
        onClick={() => onOpen(preferred)}
        className={
          compact
            ? "flex h-7 items-center gap-1 rounded-l-(--radius-sm) border border-border-subtle px-2 text-xs text-text-secondary transition hover:bg-hover"
            : "flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-xs text-text-secondary transition hover:bg-hover"
        }
      >
        <EditorLogo editor={active} className={compact ? "h-3.5 w-3.5" : "h-3 w-3"} />
        <span className="truncate">{compact ? active.label : `Open in ${active.label}`}</span>
      </button>
      <button
        type="button"
        aria-label="Choose editor"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Choose editor"
        onClick={() => setOpen((value) => !value)}
        className={
          compact
            ? "flex h-7 w-6 items-center justify-center rounded-r-(--radius-sm) border border-l-0 border-border-subtle text-text-tertiary transition hover:bg-hover"
            : "flex w-8 shrink-0 items-center justify-center border-l border-border-subtle text-text-tertiary transition hover:bg-hover"
        }
      >
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Editor"
          className={`absolute top-full z-40 mt-1 w-44 rounded-(--radius-md) border border-border-strong bg-surface-raised py-1 shadow-(--shadow-composer) ${
            compact ? "right-0" : "left-0"
          }`}
        >
          {EDITORS.map((editor) => (
            <button
              key={editor.id}
              type="button"
              role="menuitem"
              onClick={() => pick(editor.id)}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-hover ${
                preferred === editor.id ? "text-text-primary" : "text-text-secondary"
              }`}
            >
              <EditorLogo editor={editor} />
              <span className="flex-1 truncate">{editor.label}</span>
              {preferred === editor.id && <Check size={12} className="shrink-0 text-accent" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
