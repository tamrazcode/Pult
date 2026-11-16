import {
  Children,
  createContext,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { HighlighterCore } from "shiki/core";
import { Check, Copy } from "lucide-react";
import { ipcErrorMessage, openExternalUrl, openInEditor, readImageDataUrl } from "../../lib/ipc";
import { activeWorkspaceRoot } from "../../lib/activeWorkspace";
import { useT } from "../../lib/i18n";
import { classifyMarkdownHref } from "../../lib/links";
import { isTauri } from "../../lib/tauri";
import { useUiStore } from "../../stores/ui";
import { useThreadsStore } from "../../stores/threads";
import "katex/dist/katex.min.css";
import "./markdown.css";

const SHIKI_THEME = "github-dark-default";
// Language *labels* accepted inline; grammars load on demand.
const SHIKI_LANGS = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "json",
  "rust",
  "python",
  "bash",
  "md",
  "css",
  "html",
  "yaml",
  "toml",
  "sql",
  "diff",
  "go",
  "c",
  "cpp",
  "csharp",
  "java",
] as const;

const LANGUAGE_ALIASES: Record<string, string> = {
  typescript: "ts",
  javascript: "js",
  py: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  markdown: "md",
  "c++": "cpp",
  "c#": "csharp",
  golang: "go",
  jsonc: "json",
};

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeKatex];

/**
 * Grammars stay lazy: the root `shiki` import bundles every language (~10 MB),
 * so only these explicit loaders ship with the app.
 */
const SHIKI_LANG_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  ts: () => import("shiki/langs/ts.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  js: () => import("shiki/langs/js.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  md: () => import("shiki/langs/md.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
};
// Re-parse markdown at most this often while a message streams.
const STREAM_PARSE_MS = 120;
// Highlight at most once per this interval while the code grows during streaming.
const STREAM_DEBOUNCE_MS = 150;
const COPY_FEEDBACK_MS = 1500;

const HIGHLIGHT_LANGS: ReadonlySet<string> = new Set(SHIKI_LANGS);

// One highlighter for the whole app, created lazily on first code block.
// Languages load on demand; the 19-language bundle is no longer preloaded.
// The JS regex engine avoids the WASM pipeline (shiki/wasm is not bundled here).
let highlighterPromise: Promise<HighlighterCore> | undefined;
const languageLoads = new Map<string, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [import("shiki/themes/github-dark-default.mjs")],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }).catch((err) => {
    // A transient load failure must not poison highlighting for the session.
    highlighterPromise = undefined;
    throw err;
  });
  return highlighterPromise;
}

/** Loads one grammar once and caches the promise for later blocks. */
function ensureLanguage(highlighter: HighlighterCore, lang: string): Promise<void> {
  const loader = SHIKI_LANG_LOADERS[lang];
  if (!loader) return Promise.resolve();
  let load = languageLoads.get(lang);
  if (!load) {
    load = loader()
      .then((module) =>
        highlighter.loadLanguage(module.default as Parameters<HighlighterCore["loadLanguage"]>[0]),
      )
      .then(() => undefined)
      .catch((err) => {
        languageLoads.delete(lang);
        throw err;
      });
    languageLoads.set(lang, load);
  }
  return load;
}

/** True while the text ends inside a fenced block (``` or ~~~, 0-3 spaces). */
function hasOpenFence(text: string): boolean {
  let open: string | null = null;
  for (const line of text.split("\n")) {
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (!match) continue;
    const fence = match[1];
    if (!open) open = fence;
    else if (fence[0] === open[0] && fence.length >= open.length) open = null;
  }
  return open !== null;
}

const PlainCodeContext = createContext(false);

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string") return node;
  if (typeof node === "number") return node.toString();
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  return "";
}

// react-markdown renders fenced blocks as <pre><code class="language-xxx">…</code></pre>;
// pull the language and the raw text out of that child.
function extractCode(children: ReactNode): { code: string; lang?: string } {
  const first = Children.toArray(children)[0];
  if (isValidElement<{ className?: string; children?: ReactNode }>(first)) {
    const match = /(?:^|\s)language-([\w#+-]+)/.exec(first.props.className ?? "");
    return {
      code: nodeText(first.props.children).replace(/\n$/, ""),
      lang: match ? match[1].toLowerCase() : undefined,
    };
  }
  return { code: nodeText(children).replace(/\n$/, "") };
}

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => window.clearTimeout(resetTimer.current);
  }, []);

  const handleCopy = () => {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.clearTimeout(resetTimer.current);
        resetTimer.current = window.setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
      })
      .catch(() => {
        // Clipboard unavailable (permissions, non-secure context): stay quiet.
      });
  };

  return (
    <button
      type="button"
      className="md-code-copy"
      onClick={handleCopy}
      aria-label={t("chat.copyCode")}
    >
      {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
    </button>
  );
}

