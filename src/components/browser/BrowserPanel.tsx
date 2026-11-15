import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from "lucide-react";
import {
  browserCheckFrameHeaders,
  browserValidateTarget,
  ipcErrorMessage,
  openExternalUrl,
  workspaceReadHtml,
} from "../../lib/ipc";

interface BrowserEntry {
  input: string;
  kind: "url" | "file";
  target: string;
}

/** T3-style preview surface: URL bar plus a sandboxed iframe. */
export function BrowserPanel({ threadId }: { threadId: string | null }) {
  const [history, setHistory] = useState<BrowserEntry[]>([]);
  const [index, setIndex] = useState(-1);
  const [input, setInput] = useState("");
  const [html, setHtml] = useState<string | null>(null);
  const [embed, setEmbed] = useState<{ embeddable: boolean; reason?: string | null } | null>(null);
  const [checking, setChecking] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const current = index >= 0 ? history[index] : null;

  const navigate = async (raw: string) => {
    setError(null);
    setEmbed(null);
    setHtml(null);
    try {
      if (/^(javascript|data|vbscript|file):/i.test(raw)) {
        throw new Error("Only http(s) URLs or workspace HTML files can be previewed.");
      }
      const validated = await browserValidateTarget(raw);
      const isUrl = /^https?:\/\//i.test(raw);
      if (!isUrl && !/\.html?$/i.test(validated.target)) {
        throw new Error("Enter an http(s) URL or a workspace .html file.");
      }
      const entry: BrowserEntry = {
        input: raw,
        kind: isUrl ? "url" : "file",
        target: validated.target,
      };
      setHistory((prev) => [...prev.slice(0, index + 1), entry]);
      setIndex((prev) => prev + 1);
      setInput(raw);
    } catch (err) {
      setError(ipcErrorMessage(err));
    }
  };

  useEffect(() => {
    const entry = history[index];
    if (!entry) return;
    let cancelled = false;
    setChecking(true);
    if (entry.kind === "file") {
      if (!threadId) {
        setError("Open a thread to preview workspace HTML.");
        setChecking(false);
        return;
      }
      workspaceReadHtml(threadId, entry.target)
        .then((source) => {
          if (cancelled) return;
          setHtml(source);
          setEmbed({ embeddable: true });
        })
        .catch((err) => {
          if (!cancelled) setError(ipcErrorMessage(err));
        })
        .finally(() => {
          if (!cancelled) setChecking(false);
        });
    } else {
      browserCheckFrameHeaders(entry.target)
        .then((check) => {
          if (!cancelled) setEmbed(check);
        })
        .catch(() => {
          if (!cancelled) setEmbed({ embeddable: true });
        })
        .finally(() => {
          if (!cancelled) setChecking(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [history, index, threadId, reloadKey]);

  const openExternal = () => {
    if (!current) return;
    const url = /^https?:\/\//i.test(current.target) ? current.target : current.target;
    void openExternalUrl(url).catch((err) => setError(ipcErrorMessage(err)));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex items-center gap-1 border-b border-border-subtle px-2 py-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (input.trim()) void navigate(input.trim());
        }}
      >
        <button
          type="button"
          aria-label="Back"
          title="Back"
          disabled={index <= 0}
          onClick={() => setIndex((value) => Math.max(0, value - 1))}
          className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover disabled:opacity-40"
        >
          <ArrowLeft size={13} />
        </button>
        <button
          type="button"
          aria-label="Forward"
          title="Forward"
          disabled={index >= history.length - 1}
          onClick={() => setIndex((value) => Math.min(history.length - 1, value + 1))}
          className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover disabled:opacity-40"
        >
          <ArrowRight size={13} />
        </button>
        <button
          type="button"
          aria-label="Reload"
          title="Reload"
          disabled={!current}
          onClick={() => setReloadKey((value) => value + 1)}
          className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover disabled:opacity-40"
        >
          <RotateCw size={13} />
        </button>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="http://localhost:5173 or path/page.html"
          aria-label="Browser URL"
          className="h-7 min-w-0 flex-1 rounded-(--radius-sm) border border-border-subtle bg-surface px-2 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-strong focus:outline-none"
        />
        <button
          type="button"
          aria-label="Open externally"
          title="Open in system browser"
          disabled={!current}
          onClick={openExternal}
          className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover disabled:opacity-40"
        >
          <ExternalLink size={13} />
        </button>
      </form>

      <div className="min-h-0 flex-1 overflow-auto">
        {error && (
          <p
            role="alert"
            className="m-3 rounded-(--radius-md) border border-danger/40 px-3 py-2 text-xs text-danger"
          >
            {error}
          </p>
        )}
        {!current && !error && (
          <div className="grid h-full place-items-center p-6">
            <p className="max-w-xs text-center text-xs text-text-tertiary">
              Open a local dev server or a workspace HTML file. Sites that block framing open in
              your system browser.
            </p>
          </div>
        )}
        {current && checking && !html && (
          <p className="p-3 text-xs text-text-tertiary">Checking preview…</p>
        )}
        {current && embed && !embed.embeddable && (
          <div className="m-3 rounded-(--radius-md) border border-border-strong bg-surface p-3">
            <p className="text-sm text-text-primary">This site blocks embedding</p>
            <p className="mt-1 text-xs text-text-tertiary">
              {embed.reason ?? "X-Frame-Options or CSP refused the iframe."}
            </p>
            <button
              type="button"
              onClick={openExternal}
              className="mt-2 flex h-7 items-center rounded-(--radius-sm) bg-accent px-2 text-xs text-accent-fg"
            >
              Open in system browser
            </button>
          </div>
        )}
        {current && embed?.embeddable && html !== null && (
          <iframe
            key={`${index}-${reloadKey}`}
            title="Browser preview"
            sandbox="allow-scripts"
            srcDoc={html}
            className="h-full w-full border-0 bg-white"
          />
        )}
        {current && embed?.embeddable && html === null && (
          <iframe
            key={`${index}-${reloadKey}`}
            title="Browser preview"
            sandbox="allow-scripts allow-forms allow-same-origin"
            src={current.target}
            className="h-full w-full border-0 bg-white"
          />
        )}
      </div>
    </div>
  );
}
