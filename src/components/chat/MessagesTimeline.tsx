import { useEffect, useRef, useState } from "react";
import {
  ArrowRightLeft,
  Brain,
  Check,
  ChevronRight,
  Copy,
  Eye,
  Globe,
  Layers,
  MessageSquare,
  Pencil,
  Search,
  SquareTerminal,
  ToggleLeft,
  Trash2,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ipcErrorMessage, runsDispatch } from "../../lib/ipc";
import {
  activeRunForThread,
  threadTimelineItems,
  usageLine,
  useRunsStore,
} from "../../stores/runs";
import { useUiStore } from "../../stores/ui";
import type {
  ApprovalRequest,
  ChatItem,
  CompactionChatItem,
  ThoughtChatItem,
  ToolChatItem,
} from "../../stores/runs";
import type { PlanEntry } from "../../lib/types";
import { runsRespondPermission } from "../../lib/ipc";
import { Button } from "../ui/button";
import Markdown from "./Markdown";

const TOOL_ICONS: Record<string, LucideIcon> = {
  read: Eye,
  edit: Pencil,
  delete: Trash2,
  move: ArrowRightLeft,
  search: Search,
  execute: SquareTerminal,
  think: Brain,
  fetch: Globe,
  switch_mode: ToggleLeft,
  other: Wrench,
};

function toolIcon(kind: string): LucideIcon {
  return TOOL_ICONS[kind] ?? Wrench;
}

const TOOL_DOT_CLASSES: Record<string, string> = {
  pending: "bg-text-tertiary",
  in_progress: "bg-accent",
  completed: "bg-success",
  failed: "bg-danger",
};

function toolDot(status: string): string {
  return TOOL_DOT_CLASSES[status] ?? "bg-text-tertiary";
}

const STOP_REASON_LABELS: Record<string, string> = {
  end_turn: "Completed",
  cancelled: "Cancelled",
  refusal: "Refused",
  max_tokens: "Token limit",
  max_turn_requests: "Turn limit",
};

const NOTICE_LEVEL_CLASSES: Record<string, string> = {
  warning: "text-warning",
  error: "text-danger",
};

/** Tail-window size for long transcripts (§6.5 60 fps budget). */
const TRANSCRIPT_WINDOW = 300;

