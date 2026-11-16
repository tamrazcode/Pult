import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowRightLeft,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  GitBranch,
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
import { readImageDataUrl, runsDispatch } from "../../lib/ipc";
import {
  formatTime as formatClock,
  localizeIpcError,
  plural,
  translate,
  useT,
} from "../../lib/i18n";
import { activeRunForThread, threadTimelineItems, useRunsStore } from "../../stores/runs";
import { useThreadsStore } from "../../stores/threads";
import { useSettingsStore } from "../../stores/settings";
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
import {
  numberedExcerpt,
  toolCommand,
  toolLineRange,
  toolOutputText,
  toolPath,
  toolQuery,
} from "../../lib/toolDetails";
import { Button } from "../ui/button";
import Markdown from "./Markdown";
import { HistoryTicks, type HistoryTick } from "./HistoryTicks";

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

const STOP_REASON_KEYS: Record<string, string> = {
  end_turn: "chat.stop.endTurn",
  cancelled: "chat.stop.cancelled",
  refusal: "chat.stop.refused",
  max_tokens: "chat.stop.maxTokens",
  max_turn_requests: "chat.stop.maxTurnRequests",
};

const NOTICE_LEVEL_CLASSES: Record<string, string> = {
  warning: "text-warning",
  error: "text-danger",
};

/** Tail-window size for long transcripts (§6.5 60 fps budget). */
const TRANSCRIPT_WINDOW = 300;

