import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  LogIn,
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
import { useRouter } from "@tanstack/react-router";
import { readImageDataUrl, runsDispatch } from "../../lib/ipc";
import {
  formatTime as formatClock,
  localizeIpcError,
  plural,
  translate,
  useT,
} from "../../lib/i18n";
import { activeRunForThread, threadTimelineItems, useRunsStore } from "../../stores/runs";
import { useSubagentsStore, isTaskActive, useThreadSubagents } from "../../stores/subagents";
import { SubagentCard } from "./SubagentCard";
import { SubagentGroupCard } from "./SubagentGroupCard";
import { NativeSubagentCard } from "./NativeSubagentCard";
import {
  collectNativeSubagents,
  isNativeSubagentItem,
  nativeSubagentInfo,
} from "../../lib/nativeSubagents";
import type { DelegatedTask } from "../../lib/types";
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
  deriveToolTitle,
  normalizeToolKind,
  numberedExcerpt,
  thoughtPreview,
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

/** ~12 lines, but never more than half the chat viewport (min 8 lines). */
export function computeUserClampHeight(viewportHeight: number): number {
  const halfViewport = viewportHeight > 0 ? Math.floor(viewportHeight * 0.5) : 264;
  return Math.min(264, Math.max(176, halfViewport));
}

export function MessagesTimeline({ threadId }: { threadId?: string }) {
  const t = useT();
  const runs = useRunsStore((s) => (threadId ? s.runsByThread[threadId] : undefined));
  const views = useRunsStore((s) => s.viewsByRun);
  const activeRun = activeRunForThread(runs);
  const runId = activeRun?.id;
  const view = useRunsStore((s) => (runId ? s.viewsByRun[runId] : undefined));
  const entries = useMemo(() => threadTimelineItems(runs, views), [runs, views]);
  const pendingUser = useRunsStore((s) => (threadId ? s.pendingUserByThread[threadId] : undefined));
  const subagents = useThreadSubagents(threadId);
  const subagentGroups = useMemo(() => {
    const groups = new Map<string, DelegatedTask[]>();
    for (const task of subagents) {
      const key = task.parentRunId;
      const group = groups.get(key);
      if (group) group.push(task);
      else groups.set(key, [task]);
    }
    return [...groups.entries()]
      .map(([parentRunId, tasks]) => {
        const sorted = [...tasks].sort((a, b) => a.startedAt - b.startedAt);
        const active = sorted.some((task) => isTaskActive(task.status));
        return {
          parentRunId,
          tasks: sorted,
          active,
          startedAt: sorted[0].startedAt,
          // A running child lives at the bottom of the current run, so later
          // answers cannot hide it. Finished children settle where they were.
          anchorTs: active
            ? Number.POSITIVE_INFINITY
            : Math.max(...sorted.map((task) => task.finishedAt ?? task.startedAt)),
        };
      })
      .sort((a, b) => a.anchorTs - b.anchorTs);
  }, [subagents]);
  const nativeGroups = useMemo(
    () => collectNativeSubagents(entries.map((entry) => entry.item)),
    [entries],
  );
  const nativeGroupByKey = useMemo(
    () => new Map(nativeGroups.map((group) => [group.key, group])),
    [nativeGroups],
  );
  const runIndexById = useMemo(() => new Map((runs ?? []).map((run) => [run.id, run.idx])), [runs]);
  const runStartedAtById = useMemo(
    () => new Map((runs ?? []).map((run) => [run.id, run.startedAt])),
    [runs],
  );
  useEffect(() => {
    if (threadId) void useSubagentsStore.getState().load(threadId);
  }, [threadId]);
  const hasView = view !== undefined;
  const scrollRef = useRef<HTMLDivElement>(null);
  // Windowing (§6.5): a 10k-event thread must scroll at 60 fps — render the
  // tail window only, expandable in chunks ("Earlier messages").
  const [windowSize, setWindowSize] = useState(TRANSCRIPT_WINDOW);
  const [activeHistoryKey, setActiveHistoryKey] = useState<string | null>(null);
  const [showScrollToEnd, setShowScrollToEnd] = useState(false);
  const followStreaming = useSettingsStore((s) => s.followStreaming);
  // Follow the stream only while the reader is already at the bottom.
  const isAtBottomRef = useRef(true);
  // One pending pin frame at a time: repeated deltas must not queue up and
  // fight the reader's wheel.
  const pinFrameRef = useRef(0);
  const pinToBottom = useCallback(() => {
    if (pinFrameRef.current) return;
    pinFrameRef.current = requestAnimationFrame(() => {
      pinFrameRef.current = 0;
      // The reader may have scrolled up while the frame was pending.
      if (!isAtBottomRef.current) return;
      const container = scrollRef.current;
      // scrollHeight includes the pb-7 gap, so the composer gap stays constant.
      if (container) container.scrollTop = container.scrollHeight;
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(pinFrameRef.current), []);
  // Long user bubbles cap at half the visible transcript height.
  const [viewportHeight, setViewportHeight] = useState(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setViewportHeight(el.clientHeight);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasView, threadId]);
  const clampMaxPx = computeUserClampHeight(viewportHeight);

  // Reset the window when switching threads, not when a new run starts: the
  // merged transcript of the same thread must keep its expanded window.
  useEffect(() => {
    setWindowSize(TRANSCRIPT_WINDOW);
    setActiveHistoryKey(null);
    setShowScrollToEnd(false);
    isAtBottomRef.current = true;
  }, [threadId]);

  // Follow the stream: pin only while the reader is at the bottom.
  useEffect(() => {
    if (!followStreaming || !isAtBottomRef.current) return;
    pinToBottom();
  }, [view, followStreaming, pinToBottom]);

  // Markdown's trailing throttle can grow the DOM between events; keep the
  // view pinned when the reader has not scrolled away.
  useEffect(() => {
    const content = scrollRef.current?.firstElementChild;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!followStreaming || !isAtBottomRef.current) return;
      pinToBottom();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [threadId, hasView, entries.length, followStreaming, pinToBottom]);

  // The composer changes the transcript height. Keep a pinned reader pinned;
  // a reader who scrolled up only gets the "Scroll to end" pill refreshed.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (isAtBottomRef.current) {
        pinToBottom();
      } else {
        const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 48;
        setShowScrollToEnd(!atBottom);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [hasView, threadId, pinToBottom]);

  if (!threadId) return <EmptyState />;

  if (!view) {
    if (!pendingUser && subagentGroups.length === 0) return <EmptyState />;
    return (
      <div className="relative flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 pt-6 pb-7">
            {pendingUser && (
              <UserRow
                text={pendingUser.text}
                images={pendingUser.images}
                ts={pendingUser.ts}
                clampMaxPx={clampMaxPx}
              />
            )}
            {pendingUser && <ThinkingRow />}
            {subagentGroups.map((group) =>
              group.tasks.length > 1 ? (
                <SubagentGroupCard key={group.parentRunId} tasks={group.tasks} />
              ) : (
                <SubagentCard key={group.tasks[0].taskId} task={group.tasks[0]} />
              ),
            )}
          </div>
        </div>
      </div>
    );
  }

  const hasContent =
    pendingUser !== undefined ||
    entries.length > 0 ||
    subagents.length > 0 ||
    nativeGroups.length > 0 ||
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
        data-chat-scroll
        onScroll={trackActiveTick}
        className="flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 pt-6 pb-7">
          {hiddenCount > 0 && (
            <button
              onClick={() => setWindowSize((n) => n + TRANSCRIPT_WINDOW)}
              className="mx-auto rounded-(--radius-sm) border border-border-subtle px-3 py-1 text-xs text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
            >
              {t("chat.earlierMessagesHidden", { count: hiddenCount })}
            </button>
          )}
          {windowedEntries.length > 0 && (
            <TimelineRows
              entries={windowedEntries}
              allEntries={entries}
              hiddenCount={hiddenCount}
              subagentGroups={subagentGroups}
              nativeGroupByKey={nativeGroupByKey}
              runIndexById={runIndexById}
              runStartedAtById={runStartedAtById}
              clampMaxPx={clampMaxPx}
              activeRunId={activeRun?.id}
              streaming={view.streaming}
            />
          )}

          {pendingUser && (
            <div>
              <UserRow
                text={pendingUser.text}
                images={pendingUser.images}
                ts={pendingUser.ts}
                clampMaxPx={clampMaxPx}
              />
            </div>
          )}

          {pendingUser && !view.streaming && <ThinkingRow />}

          {view.streaming && activeRun?.startedAt !== undefined && (
            <WorkingTimer startedAt={activeRun.startedAt} />
          )}

          {entries.length === 0 && view.streaming && activeRun?.startedAt === undefined && (
            <div className="flex items-center gap-2 py-1 text-sm text-text-tertiary">
              <ThinkingAscii />
              <span className="activity-shimmer">{t("chat.workingEllipsis")}</span>
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
          className="absolute bottom-4 left-1/2 z-30 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border-strong bg-surface-raised/95 px-3 text-xs text-text-secondary shadow-(--shadow-composer) transition hover:bg-surface-raised hover:text-text-primary"
        >
          <ChevronDown size={13} /> {t("chat.scrollToEnd")}
        </button>
      )}
      <HistoryTicks ticks={historyTicks} activeKey={activeHistoryKey} onJump={jumpToTick} />
    </div>
  );
}