export function MessagesTimeline({ threadId }: { threadId?: string }) {
  const runs = useRunsStore((s) => (threadId ? s.runsByThread[threadId] : undefined));
  const views = useRunsStore((s) => s.viewsByRun);
  const activeRun = activeRunForThread(runs);
  const runId = activeRun?.id;
  const view = useRunsStore((s) => (runId ? s.viewsByRun[runId] : undefined));
  const entries = threadTimelineItems(runs, views);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Windowing (§6.5): a 10k-event thread must scroll at 60 fps — render the
  // tail window only, expandable in chunks ("Earlier messages").
  const [windowSize, setWindowSize] = useState(TRANSCRIPT_WINDOW);

  // Reset the window when switching threads, not when a new run starts: the
  // merged transcript of the same thread must keep its expanded window.
  useEffect(() => {
    setWindowSize(TRANSCRIPT_WINDOW);
  }, [threadId]);

  // Follow the stream: any new/patched view scrolls the sentinel into view.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [view]);

  if (!threadId || !view) return <EmptyState />;

  const hasContent =
    entries.length > 0 ||
    (view.plan?.length ?? 0) > 0 ||
    view.pendingApproval !== undefined ||
    view.error !== undefined;

  if (!hasContent && !view.streaming) return <EmptyState />;

  const crashed = view.error !== undefined || view.stopReason === "failed";
  // Recovery (§8 M7): a protocol/agent failure offers to re-send the turn.
  const retryText = [...view.items].reverse().find((item) => item.type === "user")?.text;
  const hiddenCount = Math.max(entries.length - windowSize, 0);
  const windowedEntries = entries.slice(hiddenCount);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-6">
        {hiddenCount > 0 && (
          <button
            onClick={() => setWindowSize((n) => n + TRANSCRIPT_WINDOW)}
            className="mx-auto rounded-(--radius-sm) border border-border-subtle px-3 py-1 text-xs text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
          >
            Earlier messages ({hiddenCount} hidden)
          </button>
        )}
        {windowedEntries.map(({ key, item, showCaret }) => (
          <ChatItemRow key={key} item={item} showCaret={showCaret} />
        ))}

        {entries.length === 0 && view.streaming && (
          <div className="flex items-center gap-2 py-1 text-sm text-text-tertiary">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            Working…
          </div>
        )}

        {view.plan && view.plan.length > 0 && <PlanCard entries={view.plan} />}

        {view.pendingApproval && runId && (
          <ApprovalCard runId={runId} approval={view.pendingApproval} />
        )}

        {crashed && (
          <CrashBanner
            detail={view.error ?? "The run failed without a reported reason"}
            retryText={retryText}
            onRetry={
              threadId && retryText ? () => void retryLastMessage(threadId, retryText) : undefined
            }
          />
        )}

        {!view.streaming && view.stopReason && (
          <FinishDivider stopReason={view.stopReason} usage={view.usage} />
        )}

        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function ChatItemRow({ item, showCaret }: { item: ChatItem; showCaret: boolean }) {
  switch (item.type) {
    case "user":
      return <UserRow text={item.text} images={item.images} />;
    case "assistant":
      return <TextRow text={item.text} streaming={item.streaming && showCaret} />;
    case "thought":
      return <ThoughtGroup item={item} streaming={item.streaming && showCaret} />;
    case "tool":
      return <ToolRow item={item} />;
    case "trace":
      return <TraceRow optionId={item.optionId} />;
    case "compaction":
      return <CompactionDivider item={item} />;
    case "notice":
      return <NoticeRow level={item.level} message={item.message} />;
  }
}

function EmptyState() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-(--radius-lg) border border-border-subtle bg-surface">
          <MessageSquare size={20} className="text-text-tertiary" />
        </div>
        <p className="text-lg text-text-secondary">Nothing here yet</p>
        <p className="max-w-[42ch] text-sm text-text-tertiary">
          Start a thread below. Agents stream their work here: thoughts, tool calls, diffs.
        </p>
      </div>
    </div>
  );
}

function Caret({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span aria-hidden className="text-accent">
      ▍
    </span>
  );
}

function UserRow({ text, images }: { text: string; images: { data: string; mimeType: string }[] }) {
  return (
    <div className="flex justify-end">
      <div className="flex max-w-[75%] flex-col items-end gap-2">
        {images.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2">
            {images.map((img, i) => (
              <img
                key={i}
                src={`data:${img.mimeType};base64,${img.data}`}
                alt="Attached"
                className="max-h-40 rounded-(--radius-md) border border-border-subtle"
              />
            ))}
          </div>
        )}
        {text && (
          <div className="rounded-(--radius-md) bg-mention-bg px-3.5 py-2 text-base whitespace-pre-wrap text-text-primary">
            {text}
          </div>
        )}
      </div>
    </div>
  );
}

function TextRow({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className="md text-base text-text-primary">
      <Markdown text={text} />
      {streaming && <Caret show />}
    </div>
  );
}