export function MessagesTimeline({ threadId }: { threadId?: string }) {
  const t = useT();
  const runs = useRunsStore((s) => (threadId ? s.runsByThread[threadId] : undefined));
  const views = useRunsStore((s) => s.viewsByRun);
  const activeRun = activeRunForThread(runs);
  const runId = activeRun?.id;
  const view = useRunsStore((s) => (runId ? s.viewsByRun[runId] : undefined));
  const entries = useMemo(() => threadTimelineItems(runs, views), [runs, views]);
  const pendingUser = useRunsStore((s) => (threadId ? s.pendingUserByThread[threadId] : undefined));
  const hasView = view !== undefined;
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Windowing (§6.5): a 10k-event thread must scroll at 60 fps — render the
  // tail window only, expandable in chunks ("Earlier messages").
  const [windowSize, setWindowSize] = useState(TRANSCRIPT_WINDOW);
  const [activeHistoryKey, setActiveHistoryKey] = useState<string | null>(null);
  const [showScrollToEnd, setShowScrollToEnd] = useState(false);
  const followStreaming = useSettingsStore((s) => s.followStreaming);
  // Follow the stream only while the reader is already at the bottom.
  const isAtBottomRef = useRef(true);

  // Reset the window when switching threads, not when a new run starts: the
  // merged transcript of the same thread must keep its expanded window.
  useEffect(() => {
    setWindowSize(TRANSCRIPT_WINDOW);
    setActiveHistoryKey(null);
    setShowScrollToEnd(false);
    isAtBottomRef.current = true;
  }, [threadId]);

  // Follow the stream: scroll only while pinned to the bottom, in a frame.
  useEffect(() => {
    if (!followStreaming || !isAtBottomRef.current) return;
    const frame = requestAnimationFrame(() => {
      // The reader may have scrolled up while the frame was pending.
      if (isAtBottomRef.current) bottomRef.current?.scrollIntoView({ block: "end" });
    });
    return () => cancelAnimationFrame(frame);
  }, [view, followStreaming]);

  // Markdown's trailing throttle can grow the DOM between events; keep the
  // view pinned when the reader has not scrolled away.
  useEffect(() => {
    const content = scrollRef.current?.firstElementChild;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!followStreaming || !isAtBottomRef.current) return;
      requestAnimationFrame(() => {
        if (isAtBottomRef.current) bottomRef.current?.scrollIntoView({ block: "end" });
      });
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [threadId, hasView, entries.length, followStreaming]);

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
  const historyTicks: HistoryTick[] = [];
  entries.forEach((entry, globalIndex) => {
    if (entry.item.type === "user") {
      historyTicks.push({
        key: entry.key,
        label: entry.item.text.trim().slice(0, 80) || t("chat.imagePrompt"),
        globalIndex,
      });
    }
  });

  const jumpToTick = (tick: HistoryTick) => {
    if (tick.globalIndex < hiddenCount) {
      setWindowSize((size) => Math.max(size, entries.length - tick.globalIndex + 20));
    }
    // After the expansion renders, scroll the newly mounted row into view.
    requestAnimationFrame(() => {
      scrollRef.current
        ?.querySelector(`[data-history-key="${tick.key}"]`)
        ?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  };

  // Active tick = topmost user row still visible; also track bottom pinning.
  const trackActiveTick = () => {
    const container = scrollRef.current;
    if (!container) return;
    isAtBottomRef.current =
      container.scrollHeight - container.scrollTop - container.clientHeight < 48;
    setShowScrollToEnd(!isAtBottomRef.current);
    const top = container.getBoundingClientRect().top;
    let current: string | null = null;
    for (const row of container.querySelectorAll<HTMLElement>("[data-history-user]")) {
      if (row.getBoundingClientRect().bottom > top) {
        current = row.dataset.historyKey ?? null;
        break;
      }
    }
    setActiveHistoryKey((previous) => (previous === current ? previous : current));
  };

  return (
    <div className="relative flex min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={trackActiveTick}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 pt-6 pb-6">
          {hiddenCount > 0 && (
            <button
              onClick={() => setWindowSize((n) => n + TRANSCRIPT_WINDOW)}
              className="mx-auto rounded-(--radius-sm) border border-border-subtle px-3 py-1 text-xs text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
            >
              {t("chat.earlierMessagesHidden", { count: hiddenCount })}
            </button>
          )}
          {windowedEntries.length > 0 && <TimelineRows entries={windowedEntries} />}

          {pendingUser && (
            <div>
              <UserRow text={pendingUser.text} images={pendingUser.images} ts={pendingUser.ts} />
            </div>
          )}

          {view.streaming && activeRun?.startedAt !== undefined && (
            <WorkingTimer startedAt={activeRun.startedAt} />
          )}

          {entries.length === 0 && view.streaming && (
            <div className="flex items-center gap-2 py-1 text-sm text-text-tertiary">
              <ThinkingAscii />
              {t("chat.workingEllipsis")}
            </div>
          )}

          {view.plan && view.plan.length > 0 && <PlanCard entries={view.plan} />}

          {view.pendingApproval && runId && (
            <ApprovalCard runId={runId} approval={view.pendingApproval} />
          )}

          {crashed && (
            <CrashBanner
              detail={view.error ?? t("chat.failureNoReason")}
              retryText={retryText}
              onRetry={
                threadId && retryText ? () => void retryLastMessage(threadId, retryText) : undefined
              }
            />
          )}

          {!view.streaming && view.stopReason && view.stopReason !== "end_turn" && (
            <FinishDivider stopReason={view.stopReason} />
          )}

          {/* Space for the overlaid composer; must sit ABOVE the sentinel so
              scrollIntoView(end) still lands at the true bottom. */}
          <div className="h-32 shrink-0" aria-hidden />
          <div ref={bottomRef} />
        </div>
      </div>
      {showScrollToEnd && (
        <button
          type="button"
          aria-label={t("chat.scrollToEnd")}
          onClick={() => {
            isAtBottomRef.current = true;
            setShowScrollToEnd(false);
            const container = scrollRef.current;
            if (container) container.scrollTop = container.scrollHeight;
          }}
          className="absolute bottom-28 left-1/2 z-30 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border-strong bg-surface-raised/95 px-3 text-xs text-text-secondary shadow-(--shadow-composer) transition hover:bg-surface-raised hover:text-text-primary"
        >
          <ChevronDown size={13} /> {t("chat.scrollToEnd")}
        </button>
      )}
      <HistoryTicks ticks={historyTicks} activeKey={activeHistoryKey} onJump={jumpToTick} />
    </div>
  );
}

const ChatItemRow = memo(
  function ChatItemRow({ item, showCaret }: { item: ChatItem; showCaret: boolean }) {
    switch (item.type) {
      case "user":
        return <UserRow text={item.text} images={item.images} ts={item.ts} />;
      case "assistant":
        return (
          <TextRow text={item.text} streaming={item.streaming} showCaret={showCaret} ts={item.ts} />
        );
      case "trace":
        return <TraceRow optionId={item.optionId} />;
      case "compaction":
        return <CompactionDivider item={item} />;
      case "notice":
        return <NoticeRow level={item.level} message={item.message} />;
    }
  },
  (prev, next) => prev.item === next.item && prev.showCaret === next.showCaret,
);

type TimelineEntry = ReturnType<typeof threadTimelineItems>[number];

/** T3-style brake/ASCII spinner shown while the agent is working. */
export function ThinkingAscii() {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      return;
    }
    const timer = window.setInterval(() => setFrame((value) => (value + 1) % frames.length), 90);
    return () => window.clearInterval(timer);
  }, [frames.length]);
  return (
    <span aria-hidden className="inline-block w-3 shrink-0 text-accent">
      {frames[frame]}
    </span>
  );
}