const ChatItemRow = memo(
  function ChatItemRow({
    item,
    clampMaxPx,
    runStartedAt,
  }: {
    item: ChatItem;
    clampMaxPx: number;
    runStartedAt?: number;
  }) {
    switch (item.type) {
      case "user":
        return (
          <UserRow text={item.text} images={item.images} ts={item.ts} clampMaxPx={clampMaxPx} />
        );
      case "assistant":
        return (
          <TextRow
            text={item.text}
            streaming={item.streaming}
            ts={item.ts}
            runStartedAt={runStartedAt}
          />
        );
      case "trace":
        return <TraceRow optionId={item.optionId} />;
      case "compaction":
        return <CompactionDivider item={item} />;
      case "notice":
        return <NoticeRow level={item.level} message={item.message} />;
    }
  },
  (prev, next) =>
    prev.item === next.item &&
    prev.clampMaxPx === next.clampMaxPx &&
    prev.runStartedAt === next.runStartedAt,
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
    switch (normalizeToolKind(item)) {
      case "edit":
      case "delete":
      case "move":
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
  if (commands > 0) parts.push(plural("chat.tool.ranCommands", commands));
  if (files > 0) parts.push(plural("chat.tool.changedFiles", files));
  if (reads > 0) parts.push(plural("chat.tool.readFiles", reads));
  if (searches > 0) parts.push(plural("chat.tool.searchedTimes", searches));
  if (other > 0) parts.push(plural("chat.tool.otherActions", other));
  if (parts.length === 0) {
    return thoughts > 0
      ? plural("chat.tool.thoughtTimes", thoughts)
      : translate("chat.tool.actions");
  }
  const summary =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(", ")} ${translate("chat.list.and")} ${parts[parts.length - 1]}`;
  return summary.charAt(0).toUpperCase() + summary.slice(1);
}

type SubagentAnchor = {
  parentRunId: string;
  tasks: DelegatedTask[];
  active: boolean;
  startedAt: number;
  anchorTs: number;
};

type NativeGroup = ReturnType<typeof collectNativeSubagents>[number];

function entryTimestamp(entry: TimelineEntry): number | undefined {
  return entry.item.type === "thought" ? entry.item.startedAt : entry.item.ts;
}

/** Messages keep their order; each run's action row renders after its last message. */
function TimelineRows({
  entries,
  allEntries,
  hiddenCount,
  subagentGroups,
  nativeGroupByKey,
  runIndexById,
  runStartedAtById,
  clampMaxPx,
  activeRunId,
  streaming,
}: {
  entries: TimelineEntry[];
  allEntries: TimelineEntry[];
  hiddenCount: number;
  subagentGroups: SubagentAnchor[];
  nativeGroupByKey: Map<string, NativeGroup>;
  runIndexById: Map<string, number>;
  runStartedAtById: Map<string, number>;
  clampMaxPx: number;
  activeRunId?: string;
  streaming?: boolean;
}) {
  const rows: ReactNode[] = [];
  const renderedNative = new Set<string>();

  const segments: Array<{ runId: string; entries: TimelineEntry[] }> = [];
  for (const entry of entries) {
    const last = segments[segments.length - 1];
    if (last && last.runId === entry.runId) last.entries.push(entry);
    else segments.push({ runId: entry.runId, entries: [entry] });
  }

  const visibleRuns = new Set(segments.map((segment) => segment.runId));
  const allRuns = new Set(allEntries.map((entry) => entry.runId));
  const firstVisibleIdx = segments.length
    ? (runIndexById.get(segments[0].runId) ?? -Infinity)
    : Infinity;
  const pushGroup = (group: SubagentAnchor) => {
    rows.push(
      group.tasks.length > 1 ? (
        <SubagentGroupCard key={`subagent-${group.parentRunId}`} tasks={group.tasks} />
      ) : (
        <SubagentCard key={group.tasks[0].taskId} task={group.tasks[0]} />
      ),
    );
  };

  const groupsForRun = new Map<string, SubagentAnchor[]>();
  const floating: Array<{ beforeIndex: number; group: SubagentAnchor }> = [];
  // A group with a running task always sits at the bottom of the transcript,
  // right above the live action row — its parent run may be far above.
  const activeGroups: SubagentAnchor[] = [];
  for (const group of subagentGroups) {
    if (group.active) {
      activeGroups.push(group);
      continue;
    }
    if (visibleRuns.has(group.parentRunId)) {
      const list = groupsForRun.get(group.parentRunId) ?? [];
      list.push(group);
      groupsForRun.set(group.parentRunId, list);
      continue;
    }
    // Its run is above the visible window: reveal it with "Earlier messages".
    if (allRuns.has(group.parentRunId)) continue;
    const runIdx = runIndexById.get(group.parentRunId);
    if (runIdx === undefined) {
      floating.push({ beforeIndex: segments.length, group });
      continue;
    }
    if (hiddenCount > 0 && runIdx < firstVisibleIdx) continue;
    const beforeIndex = segments.findIndex(
      (segment) => (runIndexById.get(segment.runId) ?? Infinity) > runIdx,
    );
    floating.push({ beforeIndex: beforeIndex === -1 ? segments.length : beforeIndex, group });
  }
  activeGroups.sort((a, b) => a.startedAt - b.startedAt);
  let activePushed = false;
  const pushActiveGroups = () => {
    for (const group of activeGroups) pushGroup(group);
    activePushed = true;
  };

  segments.forEach((segment, segmentIndex) => {
    for (const item of floating) {
      if (item.beforeIndex === segmentIndex) pushGroup(item.group);
    }
    const actions: TimelineEntry[] = [];
    const anchors = groupsForRun.get(segment.runId) ?? [];
    let anchorIndex = 0;
    const flushAnchorsBefore = (ts: number | undefined) => {
      while (
        anchorIndex < anchors.length &&
        (ts === undefined || anchors[anchorIndex].anchorTs < ts)
      ) {
        pushGroup(anchors[anchorIndex]);
        anchorIndex += 1;
      }
    };

    for (const entry of segment.entries) {
      if (isZeroSecondThought(entry.item)) continue;
      if (isNativeSubagentItem(entry.item)) {
        const key =
          entry.item.type === "tool" ? nativeSubagentInfo(entry.item)?.parentToolUseId : undefined;
        if (key && !renderedNative.has(key)) {
          renderedNative.add(key);
          const group = nativeGroupByKey.get(key);
          if (group) {
            flushAnchorsBefore(entryTimestamp(entry));
            rows.push(
              <div key={`native-${key}`} data-history-key={entry.key}>
                <NativeSubagentCard group={group} />
              </div>,
            );
          }
        }
        continue;
      }
      if (isActionItem(entry.item)) {
        actions.push(entry);
        continue;
      }
      flushAnchorsBefore(entryTimestamp(entry));
      rows.push(
        <div
          key={entry.key}
          data-history-key={entry.key}
          data-history-user={entry.item.type === "user" ? entry.key : undefined}
        >
          <ChatItemRow
            item={entry.item}
            clampMaxPx={clampMaxPx}
            runStartedAt={runStartedAtById.get(entry.runId)}
          />
        </div>,
      );
    }
    while (anchorIndex < anchors.length) {
      pushGroup(anchors[anchorIndex]);
      anchorIndex += 1;
    }
    if (actions.length > 0) {
      // Running subagents sit directly above the live action row.
      if (!activePushed && streaming === true && segment.runId === activeRunId) {
        pushActiveGroups();
      }
      // One smart row per run, after all of that run's messages: tools,
      // thoughts and traces stay together and never split the reply.
      rows.push(
        <div key={`action-group-${segment.runId}`} data-history-key={actions[0].key}>
          <ActionGroupRow
            entries={actions}
            streaming={streaming === true && segment.runId === activeRunId}
          />
        </div>,
      );
    }
  });

  for (const item of floating) {
    if (item.beforeIndex >= segments.length) pushGroup(item.group);
  }
  if (!activePushed) pushActiveGroups();
  return <>{rows}</>;
}

/** One tool payload cannot monopolize the DOM; the Raw toggle shows the rest. */
const MAX_DETAIL_CHARS = 12_000;

const clipDetail = (text: string): string =>
  text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}\n…` : text;

function ActionGroupRow({ entries, streaming }: { entries: TimelineEntry[]; streaming?: boolean }) {
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
  // The run-level spinner and clock live in WorkingTimer; this row spins only
  // while one of its own items is live.
  const spinning = active;
  // A manual open survives individual completions and folds only with the run.
  const runActive = Boolean(streaming) || active;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!runActive) setOpen(false);
  }, [runActive]);
  let label: string;
  if (activeItem?.type === "thought") {
    label = thoughtPreview(activeItem.text) ?? t("chat.thinking");
  } else if (activeItem?.type === "tool") {
    label = deriveToolTitle(activeItem, "present");
  } else if (items.length === 1 && last.type === "thought") {
    label = thoughtPreview(last.text) ?? summarizeActionGroup(items);
  } else if (items.length === 1 && last.type === "trace") {
    label = t("chat.trace.autoAllowed", { optionId: last.optionId });
  } else {
    label = summarizeActionGroup(items);
  }

  const SingleIcon =
    last.type === "tool"
      ? toolIcon(normalizeToolKind(last))
      : last.type === "thought"
        ? Brain
        : ShieldCheck;
  const Icon = items.length > 1 ? Eye : SingleIcon;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 py-0.5 text-left"
      >
        {spinning ? <ThinkingAscii /> : <Icon size={13} className="shrink-0 text-text-secondary" />}
        <span
          className={`min-w-0 flex-1 truncate text-sm ${
            spinning ? "activity-shimmer" : "text-text-secondary"
          }`}
        >
          {label}
        </span>
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
  const [expanded, setExpanded] = useState(false);
  const hasText = item.text.trim().length > 0;
  const preview = thoughtPreview(item.text);
  const duration = formatDuration(item.startedAt, item.endedAt);
  const label = preview
    ? t("chat.thoughtPreviewWithDuration", { preview, duration })
    : t("chat.thoughtFor", { duration });
  return (
    <div className="py-0.5">
      {hasText ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          className="flex w-full items-center gap-1.5 text-left text-xs text-text-tertiary"
        >
          <ChevronRight
            size={11}
            className={`shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`}
          />
          <Brain size={11} className="shrink-0" />
          {label}
        </button>
      ) : (
        <div className="flex items-center gap-1.5 text-xs text-text-tertiary">
          <Brain size={11} className="shrink-0" />
          {label}
        </div>
      )}
      {hasText && expanded && (
        <p className="mt-0.5 pl-4 text-sm whitespace-pre-wrap text-text-tertiary italic">
          {item.text}
        </p>
      )}
    </div>
  );
}

