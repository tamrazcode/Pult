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
import { createHighlighter, createJavaScriptRegexEngine } from "shiki";
import type { Highlighter } from "shiki";
import { Check, Copy } from "lucide-react";
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
  "java",
] as const;

const REMARK_PLUGINS = [remarkGfm, remarkMath];
const REHYPE_PLUGINS = [rehypeKatex];
// Re-parse markdown at most this often while a message streams.
const STREAM_PARSE_MS = 120;
// Highlight at most once per this interval while the code grows during streaming.
const STREAM_DEBOUNCE_MS = 150;
const COPY_FEEDBACK_MS = 1500;

const HIGHLIGHT_LANGS: ReadonlySet<string> = new Set(SHIKI_LANGS);

// One highlighter for the whole app, created lazily on first code block.
// Languages load on demand; the 19-language bundle is no longer preloaded.
// The JS regex engine avoids the WASM pipeline (shiki/wasm is not bundled here).
let highlighterPromise: Promise<Highlighter> | undefined;
const languageLoads = new Map<string, Promise<void>>();

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({
    themes: [SHIKI_THEME],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighterPromise;
}

/** Loads one grammar once and caches the promise for later blocks. */
function ensureLanguage(highlighter: Highlighter, lang: string): Promise<void> {
  let load = languageLoads.get(lang);
  if (!load) {
    load = highlighter
      .loadLanguage(lang as Parameters<Highlighter["loadLanguage"]>[0])
      .then(() => undefined);
    languageLoads.set(lang, load);
  }
  return load;
}

/** True while a fenced block has no closing fence yet. */
function hasOpenFence(text: string): boolean {
  const fences = text.match(/^```/gm);
  return ((fences?.length ?? 0) & 1) === 1;
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
    <button type="button" className="md-code-copy" onClick={handleCopy} aria-label="Copy code">
      {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
    </button>
  );
}

export const CodeBlock = memo(function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const lastHighlightAt = useRef(0);
  const plainOnly = useContext(PlainCodeContext);
  const label = (lang ?? "").toLowerCase();
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

  if (html === null || plainOnly) {
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

const COMPONENTS: Components = {
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
        >
          {rendered}
        </ReactMarkdown>
      </PlainCodeContext.Provider>
    </div>
  );
}

const MarkdownMemo = memo(Markdown);
export default MarkdownMemo;