function isZeroSecondThought(item: ChatItem): boolean {
  return (
    item.type === "thought" &&
    !item.streaming &&
    (item.text.trim().length === 0 ||
      Math.floor(Math.max(0, item.endedAt - item.startedAt) / 1000) === 0)
  );
}

function isActionItem(item: ChatItem): boolean {
  return item.type === "tool" || item.type === "thought" || item.type === "trace";
}

function summarizeActionGroup(items: ChatItem[]): string {
  let files = 0;
  let commands = 0;
  let reads = 0;
  let searches = 0;
  let other = 0;
  let thoughts = 0;
  for (const item of items) {
    if (item.type === "thought") {
      thoughts += 1;
      continue;
    }
    if (item.type !== "tool") continue;
    switch (item.kind) {
      case "edit":
      case "write":
      case "move":
      case "delete":
        files += 1;
        break;
      case "execute":
        commands += 1;
        break;
      case "read":
        reads += 1;
        break;
      case "search":
        searches += 1;
        break;
      default:
        other += 1;
    }
  }
  const parts: string[] = [];
  if (files > 0) parts.push(plural("chat.tool.changedFiles", files));
  if (commands > 0) parts.push(plural("chat.tool.ranCommands", commands));
  if (reads > 0) parts.push(plural("chat.tool.readFiles", reads));
  if (searches > 0) parts.push(plural("chat.tool.searchedTimes", searches));
  if (other > 0) parts.push(plural("chat.tool.otherActions", other));
  if (parts.length === 0) {
    return thoughts > 0
      ? plural("chat.tool.thoughtTimes", thoughts)
      : translate("chat.tool.actions");
  }
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(", ")} ${translate("chat.list.and")} ${parts[parts.length - 1]}`;
}

/** Consecutive tools/thoughts/traces collapse into one T3-style summary row. */
function TimelineRows({ entries }: { entries: TimelineEntry[] }) {
  const rows: ReactNode[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (isZeroSecondThought(entry.item)) continue;
    if (isActionItem(entry.item)) {
      const group: TimelineEntry[] = [];
      let next = index;
      while (next < entries.length) {
        const candidate = entries[next];
        if (isZeroSecondThought(candidate.item)) {
          next += 1;
          continue;
        }
        if (!isActionItem(candidate.item)) break;
        group.push(candidate);
        next += 1;
      }
      // A single action now lives inside the same smart activity row as a run;
      // the row itself auto-expands while the agent works.
      rows.push(
        <div key={entry.key} data-history-key={entry.key}>
          <ActionGroupRow entries={group} />
        </div>,
      );
      index = next - 1;
      continue;
    }
    rows.push(
      <div
        key={entry.key}
        data-history-key={entry.key}
        data-history-user={entry.item.type === "user" ? entry.key : undefined}
      >
        <ChatItemRow item={entry.item} showCaret={entry.showCaret} />
      </div>,
    );
  }
  return <>{rows}</>;
}

const ACTION_LABEL_KEYS: Record<string, string> = {
  read: "chat.action.reading",
  edit: "chat.action.editing",
  write: "chat.action.editing",
  move: "chat.action.editing",
  delete: "chat.action.editing",
  execute: "chat.action.running",
  search: "chat.action.searching",
  fetch: "chat.action.fetching",
  think: "chat.thinking",
};

function ActionGroupRow({ entries }: { entries: TimelineEntry[] }) {
  const t = useT();
  const items = entries.map((entry) => entry.item);
  const last = items[items.length - 1];
  const activeItem = [...items]
    .reverse()
    .find(
      (item) =>
        (item.type === "tool" && (item.status === "pending" || item.status === "in_progress")) ||
        (item.type === "thought" && item.streaming),
    );
  const active = activeItem !== undefined;
  // Open while the agent works, fold away when the run goes quiet; a manual
  // toggle stays until the next active/idle transition.
  const [open, setOpen] = useState(active);
  const previousActive = useRef(active);
  useEffect(() => {
    if (previousActive.current === active) return;
    previousActive.current = active;
    setOpen(active);
  }, [active]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (activeItem?.type !== "thought") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeItem]);

  let label: string;
  if (activeItem?.type === "thought") {
    label = t("chat.thinkingWithDuration", {
      duration: formatDuration(activeItem.startedAt, now),
    });
  } else if (activeItem?.type === "tool") {
    label = t(ACTION_LABEL_KEYS[activeItem.kind] ?? "chat.tool.working");
  } else if (items.length === 1 && last.type === "thought") {
    label = t("chat.thoughtFor", { duration: formatDuration(last.startedAt, last.endedAt) });
  } else if (items.length === 1 && last.type === "trace") {
    label = t("chat.trace.autoAllowed", { optionId: last.optionId });
  } else if (items.length === 1 && last.type === "tool" && last.kind === "other") {
    label = last.title;
  } else {
    label = summarizeActionGroup(items);
  }

  const SingleIcon =
    last.type === "tool" ? toolIcon(last.kind) : last.type === "thought" ? Brain : ShieldCheck;
  const Icon = items.length > 1 ? Eye : SingleIcon;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 py-0.5 text-left"
      >
        {active ? <ThinkingAscii /> : <Icon size={13} className="shrink-0 text-text-secondary" />}
        <span
          className={`min-w-0 flex-1 truncate text-sm ${
            active ? "activity-shimmer" : "text-text-secondary"
          }`}
        >
          {label}
        </span>
        {active && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />}
        <ChevronRight
          size={12}
          className={`shrink-0 text-text-tertiary transition-transform ${open ? "rotate-90" : ""}`}
        />
      </button>
      {open && (
        <div className="space-y-2 py-1 pl-5">
          {entries.map((entry) =>
            entry.item.type === "tool" ? (
              <ActionDetail key={entry.key} item={entry.item} />
            ) : entry.item.type === "thought" ? (
              <ThoughtDetail key={entry.key} item={entry.item} />
            ) : entry.item.type === "trace" ? (
              <TraceRow key={entry.key} optionId={entry.item.optionId} />
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

function ThoughtDetail({ item }: { item: ThoughtChatItem }) {
  const t = useT();
  return (
    <div className="py-0.5">
      <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
        <Brain size={11} className="shrink-0" />
        {t("chat.thoughtFor", { duration: formatDuration(item.startedAt, item.endedAt) })}
      </div>
      {item.text.trim() && (
        <p className="mt-0.5 text-sm whitespace-pre-wrap text-text-tertiary italic">{item.text}</p>
      )}
    </div>
  );
}

const DIFF_KINDS = new Set(["edit", "write", "move", "delete"]);

const ActionDetail = memo(function ActionDetail({ item }: { item: ToolChatItem }) {
  const t = useT();
  const [raw, setRaw] = useState(false);
  const Icon = toolIcon(item.kind);
  const path = toolPath(item);
  const range = toolLineRange(item);
  const output = toolOutputText(item);
  const image = findImageCandidate(item.rawOutput ?? item.content ?? item.rawInput);
  const excerpt =
    item.kind === "read" && output ? numberedExcerpt(output, range?.start ?? 1) : null;
  const canDiff = DIFF_KINDS.has(item.kind) && path !== null;
  const title =
    path === null
      ? item.title
      : item.kind === "read"
        ? t("chat.action.readFile", { path })
        : canDiff
          ? t("chat.action.editedFile", { path })
          : item.title;
  const command = item.kind === "execute" ? toolCommand(item) : null;
  const query = item.kind === "search" ? toolQuery(item) : null;
  const hasRaw =
    item.rawInput !== undefined || item.rawOutput !== undefined || item.content !== undefined;

  return (
    <div className="py-0.5">
      <div className="flex items-center gap-1.5 text-sm text-text-secondary">
        <Icon size={12} className="shrink-0 text-text-tertiary" />
        <span className="min-w-0 truncate">{title}</span>
        {range && (
          <span className="shrink-0 text-xs text-text-tertiary">
            {range.start}–{range.end}
          </span>
        )}
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${toolDot(item.status)}`} />
        {canDiff && (
          <button
            type="button"
            onClick={() => useUiStore.getState().setRightPanelTab("diff")}
            className="ml-auto shrink-0 rounded-(--radius-sm) border border-border-subtle px-1.5 py-0.5 text-xs text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
          >
            {t("chat.action.openDiff")}
          </button>
        )}
      </div>
      {command && command !== title && (
        <pre className="mt-1 overflow-x-auto rounded-(--radius-sm) bg-code-bg px-2 py-1 font-mono text-xs text-text-secondary">
          $ {command}
        </pre>
      )}
      {query && query !== title && (
        <div className="mt-1 font-mono text-xs text-text-tertiary">{query}</div>
      )}
      {excerpt ? (
        <div className="mt-1 max-h-64 overflow-auto rounded-(--radius-sm) bg-code-bg py-1 font-mono text-xs">
          {excerpt.lines.map((line) => (
            <div key={line.n} className="flex px-2">
              <span className="w-10 shrink-0 pr-2 text-right text-text-tertiary/70 select-none">
                {line.n}
              </span>
              <span className="whitespace-pre text-text-secondary">{line.text}</span>
            </div>
          ))}
          {excerpt.truncated > 0 && (
            <div className="px-2 pl-12 text-text-tertiary">
              {plural("chat.action.moreLines", excerpt.truncated)}
            </div>
          )}
        </div>
      ) : output ? (
        <pre className="mt-1 max-h-48 overflow-auto rounded-(--radius-sm) bg-code-bg px-2 py-1 font-mono text-xs whitespace-pre-wrap text-text-secondary">
          {output}
        </pre>
      ) : null}
      {image && (
        <div className="mt-1">
          <ToolImage candidate={image} />
        </div>
      )}
      {hasRaw && (
        <button
          type="button"
          onClick={() => setRaw((value) => !value)}
          aria-expanded={raw}
          className="mt-1 text-xs text-text-tertiary transition hover:text-text-secondary"
        >
          {t("chat.tool.raw")}
        </button>
      )}
      {raw && (
        <pre className="mt-1 overflow-x-auto font-mono text-xs whitespace-pre-wrap text-text-tertiary">
          {JSON.stringify(
            { input: item.rawInput, output: item.rawOutput ?? item.content },
            null,
            2,
          )}
        </pre>
      )}
    </div>
  );
});

