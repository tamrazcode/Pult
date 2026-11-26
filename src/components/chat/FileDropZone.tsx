import { useRef, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import { FileUp } from "lucide-react";
import { emitAttachmentDrop } from "../../lib/attachmentDrop";
import { useT } from "../../lib/i18n";

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

/**
 * Drop target for the chat surface: shows a dashed ghost while files hover
 * and hands the files to the mounted composer on drop.
 */
export function FileDropZone({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const t = useT();
  const [active, setActive] = useState(false);
  // dragenter/leave fire per child; a depth counter keeps the ghost stable.
  const depth = useRef(0);
  const stop = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <div
      data-file-drop-zone
      className={className}
      onDragEnter={(event) => {
        if (!hasFiles(event)) return;
        stop(event);
        depth.current += 1;
        setActive(true);
      }}
      onDragOver={(event) => {
        if (!hasFiles(event)) return;
        stop(event);
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!hasFiles(event)) return;
        stop(event);
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setActive(false);
      }}
      onDrop={(event) => {
        stop(event);
        depth.current = 0;
        setActive(false);
        emitAttachmentDrop(event.dataTransfer.files);
      }}
    >
      {children}
      {active && (
        <div
          role="status"
          className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-canvas/70 p-4 backdrop-blur-[2px]"
        >
          <div className="flex w-full max-w-xl flex-col items-center gap-2 rounded-(--radius-lg) border-2 border-dashed border-accent bg-surface/85 px-6 py-10 text-center shadow-(--shadow-composer)">
            <FileUp size={28} className="text-accent" aria-hidden />
            <p className="text-sm font-medium text-text-primary">{t("composer.dropFiles")}</p>
            <p className="text-xs text-text-tertiary">{t("composer.dropFilesHint")}</p>
          </div>
        </div>
      )}
    </div>
  );
}
