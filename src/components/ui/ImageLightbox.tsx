import { useEffect } from "react";
import { X } from "lucide-react";

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
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      data-image-preview
      className="fixed inset-0 z-[100] grid place-items-center bg-black/85 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        type="button"
        aria-label="Close image preview"
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