/** Live elapsed-time line under a streaming run ("Working for 4s"). */
function WorkingTimer({ startedAt }: { startedAt: number }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="flex items-center gap-2 py-1 text-sm text-text-tertiary">
      <ThinkingAscii />
      {t("chat.workingFor", { duration: formatDuration(startedAt, now) })}
    </div>
  );
}

function EmptyState() {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <div className="flex flex-col items-center gap-2 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-(--radius-lg) border border-border-subtle bg-surface">
          <MessageSquare size={20} className="text-text-tertiary" />
        </div>
        <p className="text-lg text-text-secondary">{t("chat.empty.title")}</p>
        <p className="max-w-[42ch] text-sm text-text-tertiary">{t("chat.empty.body")}</p>
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

function formatTime(ts: number | undefined): string | null {
  if (!ts) return null;
  return formatClock(ts);
}

/** Hover row under a message: copy, branch into a new thread, timestamp. */
function MessageActions({
  text,
  ts,
  align,
}: {
  text: string;
  ts?: number;
  align: "left" | "right";
}) {
  const [copied, setCopied] = useState(false);
  const t = useT();
  const showTimestamps = useSettingsStore((s) => s.showTimestamps);
  const time = showTimestamps ? formatTime(ts) : null;
  const copy = () => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => undefined);
  };
  const branch = () => {
    const threads = useThreadsStore.getState();
    const thread = threads.threads.find((candidate) => candidate.id === threads.activeThreadId);
    if (!thread) return;
    void threads
      .createThread(thread.projectId ?? null, t("chat.branchTitle", { text: text.slice(0, 48) }), {
        workspace: thread.workspace,
        worktree: false,
      })
      .then(async (next) => {
        // The message text seeds the branch's first turn; transcript history
        // stays in the source thread.
        useUiStore.getState().setComposerPrefill(text);
        useUiStore.getState().setPendingThread(next.id);
      })
      .catch((err) =>
        useUiStore.getState().setGlobalError({ kind: "storage", message: localizeIpcError(err) }),
      );
  };
  return (
    <div
      className={`flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 ${
        align === "right" ? "justify-end" : "justify-start"
      }`}
    >
      <button
        type="button"
        aria-label={t("chat.copyMessage")}
        title={t("chat.copy")}
        onClick={copy}
        className="flex h-6 w-6 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
      <button
        type="button"
        aria-label={t("chat.branchFromMessage")}
        title={t("chat.branchFromMessage")}
        onClick={branch}
        className="flex h-6 w-6 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
      >
        <GitBranch size={12} />
      </button>
      {time && <span className="px-1 text-xs text-text-tertiary tabular-nums">{time}</span>}
    </div>
  );
}