const DIFF_KINDS = new Set(["edit", "write", "move", "delete"]);

const ActionDetail = memo(function ActionDetail({ item }: { item: ToolChatItem }) {
  const t = useT();
  const [raw, setRaw] = useState(false);
  const kind = normalizeToolKind(item);
  const Icon = toolIcon(kind);
  const path = toolPath(item);
  const range = toolLineRange(item);
  const output = clipDetail(toolOutputText(item));
  const image = findImageCandidate(item.rawOutput ?? item.content ?? item.rawInput);
  const excerpt = kind === "read" && output ? numberedExcerpt(output, range?.start ?? 1) : null;
  const canDiff = DIFF_KINDS.has(kind) && path !== null;
  const title = deriveToolTitle(
    item,
    item.status === "in_progress" || item.status === "pending" ? "present" : "past",
  );
  const command = kind === "execute" ? toolCommand(item) : null;
  const query = kind === "search" ? toolQuery(item) : null;
  const hasRaw =
    item.rawInput !== undefined || item.rawOutput !== undefined || item.content !== undefined;
  const hasDetails = Boolean(
    (command && command !== title) ||
    (query && query !== title) ||
    excerpt ||
    output ||
    image ||
    hasRaw,
  );
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="py-0.5">
      <div className="flex items-center gap-1.5 text-sm text-text-secondary">
        {hasDetails ? (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            <ChevronRight
              size={11}
              className={`shrink-0 text-text-tertiary transition-transform ${
                expanded ? "rotate-90" : ""
              }`}
            />
            <Icon size={12} className="shrink-0 text-text-tertiary" />
            <span className="min-w-0 truncate">{title}</span>
            {range && (
              <span className="shrink-0 text-xs text-text-tertiary">
                {range.start}–{range.end}
              </span>
            )}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <Icon size={12} className="shrink-0 text-text-tertiary" />
            <span className="min-w-0 truncate">{title}</span>
            {range && (
              <span className="shrink-0 text-xs text-text-tertiary">
                {range.start}–{range.end}
              </span>
            )}
          </div>
        )}
        {item.status === "failed" && (
          <span data-status-dot="failed" className="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" />
        )}
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
      {hasDetails && expanded && (
        <div>
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
              {clipDetail(
                JSON.stringify(
                  { input: item.rawInput, output: item.rawOutput ?? item.content },
                  null,
                  2,
                ),
              )}
            </pre>
          )}
        </div>
      )}
    </div>
  );
});