export const CodeBlock = memo(function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const lastHighlightAt = useRef(0);
  const plainOnly = useContext(PlainCodeContext);
  const label = LANGUAGE_ALIASES[(lang ?? "").toLowerCase()] ?? (lang ?? "").toLowerCase();
  const canHighlight = label !== "" && HIGHLIGHT_LANGS.has(label);

  // While a fence is still open (or text is settling) keep the plain fallback:
  // Shiki only runs for completed blocks, then at most once per 150ms.
  useEffect(() => {
    if (!canHighlight || plainOnly) return;
    let cancelled = false;
    const delay = Math.max(0, STREAM_DEBOUNCE_MS - (Date.now() - lastHighlightAt.current));
    const timer = window.setTimeout(() => {
      getHighlighter()
        .then(async (highlighter) => {
          if (cancelled) return;
          await ensureLanguage(highlighter, label);
          if (cancelled) return;
          try {
            setHtml(highlighter.codeToHtml(code, { lang: label, theme: SHIKI_THEME }));
            lastHighlightAt.current = Date.now();
          } catch {
            setHtml(null);
          }
        })
        .catch(() => {
          // Highlighting is best-effort: keep the plain-text fallback.
          if (!cancelled) setHtml(null);
        });
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [code, canHighlight, label, plainOnly]);

  const header = (
    <div className="md-code-header">
      <span className="md-code-lang">{label === "" ? "text" : label}</span>
      <CopyButton text={code} />
    </div>
  );

  // Keep an already-highlighted block intact when a later fence opens: only
  // blocks with no HTML yet stay on the plain fallback.
  if (html === null) {
    return (
      <div className="md-code">
        {header}
        <div className="md-code-area">
          <pre className="md-code-fallback">
            <code>{code}</code>
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className="md-code">
      {header}
      {/* Shiki output is trusted: it is generated locally from the code text. */}
      <div className="md-code-area" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
});

/** Local paths from agents (`C:\...`, UNC, file://) need the backend bridge. */
function fileUrlToPath(src: string): string {
  if (!src.startsWith("file://")) return src;
  try {
    const url = new URL(src);
    let path = decodeURIComponent(url.pathname);
    if (url.host && url.host !== "localhost") path = `//${url.host}${path}`;
    if (/^\/[a-zA-Z]:/.test(path)) path = path.slice(1);
    return path;
  } catch {
    return src;
  }
}

/** Markdown eats Windows backslashes (`C:\Users` -> `C:Users`) and may
    percent-encode a path; restore the drive form before reading the file. */
function normalizeImageSource(src: string): string {
  let path = src;
  try {
    path = decodeURI(path);
  } catch {
    // Keep the original when the value is not valid percent-encoding.
  }
  return path.replace(/^([A-Za-z]):(?![/\\])/, "$1:\\");
}

function LocalImage({ src, alt }: { src?: string; alt?: string }) {
  const t = useT();
  const source = typeof src === "string" ? normalizeImageSource(src) : undefined;
  const local = typeof source === "string" && /^(?:[a-zA-Z]:[\\/]|\\\\|file:\/\/)/.test(source);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!local || !source) return;
    setDataUrl(null);
    setFailed(false);
    let cancelled = false;
    readImageDataUrl(fileUrlToPath(source), useThreadsStore.getState().activeThreadId ?? "")
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [local, source]);

  if (!local) {
    return (
      <button
        type="button"
        aria-label={t("chat.openImage")}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          useUiStore.getState().openImagePreview(src ?? "", alt);
        }}
        className="my-2 block cursor-zoom-in"
      >
        <img
          src={src}
          alt={alt ?? ""}
          loading="lazy"
          className="max-h-80 rounded-(--radius-md) border border-border-subtle"
        />
      </button>
    );
  }
  if (failed) {
    return (
      <span title={source} className="text-sm text-text-tertiary">
        {t("chat.imageUnavailable", { name: alt || source })}
      </span>
    );
  }
  if (!dataUrl) {
    return <span className="text-sm text-text-tertiary">{t("common.loading")}</span>;
  }
  return (
    <button
      type="button"
      aria-label={t("chat.openImage")}
      title={alt || src}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        useUiStore.getState().openImagePreview(dataUrl, alt);
      }}
      className="my-2 block cursor-zoom-in"
    >
      <img
        src={dataUrl}
        alt={alt ?? ""}
        className="max-h-80 rounded-(--radius-md) border border-border-subtle"
      />
    </button>
  );
}