function UserRow({
  text,
  images,
  ts,
}: {
  text: string;
  images: { data: string; mimeType: string }[];
  ts?: number;
}) {
  const t = useT();
  return (
    <div className="group flex justify-end">
      <div className="flex max-w-[75%] flex-col items-end gap-2">
        {images.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2">
            {images.map((img, i) => (
              <button
                key={i}
                type="button"
                aria-label={t("chat.openImage")}
                onClick={() =>
                  useUiStore
                    .getState()
                    .openImagePreview(`data:${img.mimeType};base64,${img.data}`, t("chat.attached"))
                }
                className="cursor-zoom-in"
              >
                <img
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt={t("chat.attached")}
                  className="max-h-40 rounded-(--radius-md) border border-border-subtle"
                />
              </button>
            ))}
          </div>
        )}
        {text && (
          <div className="rounded-(--radius-md) border border-border-subtle bg-surface px-4 py-2.5 text-base whitespace-pre-wrap text-text-primary">
            {text}
          </div>
        )}
        <MessageActions text={text} ts={ts} align="right" />
      </div>
    </div>
  );
}

function TextRow({
  text,
  streaming,
  showCaret,
  ts,
}: {
  text: string;
  streaming: boolean;
  showCaret: boolean;
  ts?: number;
}) {
  return (
    <div className="group">
      <div className="md text-base text-text-primary">
        <Markdown text={text} streaming={streaming} />
        {streaming && showCaret && <Caret show />}
      </div>
      {!streaming && <MessageActions text={text} ts={ts} align="left" />}
    </div>
  );
}