function formatDuration(startedAt: number, endedAt: number): string {
  const seconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function ThoughtGroup({ item, streaming }: { item: ThoughtChatItem; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const duration = formatDuration(item.startedAt, item.endedAt);
  return (
    <div className="rounded-(--radius-md) border border-border-subtle bg-surface">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        <Brain size={13} className="shrink-0 text-text-tertiary" />
        <span
          className={`text-sm ${streaming ? "text-text-tertiary italic" : "text-text-tertiary"}`}
        >
          {streaming ? "Thinking" : "Thought for " + duration}
        </span>
        {streaming && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />}
        <div className="flex-1" />
        <ChevronRight
          size={12}
          className={`shrink-0 text-text-tertiary transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="border-t border-border-subtle px-3 py-2 text-sm whitespace-pre-wrap text-text-tertiary italic">
          {item.text}
        </div>
      )}
    </div>
  );
}

/** Policy trace row: the mode auto-resolved a permission (never silent). */
function TraceRow({ optionId }: { optionId: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5 text-xs text-text-tertiary">
      <ShieldCheck size={11} className="shrink-0" />
      <span>Auto-allowed by permission mode ({optionId})</span>
    </div>
  );
}

const COMPACTION_LABELS: Record<string, string> = {
  in_progress: "Compacting context…",
  completed: "Context compacted",
  failed: "Compaction failed",
  cancelled: "Compaction cancelled",
};

function CompactionDivider({ item }: { item: CompactionChatItem }) {
  const label = COMPACTION_LABELS[item.status ?? "in_progress"] ?? "Context compacted";
  const failed = item.status === "failed" || item.status === "cancelled";
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="h-px flex-1 bg-border-subtle" />
      <span className="flex items-center gap-1.5 text-xs text-text-tertiary">
        <Layers size={11} className={failed ? "text-danger" : undefined} />
        {label}
        {item.summary && (
          <span title={item.summary} className="max-w-[32ch] truncate">
            {item.summary}
          </span>
        )}
      </span>
      <div className="h-px flex-1 bg-border-subtle" />
    </div>
  );
}

function NoticeRow({ level, message }: { level: string; message: string }) {
  return (
    <div className={`text-sm ${NOTICE_LEVEL_CLASSES[level] ?? "text-text-tertiary"}`}>
      {message}
    </div>
  );
}

function ToolRow({ item }: { item: ToolChatItem }) {
  const [open, setOpen] = useState(false);
  const Icon = toolIcon(item.kind);
  const detail = item.rawOutput ?? item.content;
  const hasDetail = item.rawInput !== undefined || detail !== undefined;
  return (
    <div className="rounded-(--radius-md) border border-border-subtle bg-surface">
      <button
        onClick={() => hasDetail && setOpen((o) => !o)}
        disabled={!hasDetail}
        aria-expanded={open}
        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${hasDetail ? "" : "cursor-default"}`}
      >
        <Icon size={13} className="shrink-0 text-text-secondary" />
        <span className="truncate text-sm text-text-secondary">{item.title}</span>
        {item.locations.length > 0 && (
          <span className="truncate font-mono text-xs text-text-tertiary">{item.locations[0]}</span>
        )}
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${toolDot(item.status)}`} />
        {hasDetail && (
          <ChevronRight
            size={12}
            className={`shrink-0 text-text-tertiary transition-transform ${open ? "rotate-90" : ""}`}
          />
        )}
      </button>
      {open && hasDetail && (
        <div className="space-y-2 border-t border-border-subtle px-3 py-2">
          {item.rawInput !== undefined && <PreBlock label="Input" value={item.rawInput} />}
          {detail !== undefined && <PreBlock label="Output" value={detail} />}
        </div>
      )}
    </div>
  );
}

function PreBlock({ label, value }: { label: string; value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <div>
      <div className="pb-1 text-xs font-semibold tracking-wider text-text-tertiary uppercase">
        {label}
      </div>
      <pre className="overflow-x-auto rounded-(--radius-sm) bg-code-bg p-2 font-mono text-xs whitespace-pre-wrap text-text-secondary">
        {text}
      </pre>
    </div>
  );
}

function PlanStatusIcon({ status }: { status: PlanEntry["status"] }) {
  if (status === "completed") return <Check size={13} className="mt-0.5 shrink-0 text-success" />;
  if (status === "in_progress")
    return <span className="mt-1.5 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />;
  return <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-text-tertiary" />;
}

function PlanCard({ entries }: { entries: PlanEntry[] }) {
  return (
    <div className="rounded-(--radius-md) border border-border-subtle bg-surface">
      <div className="border-b border-border-subtle px-3 py-1.5 text-xs font-semibold tracking-wider text-text-tertiary uppercase">
        Plan
      </div>
      <ul className="space-y-1.5 px-3 py-2">
        {entries.map((entry, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <PlanStatusIcon status={entry.status} />
            <span
              className={
                entry.status === "completed"
                  ? "text-text-tertiary line-through"
                  : "text-text-secondary"
              }
            >
              {entry.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Keyboard hint per option kind: A allow once, S always, D decline. */
function keyHint(kind: string): string | null {
  if (kind === "allow_once") return "A";
  if (kind === "allow_always") return "S";
  if (kind.startsWith("reject")) return "D";
  return null;
}

function ApprovalCard({ runId, approval }: { runId: string; approval: ApprovalRequest }) {
  const [sent, setSent] = useState(false);
  const respond = (optionId: string | null) => {
    if (sent) return;
    setSent(true);
    runsRespondPermission(runId, approval.requestId, optionId).catch((err) => {
      console.error("runs_respond_permission failed", err);
      setSent(false);
    });
  };
  return (
    <div className="overflow-hidden rounded-(--radius-md) border border-warning">
      <div className="bg-warning/10 px-3 py-1.5 text-xs font-semibold tracking-wider text-warning uppercase">
        Approval needed
      </div>
      <div className="space-y-2.5 px-3 py-2.5">
        <p className="text-sm text-text-primary">{approval.title}</p>
        <div className="flex flex-wrap gap-2">
          {approval.options.map((option) => (
            <Button
              key={option.optionId}
              size="sm"
              variant={
                option.kind.startsWith("allow")
                  ? "primary"
                  : option.kind.startsWith("reject")
                    ? "danger_outline"
                    : "secondary"
              }
              onClick={() => respond(option.optionId)}
              disabled={sent}
            >
              {option.name}
              <span className="ml-1 text-xs opacity-60">{keyHint(option.kind)}</span>
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => respond(null)} disabled={sent}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

function CrashBanner({
  detail,
  retryText,
  onRetry,
}: {
  detail: string;
  retryText?: string;
  onRetry?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyDiagnostics = () => {
    const text = `pult run failed\n${new Date().toISOString()}\n${detail}`;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  return (
    <div className="overflow-hidden rounded-(--radius-md) border border-danger">
      <div className="flex items-center gap-2 bg-danger/10 px-3 py-1.5 text-xs font-semibold tracking-wider text-danger uppercase">
        <TriangleAlert size={12} />
        Run crashed
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <pre className="overflow-x-auto rounded-(--radius-sm) bg-code-bg p-2 font-mono text-xs whitespace-pre-wrap text-text-secondary">
          {detail}
        </pre>
        <div className="flex flex-wrap items-center gap-2">
          {onRetry && retryText && (
            <Button size="sm" variant="secondary" onClick={onRetry}>
              <RotateCcw size={12} />
              Retry last message
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={copyDiagnostics}>
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? "Copied" : "Copy diagnostics"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Re-sends the failed turn's user text on the thread's selected instance. */
function retryLastMessage(threadId: string, text: string): void {
  const instanceId = useUiStore.getState().selectedInstanceId;
  if (!instanceId) return;
  runsDispatch(threadId, text, instanceId, []).catch((err) =>
    useUiStore.getState().setGlobalError({ kind: "protocol", message: ipcErrorMessage(err) }),
  );
}

function FinishDivider({ stopReason, usage }: { stopReason: string; usage?: unknown }) {
  const usageText = usageLine(usage as Parameters<typeof usageLine>[0]);
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="h-px flex-1 bg-border-subtle" />
      <span className="text-xs text-text-tertiary">
        {STOP_REASON_LABELS[stopReason] ?? stopReason}
        {usageText ? ` · ${usageText}` : ""}
      </span>
      <div className="h-px flex-1 bg-border-subtle" />
    </div>
  );
}
