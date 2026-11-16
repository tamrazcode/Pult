import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useT } from "../../lib/i18n";

/** Full-window image preview; Escape or a backdrop click closes it. */
export function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt?: string;
  onClose: () => void;
}) {
  const t = useT();
  const closeRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      // Escape/backdrop closed the dialog: give the keyboard back to the
      // thumbnail that opened it.
      if (restoreRef.current?.isConnected) restoreRef.current.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
        return;
      }
      // Only Close is focusable here; Tab must not reach the UI behind.
      if (event.key === "Tab") {
        event.preventDefault();
        closeRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("chat.imagePreview")}
      data-image-preview
      data-escape-layer
      className="fixed inset-0 z-[100] grid place-items-center bg-black/85 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        ref={closeRef}
        type="button"
        aria-label={t("chat.imagePreviewClose")}
        onClick={onClose}
        className="absolute top-4 right-4 flex h-9 w-9 items-center justify-center rounded-full bg-black/60 text-white transition hover:bg-black/80"
      >
        <X size={18} />
      </button>
      <img
        src={src}
        alt={alt ?? ""}
        onClick={(event) => event.stopPropagation()}
        className="max-h-[90vh] max-w-[92vw] rounded-(--radius-md) object-contain shadow-2xl"
      />
    </div>
  );
}