function formatDuration(startedAt: number, endedAt: number): string {
  const seconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Policy trace row: the mode auto-resolved a permission (never silent). */
function TraceRow({ optionId }: { optionId: string }) {
  const t = useT();
  return (
    <div className="flex items-center gap-2 py-0.5 text-xs text-text-tertiary">
      <ShieldCheck size={11} className="shrink-0" />
      <span>{t("chat.trace.autoAllowed", { optionId })}</span>
    </div>
  );
}

const COMPACTION_LABEL_KEYS: Record<string, string> = {
  in_progress: "chat.compaction.inProgress",
  completed: "chat.compaction.completed",
  failed: "chat.compaction.failed",
  cancelled: "chat.compaction.cancelled",
};

function CompactionDivider({ item }: { item: CompactionChatItem }) {
  const t = useT();
  const label = t(
    COMPACTION_LABEL_KEYS[item.status ?? "in_progress"] ?? "chat.compaction.completed",
  );
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

interface ImageCandidate {
  dataUrl?: string;
  path?: string;
}

/** Finds an inline/base64/path image anywhere in a tool payload (imagegen). */
function findImageCandidate(value: unknown, depth = 0): ImageCandidate | null {
  if (depth > 4 || value === null || value === undefined) return null;
  if (typeof value === "string") {
    const dataUrl = value.match(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/i);
    if (dataUrl) return { dataUrl: dataUrl[0] };
    const path =
      value.match(/[A-Za-z]:\\[^\n"']+?\.(?:png|jpe?g|webp|gif)/i) ??
      value.match(/\/[^\s"']+?\.(?:png|jpe?g|webp|gif)/i);
    if (path) return { path: path[0] };
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findImageCandidate(entry, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (
      typeof record.mimeType === "string" &&
      record.mimeType.startsWith("image/") &&
      typeof record.data === "string"
    ) {
      return { dataUrl: `data:${record.mimeType};base64,${record.data}` };
    }
    for (const key of ["image", "images", "content", "result", "output", "path", "file", "url"]) {
      const found = findImageCandidate(record[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function ToolImage({ candidate }: { candidate: ImageCandidate }) {
  const t = useT();
  const tooLarge = (value: string) => value.length > 2_500_000;
  const [src, setSrc] = useState<string | null>(
    candidate.dataUrl && !tooLarge(candidate.dataUrl) ? candidate.dataUrl : null,
  );
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (src || !candidate.path) return;
    let cancelled = false;
    readImageDataUrl(candidate.path)
      .then((url) => {
        if (!cancelled) {
          if (tooLarge(url)) setFailed(true);
          else setSrc(url);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [candidate.path, src]);
  if (candidate.dataUrl && tooLarge(candidate.dataUrl)) {
    return <span className="text-xs text-text-tertiary">{t("chat.imageTooLarge")}</span>;
  }
  if (failed) return null;
  if (!src) return <span className="text-xs text-text-tertiary">{t("chat.loadingImage")}</span>;
  return (
    <button
      type="button"
      aria-label={t("chat.openImage")}
      title={t("chat.agentGeneratedImage")}
      onClick={() => useUiStore.getState().openImagePreview(src, t("chat.agentGenerated"))}
      className="cursor-zoom-in"
    >
      <img
        src={src}
        alt={t("chat.agentGenerated")}
        className="max-h-64 rounded-(--radius-md) border border-border-subtle"
      />
    </button>
  );
}

function PlanStatusIcon({ status }: { status: PlanEntry["status"] }) {
  if (status === "completed") return <Check size={13} className="mt-0.5 shrink-0 text-success" />;
  if (status === "in_progress")
    return <span className="mt-1.5 h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent" />;
  return <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-text-tertiary" />;
}

function PlanCard({ entries }: { entries: PlanEntry[] }) {
  const t = useT();
  return (
    <div className="rounded-(--radius-md) border border-border-subtle bg-surface">
      <div className="border-b border-border-subtle px-3 py-1.5 text-xs font-semibold tracking-wider text-text-tertiary uppercase">
        {t("chat.plan")}
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
  const t = useT();
  const [sent, setSent] = useState(false);
  // Show WHO asks and WHERE: an approval is about this agent in this project.
  const instanceId = useRunsStore((s) => {
    for (const runs of Object.values(s.runsByThread)) {
      const run = runs.find((candidate) => candidate.id === runId);
      if (run) return run.instanceId;
    }
    return null;
  });
  const providerName = useUiStore((s) =>
    instanceId
      ? s.instances.find((instance) => instance.id === instanceId)?.displayName
      : undefined,
  );
  const workspace = useThreadsStore(
    (s) => s.threads.find((thread) => thread.id === s.activeThreadId)?.workspace,
  );
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
        {t("chat.approvalNeeded")}
      </div>
      <div className="space-y-2.5 px-3 py-2.5">
        <p className="text-sm text-text-primary">{approval.title}</p>
        <p className="text-xs text-text-tertiary">
          {providerName ?? instanceId ?? t("chat.agent")}
          {workspace ? ` · ${workspace}` : ""}
        </p>
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
              {option.kind === "allow_always" && (
                <span className="ml-1 text-xs opacity-70">· {t("chat.allowAlwaysScope")}</span>
              )}
              <span className="ml-1 text-xs opacity-60">{keyHint(option.kind)}</span>
            </Button>
          ))}
          <Button size="sm" variant="ghost" onClick={() => respond(null)} disabled={sent}>
            {t("composer.approval.cancel")}
          </Button>
        </div>
        {approval.options.some((option) => option.kind === "allow_always") && (
          <p className="text-xs text-text-tertiary">{t("chat.approvalAlwaysScope")}</p>
        )}
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
  const t = useT();
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
        {t("chat.runCrashed")}
      </div>
      <div className="space-y-2 px-3 py-2.5">
        <pre className="overflow-x-auto rounded-(--radius-sm) bg-code-bg p-2 font-mono text-xs whitespace-pre-wrap text-text-secondary">
          {detail}
        </pre>
        <div className="flex flex-wrap items-center gap-2">
          {onRetry && retryText && (
            <Button size="sm" variant="secondary" onClick={onRetry}>
              <RotateCcw size={12} />
              {t("chat.retryLastMessage")}
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={copyDiagnostics}>
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? t("chat.copied") : t("chat.error.copyDiagnostics")}
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
    useUiStore.getState().setGlobalError({ kind: "protocol", message: localizeIpcError(err) }),
  );
}

function FinishDivider({ stopReason }: { stopReason: string }) {
  const t = useT();
  const key = STOP_REASON_KEYS[stopReason];
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="h-px flex-1 bg-border-subtle" />
      <span className="text-xs text-text-tertiary">{key ? t(key) : stopReason}</span>
      <div className="h-px flex-1 bg-border-subtle" />
    </div>
  );
}