/** Immediate optimistic state between send and the first run event. */
function ThinkingRow() {
  const t = useT();
  return (
    <div className="flex items-center gap-2 py-1 text-sm text-text-tertiary">
      <ThinkingAscii />
      <span className="activity-shimmer">{t("chat.thinking")}…</span>
    </div>
  );
}

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
      <span className="activity-shimmer">
        {t("chat.workingFor", { duration: formatDuration(startedAt, now) })}
      </span>
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

function formatTime(ts: number | undefined): string | null {
  if (!ts) return null;
  const hour12 = useSettingsStore.getState().timeFormat === "12h";
  return formatClock(ts, undefined, hour12);
}

/** `46s`, `2m 5s`, `1h 3m` — how long after the run started this message landed. */
export function formatElapsed(startedAt: number, ts: number): string {
  const seconds = Math.max(0, Math.floor((ts - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Hover row under a message: copy, branch into a new thread, timestamp. */
function MessageActions({
  text,
  ts,
  startedAt,
  align,
}: {
  text: string;
  ts?: number;
  startedAt?: number;
  align: "left" | "right";
}) {
  const [copied, setCopied] = useState(false);
  const t = useT();
  const showTimestamps = useSettingsStore((s) => s.showTimestamps);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  void timeFormat;
  const time = showTimestamps ? formatTime(ts) : null;
  const elapsed = time && startedAt !== undefined && ts ? formatElapsed(startedAt, ts) : null;
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
      {time && (
        <span className="px-1 text-xs text-text-tertiary tabular-nums">
          {time}
          {elapsed ? ` · ${elapsed}` : ""}
        </span>
      )}
    </div>
  );
}

function UserRow({
  text,
  images,
  ts,
  clampMaxPx,
}: {
  text: string;
  images: { data: string; mimeType: string }[];
  ts?: number;
  clampMaxPx: number;
}) {
  const t = useT();
  const bodyId = useId();
  const bubbleRef = useRef<HTMLDivElement>(null);
  const textBodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const el = textBodyRef.current;
    if (!el) return;
    const measure = () => setOverflowing(el.scrollHeight > clampMaxPx + 8);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [clampMaxPx, text]);

  const toggle = () => {
    const bubble = bubbleRef.current;
    const scroller = bubble?.closest<HTMLElement>("[data-chat-scroll]") ?? null;
    const topBefore = bubble && scroller ? bubble.getBoundingClientRect().top : 0;
    setExpanded((value) => !value);
    if (!bubble || !scroller) return;
    // Collapsing must not jump the reader: keep the bubble's top where it was.
    requestAnimationFrame(() => {
      const delta = bubble.getBoundingClientRect().top - topBefore;
      if (Math.abs(delta) > 1) scroller.scrollTop += delta;
    });
  };

  const clamped = overflowing && !expanded;

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
          <div
            ref={bubbleRef}
            className="relative w-full rounded-(--radius-md) border border-border-subtle bg-surface px-4 py-2.5 text-base text-text-primary"
          >
            <div
              id={bodyId}
              ref={textBodyRef}
              style={clamped ? { maxHeight: `${clampMaxPx}px` } : undefined}
              className={`select-text break-words whitespace-pre-wrap motion-reduce:transition-none ${
                clamped ? "user-message-fade-mask overflow-hidden pb-7" : ""
              }`}
            >
              {text}
            </div>
            {overflowing && (
              <div
                className={
                  expanded
                    ? "mt-2 flex justify-end"
                    : "pointer-events-none absolute inset-x-0 bottom-1 z-10 flex justify-end px-2"
                }
              >
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-controls={bodyId}
                  onClick={toggle}
                  className="pointer-events-auto rounded-(--radius-sm) border border-border-strong bg-surface-raised/95 px-2.5 py-1 text-xs font-medium text-text-primary shadow-sm transition hover:bg-hover focus-visible:shadow-(--focus-ring) focus-visible:outline-none motion-reduce:transition-none"
                >
                  {expanded ? t("chat.showLess") : t("chat.showFullMessage")}
                </button>
              </div>
            )}
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
  ts,
  runStartedAt,
}: {
  text: string;
  streaming: boolean;
  ts?: number;
  runStartedAt?: number;
}) {
  return (
    <div className="group">
      <div className="md text-base text-text-primary">
        <Markdown text={text} streaming={streaming} />
      </div>
      {!streaming && <MessageActions text={text} ts={ts} startedAt={runStartedAt} align="left" />}
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
  const router = useRouter();
  const authRequired = /authentication required|auth_required|sign in|unauthorized/i.test(detail);
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
          {authRequired && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => void router.navigate({ to: "/settings/providers" })}
            >
              <LogIn size={12} />
              {t("settings.signIn.signIn")}
            </Button>
          )}
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