const COMPONENTS: Components = {
  a: ({ href, children, node, ...props }) => {
    void node;
    const desktop = isTauri();
    const link = classifyMarkdownHref(href, activeWorkspaceRoot());
    const openWorkspace = () => {
      if (link.kind !== "workspace") return;
      if (link.isDir) {
        void openInEditor(link.fullPath, "explorer").catch((err) =>
          useUiStore.getState().setGlobalError({ kind: "protocol", message: ipcErrorMessage(err) }),
        );
      } else if (/\.html?$/i.test(link.relativePath)) {
        useUiStore.getState().openInBrowserPanel(link.relativePath);
      } else {
        useUiStore.getState().openFilePreview(link.relativePath);
      }
    };
    const openExternal = () => {
      if (link.kind !== "external") return;
      void openExternalUrl(link.url).catch((err) =>
        useUiStore.getState().setGlobalError({ kind: "protocol", message: ipcErrorMessage(err) }),
      );
    };
    return (
      <a
        {...props}
        href={href}
        data-link-href={href}
        target={desktop ? undefined : "_blank"}
        rel="noreferrer noopener"
        onClick={(event) => {
          if (!href) return;
          if (link.kind === "external") {
            if (!desktop) return;
            event.preventDefault();
            openExternal();
            return;
          }
          if (link.kind === "workspace") {
            event.preventDefault();
            openWorkspace();
            return;
          }
          if (link.kind === "unsupported") {
            event.preventDefault();
          }
        }}
        onAuxClick={(event) => {
          if (!desktop) return;
          if (link.kind === "unsupported") {
            event.preventDefault();
            return;
          }
          if (event.button !== 1) return;
          if (link.kind === "external") {
            event.preventDefault();
            openExternal();
          } else if (link.kind === "workspace") {
            event.preventDefault();
            openWorkspace();
          }
        }}
      >
        {children}
      </a>
    );
  },
  img: ({ src, alt }) => <LocalImage src={src} alt={alt} />,
  pre: ({ children }) => {
    const { code, lang } = extractCode(children);
    return <CodeBlock code={code} lang={lang} />;
  },
};

export function Markdown({
  text,
  className,
  streaming = false,
}: {
  text: string;
  className?: string;
  streaming?: boolean;
}) {
  const [rendered, setRendered] = useState(text);
  const lastParseAt = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  // Leading + trailing throttle: long streams repaint markdown ~8x/second
  // instead of on every token; a finished message flushes immediately.
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!streaming) {
      lastParseAt.current = Date.now();
      setRendered(text);
      return;
    }
    const wait = STREAM_PARSE_MS - (Date.now() - lastParseAt.current);
    if (wait <= 0) {
      lastParseAt.current = Date.now();
      setRendered(text);
      return;
    }
    timer.current = window.setTimeout(() => {
      lastParseAt.current = Date.now();
      setRendered(text);
    }, wait);
    return () => window.clearTimeout(timer.current);
  }, [text, streaming]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <div className={className === undefined ? "md" : `md ${className}`}>
      <PlainCodeContext.Provider value={streaming && hasOpenFence(rendered)}>
        <ReactMarkdown
          remarkPlugins={REMARK_PLUGINS}
          rehypePlugins={REHYPE_PLUGINS}
          components={COMPONENTS}
          urlTransform={(url) =>
            /^(javascript|data|vbscript):/i.test(url.replace(/\s+/g, "")) ? "" : url
          }
        >
          {rendered}
        </ReactMarkdown>
      </PlainCodeContext.Provider>
    </div>
  );
}

const MarkdownMemo = memo(Markdown);
export default MarkdownMemo;
