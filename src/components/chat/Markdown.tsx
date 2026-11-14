import { Children, isValidElement, memo, useEffect, useRef, useState } from "react";
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
// Highlight at most once per this interval while the code grows during streaming.
const STREAM_DEBOUNCE_MS = 150;
const COPY_FEEDBACK_MS = 1500;

const HIGHLIGHT_LANGS: ReadonlySet<string> = new Set(SHIKI_LANGS);

// One highlighter for the whole app, created lazily on first code block.
// The JS regex engine avoids the WASM pipeline (shiki/wasm is not bundled here).
let highlighterPromise: Promise<Highlighter> | undefined;
function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({
    themes: [SHIKI_THEME],
    langs: [...SHIKI_LANGS],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  });
  return highlighterPromise;
}

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
  const label = (lang ?? "").toLowerCase();
  const canHighlight = label !== "" && HIGHLIGHT_LANGS.has(label);

  // During streaming the effect re-runs on every delta; the timer only fires
  // once 150ms have passed since the last successful highlight, so tokens
  // batching up never trigger more than one Shiki run per interval. The last
  // content always gets a timer that survives, so it ends highlighted.
  useEffect(() => {
    if (!canHighlight) return;
    let cancelled = false;
    const delay = Math.max(0, STREAM_DEBOUNCE_MS - (Date.now() - lastHighlightAt.current));
    const timer = window.setTimeout(() => {
      getHighlighter()
        .then((highlighter) => {
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
  }, [code, canHighlight, label]);

  const header = (
    <div className="md-code-header">
      <span className="md-code-lang">{label === "" ? "text" : label}</span>
      <CopyButton text={code} />
    </div>
  );

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

const COMPONENTS: Components = {
  pre: ({ children }) => {
    const { code, lang } = extractCode(children);
    return <CodeBlock code={code} lang={lang} />;
  },
};

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className === undefined ? "md" : `md ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

const MarkdownMemo = memo(Markdown);
export default MarkdownMemo;
