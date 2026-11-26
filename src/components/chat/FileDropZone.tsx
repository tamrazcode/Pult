import { useEffect, useRef, useState } from "react";
import type { DragEvent, ReactNode } from "react";
import { FileUp } from "lucide-react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { emitAttachmentDrop } from "../../lib/attachmentDrop";
import { isTauri } from "../../lib/tauri";
import { useT } from "../../lib/i18n";

function hasFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

/**
 * Drop target for the chat surface: shows a dashed ghost while files hover.
 * In Tauri the native drag-drop event drives it (WebView2 swallows HTML file
 * drops); in the browser the HTML5 events do, and the files go to the
 * composer through the bridge.
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
  const native = isTauri();

  useEffect(() => {
    if (!native) return;
    let unlisten: (() => void) | undefined;
    try {
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setActive(true);
          } else if (event.payload.type === "leave" || event.payload.type === "drop") {
            setActive(false);
          }
        })
        .then((fn) => {
          unlisten = fn;
        })
        .catch(() => undefined);
    } catch {
      // jsdom/dev without the Tauri IPC bridge
    }
    return () => unlisten?.();
  }, [native]);

  const stop = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };
  const htmlProps = native
    ? {}
    : {
        onDragEnter: (event: DragEvent<HTMLDivElement>) => {
          if (!hasFiles(event)) return;
          stop(event);
          depth.current += 1;
          setActive(true);
        },
        onDragOver: (event: DragEvent<HTMLDivElement>) => {
          if (!hasFiles(event)) return;
          stop(event);
          event.dataTransfer.dropEffect = "copy";
        },
        onDragLeave: (event: DragEvent<HTMLDivElement>) => {
          if (!hasFiles(event)) return;
          stop(event);
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setActive(false);
        },
        onDrop: (event: DragEvent<HTMLDivElement>) => {
          stop(event);
          depth.current = 0;
          setActive(false);
          emitAttachmentDrop(event.dataTransfer.files);
        },
      };

  return (
    <div data-file-drop-zone className={className} {...htmlProps}>
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
