import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Clipboard, Download, Upload, X } from "lucide-react";
import { localizeIpcError, useT } from "../../lib/i18n";
import { mcpExportJson, mcpImportJson } from "../../lib/ipc";
import type { McpImportOutcome } from "../../lib/types";

interface Props {
  open: boolean;
  serverIds: string[];
  onClose: () => void;
  onImported: () => void;
}

/** Claude/Cursor `mcpServers` JSON import and secret-safe export. */
export function McpImportExportModal({ open, serverIds, onClose, onImported }: Props) {
  const t = useT();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<McpImportOutcome[] | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setText("");
    setError(null);
    setOutcomes(null);
    setCopied(false);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const runImport = async () => {
    setBusy(true);
    setError(null);
    setOutcomes(null);
    try {
      const result = await mcpImportJson(text);
      setOutcomes(result);
      if (result.some((outcome) => outcome.status === "imported")) onImported();
    } catch (err) {
      setError(localizeIpcError(err));
    } finally {
      setBusy(false);
    }
  };

  const runExport = async () => {
    setBusy(true);
    setError(null);
    try {
      setText(await mcpExportJson(serverIds));
    } catch (err) {
      setError(localizeIpcError(err));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (err) {
      setError(String(err));
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-md">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t("settings.mcp.importExportTitle")}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-(--radius-lg) border border-border-subtle bg-canvas shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <h2 className="text-sm font-medium text-text-primary">
            {t("settings.mcp.importExportTitle")}
          </h2>
          <button
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-primary"
          >
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
          <p className="text-xs text-text-tertiary">{t("settings.mcp.importExportHint")}</p>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={14}
            spellCheck={false}
            placeholder={
              '{\n  "mcpServers": {\n    "filesystem": { "command": "npx", "args": ["-y", "..."] }\n  }\n}'
            }
            className="w-full rounded-(--radius-sm) border border-border-subtle bg-surface px-2 py-1 font-mono text-xs text-text-primary focus:outline-none"
          />
          {error && <p className="text-xs text-danger">{error}</p>}
          {outcomes && (
            <div className="space-y-1 rounded-(--radius-sm) border border-border-subtle p-2">
              {outcomes.map((outcome) => (
                <p key={outcome.name} className="text-xs">
                  <span className={outcome.status === "imported" ? "text-success" : "text-warning"}>
                    {outcome.status}
                  </span>{" "}
                  <span className="text-text-secondary">{outcome.name}</span>
                  {outcome.error ? (
                    <span className="text-text-tertiary"> — {outcome.error}</span>
                  ) : null}
                </p>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border-subtle px-4 py-3">
          <button
            onClick={() => void copy()}
            disabled={!text}
            className="flex h-8 items-center gap-1 rounded-(--radius-sm) border border-border-subtle px-2 text-xs text-text-secondary transition hover:bg-hover disabled:opacity-50"
          >
            <Clipboard size={12} /> {copied ? t("settings.mcp.copied") : t("settings.mcp.copy")}
          </button>
          <span className="flex-1" />
          <button
            onClick={() => void runExport()}
            disabled={busy}
            className="flex h-8 items-center gap-1 rounded-(--radius-sm) border border-border-subtle px-2 text-xs text-text-secondary transition hover:bg-hover disabled:opacity-50"
          >
            <Download size={12} /> {t("settings.mcp.export")}
          </button>
          <button
            onClick={() => void runImport()}
            disabled={busy || !text.trim()}
            className="flex h-8 items-center gap-1 rounded-(--radius-sm) bg-accent px-3 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
          >
            <Upload size={12} /> {t("settings.mcp.import")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
