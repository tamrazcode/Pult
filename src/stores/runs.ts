import { create } from "zustand";
import type {
  AppEvent,
  CommandInfo,
  ConfigOptionValue,
  ImageInput,
  PermissionOption,
  PlanEntry,
  QueueItem,
  Run,
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from "../lib/types";
import { useThreadsStore } from "./threads";

/** A surfaced elicitation awaiting the modal (§5.5). */
export interface ElicitationSurface {
  runId: string;
  requestId: string;
  message: string;
  detail: Record<string, unknown>;
}

/**
 * Run store (§4.2): raw runs per thread plus a RENDER VIEW per run. The view
 * is produced by the pure reducer `applyRunEvent`, so the whole event → UI
 * pipeline is immutable and unit-testable without a backend. Thread-level
 * state from session updates (slash commands, the message queue) lives beside
 * the run views; `session_info` renames feed the threads store directly.
 */

// ---- render model ----

export interface UserChatItem {
  type: "user";
  text: string;
  images: ImageInput[];
  /** Event timestamp (ms) for the hover timestamp. */
  ts?: number;
}

export interface AssistantChatItem {
  type: "assistant";
  text: string;
  streaming: boolean;
  /** Event timestamp (ms) for the hover timestamp. */
  ts?: number;
}

export interface ThoughtChatItem {
  type: "thought";
  text: string;
  streaming: boolean;
  /** Event timestamps bounding the thinking span; duration renders live. */
  startedAt: number;
  endedAt: number;
}

export interface ToolChatItem {
  type: "tool";
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
  locations: string[];
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
}

export interface NoticeChatItem {
  type: "notice";
  level: string;
  message: string;
}

/** Policy trace row: an auto-resolved permission (§5.5, never silent). */
export interface TraceChatItem {
  type: "trace";
  optionId: string;
}

/** One file the agent touched via the fs callbacks. */
export interface FileChange {
  runId: string;
  path: string;
  diff: string;
  added: number;
  removed: number;
}

/** Context compaction divider: one per compactionId, patched in place. */
export interface CompactionChatItem {
  type: "compaction";
  compactionId: string;
  status?: string;
  summary: string;
}

export type ChatItem =
  | UserChatItem
  | AssistantChatItem
  | ThoughtChatItem
  | ToolChatItem
  | NoticeChatItem
  | TraceChatItem
  | CompactionChatItem;

export interface ApprovalRequest {
  requestId: string;
  toolCallId?: string | null;
  title: string;
  options: PermissionOption[];
}

/** `usage_update` detail: context-window fill and optional session cost. */
export interface UsageDetail {
  used?: number;
  size?: number;
  cost?: { amount?: number; currency?: string } | null;
}

export interface RunView {
  items: ChatItem[];
  plan?: PlanEntry[];
  pendingApproval?: ApprovalRequest;
  streaming: boolean;
  stopReason?: string;
  /** Latest session config options (model, thought level, toggles). */
  configOptions?: SessionConfigOption[];
  /** Failure detail from run_finished (crash diagnostics banner). */
  error?: string;
  /** Computed once at run end: latest suggested commit message line. */
  suggestedCommit?: string;
  /** Stored for later milestones; rendered per-thread, not per-run. */
  modeId?: string;
  usage?: UsageDetail;
}

export function emptyRunView(streaming = false): RunView {
  return { items: [], streaming };
}

// ---- reducer helpers ----

function defined<T>(value: T | null | undefined): T | undefined {
  return value === null || value === undefined ? undefined : value;
}

/** Streams only ever carry the trailing text item: close any other open one. */
function closeStreamingText(items: ChatItem[]): ChatItem[] {
  let changed = false;
  const next = items.map((item) => {
    if ((item.type === "assistant" || item.type === "thought") && item.streaming) {
      changed = true;
      return { ...item, streaming: false };
    }
    return item;
  });
  return changed ? next : items;
}

/** Appends a delta to the trailing item of `type`, creating one when the tail
 * is missing or misordered (e.g. text resuming after a tool row). */
function appendTextDelta(
  items: ChatItem[],
  type: "assistant" | "thought",
  delta: string,
  ts: number,
): ChatItem[] {
  const last = items[items.length - 1];
  if (last && last.type === type) {
    const next = [...items];
    if (type === "thought") {
      const thought = last as ThoughtChatItem;
      next[next.length - 1] = { ...thought, text: thought.text + delta, endedAt: ts };
    } else {
      next[next.length - 1] = { ...last, text: last.text + delta };
    }
    return next;
  }
  const closed = closeStreamingText(items);
  return [
    ...closed,
    type === "assistant"
      ? { type: "assistant", text: delta, streaming: true, ts }
      : { type: "thought", text: delta, streaming: true, startedAt: ts, endedAt: ts },
  ];
}

function findToolIndex(items: ChatItem[], toolCallId: string): number {
  return items.findIndex((item) => item.type === "tool" && item.toolCallId === toolCallId);
}

function findCompactionIndex(items: ChatItem[], compactionId: string): number {
  return items.findIndex(
    (item) => item.type === "compaction" && item.compactionId === compactionId,
  );
}

/** Latest "Suggested commit message: …" line, computed once at run end. */
function suggestedCommitFromItems(items: ChatItem[]): string | undefined {
  let suggestion: string | undefined;
  for (const item of items) {
    if (item.type !== "assistant") continue;
    for (const line of item.text.split("\n")) {
      const match = /^suggested commit(?: message)?:\s*(.+)$/i.exec(line.trim());
      if (match) suggestion = match[1].trim();
    }
  }
  return suggestion;
}

/**
 * Pure reducer: folds one run event into a RunView. Never mutates `view`;
 * returns it unchanged when the event carries no render-relevant state.
 */
export function applyRunEvent(view: RunView, event: AppEvent): RunView {
  switch (event.kind) {
    case "user_message":
      return {
        ...view,
        items: [
          ...view.items,
          {
            type: "user",
            text: event.payload.text,
            images: event.payload.images,
            ts: event.ts,
          },
        ],
      };

    case "agent_message_delta":
      return {
        ...view,
        items: appendTextDelta(view.items, "assistant", event.payload.delta, event.ts),
      };

    case "agent_thought_delta":
      return {
        ...view,
        items: appendTextDelta(view.items, "thought", event.payload.delta, event.ts),
      };

    case "tool_call": {
      const payload = event.payload;
      const idx = findToolIndex(view.items, payload.toolCallId);
      if (idx >= 0) {
        // Redelivery of the same tool call: patch the existing row.
        const existing = view.items[idx];
        if (existing.type !== "tool") return view;
        const patched: ToolChatItem = {
          ...existing,
          title: payload.title || existing.title,
          kind: payload.kind || existing.kind,
          status: payload.status || existing.status,
          locations: payload.locations.length > 0 ? payload.locations : existing.locations,
          rawInput: defined(payload.rawInput) ?? existing.rawInput,
        };
        const items = [...view.items];
        items[idx] = patched;
        return { ...view, items };
      }
      const toolItem: ToolChatItem = {
        type: "tool",
        toolCallId: payload.toolCallId,
        title: payload.title,
        kind: payload.kind,
        status: payload.status,
        locations: payload.locations,
        rawInput: defined(payload.rawInput),
      };
      return { ...view, items: [...closeStreamingText(view.items), toolItem] };
    }

    case "tool_call_update": {
      const payload = event.payload;
      const idx = findToolIndex(view.items, payload.toolCallId);
      if (idx < 0) return view; // update without a matching row: nothing to patch
      const existing = view.items[idx];
      if (existing.type !== "tool") return view;
      const patched: ToolChatItem = {
        ...existing,
        status: payload.status ?? existing.status,
        content: defined(payload.content) ?? existing.content,
        rawOutput: defined(payload.rawOutput) ?? existing.rawOutput,
      };
      const items = [...view.items];
      items[idx] = patched;
      return { ...view, items };
    }

    case "plan":
      return { ...view, plan: event.payload.entries };

    case "approval_request":
      return {
        ...view,
        pendingApproval: {
          requestId: event.payload.requestId,
          toolCallId: event.payload.toolCallId ?? null,
          title: event.payload.title,
          options: event.payload.options,
        },
      };

    case "approval_response": {
      const pending = view.pendingApproval;
      if (!pending || pending.requestId !== event.payload.requestId) {
        // No card was showing: the policy resolved this locally — trace row.
        const optionId = event.payload.optionId;
        if (event.payload.auto && optionId) {
          return { ...view, items: [...view.items, { type: "trace", optionId }] };
        }
        return view;
      }
      return { ...view, pendingApproval: undefined };
    }

    case "run_finished": {
      const items = closeStreamingText(view.items);
      const next: RunView = {
        ...view,
        items,
        streaming: false,
        stopReason: event.payload.stopReason,
        pendingApproval: undefined,
      };
      const suggestedCommit = suggestedCommitFromItems(items);
      if (suggestedCommit) next.suggestedCommit = suggestedCommit;
      const error = defined(event.payload.error);
      return error ? { ...next, error } : next;
    }

    case "notice":
      return {
        ...view,
        items: [
          ...view.items,
          { type: "notice", level: event.payload.level, message: event.payload.message },
        ],
      };

    case "compaction": {
      const payload = event.payload;
      const compactionId = payload.compactionId ?? "default";
      const idx = findCompactionIndex(view.items, compactionId);
      const existing = idx >= 0 ? (view.items[idx] as CompactionChatItem) : undefined;
      const summary = defined(payload.summaryReplace);
      const append = defined(payload.summaryAppend);
      const nextSummary =
        summary !== undefined
          ? summary
          : append !== undefined && existing
            ? existing.summary + append
            : append !== undefined
              ? append
              : (existing?.summary ?? "");
      const status = defined(payload.status) ?? existing?.status;
      const item: CompactionChatItem = {
        type: "compaction",
        compactionId,
        status,
        summary: nextSummary,
      };
      const items = [...view.items];
      if (idx >= 0) items[idx] = item;
      else items.push(item);
      return { ...view, items };
    }

    case "mode_change":
      return { ...view, modeId: event.payload.modeId };

    case "usage":
      return { ...view, usage: event.payload.detail as UsageDetail };

    case "config_options":
      return { ...view, configOptions: event.payload.options };

    // Thread-level session state: intercepted by the store before the
    // reducer runs, so the run view itself is unchanged.
    case "commands_update":
    case "session_info":
    case "file_changed":
    case "elicitation_request":
      return view;
  }
}

// ---- selectors ----

/** The run whose view the timeline shows: latest queued/running, else the last run. */
export function activeRunForThread(runs: Run[] | undefined): Run | undefined {
  if (!runs || runs.length === 0) return undefined;
  let active: Run | undefined;
  for (const run of runs) {
    if (run.status === "running" || run.status === "queued") active = run;
  }
  return active ?? runs[runs.length - 1];
}

export interface TimelineRunEntry {
  run: Run;
  view: RunView;
  items: Array<{ key: string; item: ChatItem; showCaret: boolean }>;
}

/** React key: run-scoped so tool/compaction ids never collide across runs. */
function timelineKey(runId: string, item: ChatItem, index: number): string {
  const suffix =
    item.type === "tool"
      ? `tool-${item.toolCallId}`
      : item.type === "compaction"
        ? `comp-${item.compactionId}`
        : `i-${index}`;
  return `${runId}:${suffix}`;
}

/** Every run of a thread, index order, merged into one transcript. */
export function threadTimelineItems(
  runs: Run[] | undefined,
  views: Record<string, RunView>,
): Array<{ key: string; runId: string; item: ChatItem; showCaret: boolean }> {
  if (!runs || runs.length === 0) return [];
  const sorted = [...runs].sort((a, b) => a.idx - b.idx);
  const entries: TimelineRunEntry[] = sorted.map((run) => {
    const view = views[run.id] ?? emptyRunView(false);
    return {
      run,
      view,
      items: view.items.map((item, index) => ({
        key: timelineKey(run.id, item, index),
        item,
        showCaret: false,
      })),
    };
  });
  const rows = entries.flatMap(({ run, items }) =>
    items.map(({ key, item, showCaret }) => ({ key, runId: run.id, item, showCaret })),
  );
  const active = activeRunForThread(sorted);
  const last = rows[rows.length - 1];
  if (last && active && last.runId === active.id && views[active.id]?.streaming) {
    last.showCaret = true;
  }
  return rows;
}

/** Human line for the usage banner: "12.3k / 200k tokens · $0.01". */
export function usageLine(usage: UsageDetail | undefined): string | null {
  if (!usage || typeof usage.used !== "number") return null;
  const used = usage.used >= 1000 ? `${(usage.used / 1000).toFixed(1)}k` : String(usage.used);
  let line =
    typeof usage.size === "number"
      ? `${used} / ${(usage.size / 1000).toFixed(0)}k tokens`
      : `${used} tokens`;
  if (usage.cost && typeof usage.cost.amount === "number" && usage.cost.amount > 0) {
    line += ` · $${usage.cost.amount.toFixed(2)}${usage.cost.currency ? ` ${usage.cost.currency}` : ""}`;
  }
  return line;
}

// ---- store ----

interface RunsState {
  runsByThread: Record<string, Run[]>;
  viewsByRun: Record<string, RunView>;
  /** Event ids already folded into a run view, so re-hydration never replays. */
  appliedEvents: Record<string, Set<string>>;
  /** Slash commands the agent advertised, per thread (composer menu). */
  commandsByThread: Record<string, CommandInfo[]>;
  setElicitation: (surface: ElicitationSurface | null) => void;
  clearElicitation: () => void;
  /** Backend-owned message queue per thread (auto-dispatch on run end). */
  queueByThread: Record<string, QueueItem[]>;
  /** User bubbles shown immediately while the run is dispatching. */
  pendingUserByThread: Record<string, UserChatItem | undefined>;
  setPendingUser: (threadId: string, text: string, images: ImageInput[]) => void;
  clearPendingUser: (threadId: string) => void;
  /** Files the agent touched via fs callbacks (Changed-files projection). */
  filesByThread: Record<string, FileChange[]>;
  /** Currently surfaced elicitation, or null (ElicitationModal). */
  activeElicitation: ElicitationSurface | null;
  /** Mode picked per thread, applied when its next run starts ("" = /chat). */
  desiredModeByThread: Record<string, string>;
  /** Remembers the picker's choice before a run exists. */
  setDesiredMode: (threadId: string, modeId: string) => void;
  /** Config picks per thread ("" = the draft on /chat). */
  desiredConfigByThread: Record<string, Record<string, ConfigOptionValue>>;
  setDesiredConfig: (threadId: string, configId: string, value: ConfigOptionValue) => void;
  /** Drops picks the newly selected provider cannot accept. */
  pruneDesiredConfigForInstance: (slot: string, options: SessionConfigOption[]) => void;
  clearDesiredConfig: (threadId: string) => void;
  /** Upserts a run (from runs_dispatch / threads_get) and seeds its view. */
  registerRun: (run: Run) => void;
  /** Rebuilds all views of a thread from the threads_get transcript. */
  hydrateThread: (
    threadId: string,
    runs: Run[],
    events: AppEvent[],
    queue: QueueItem[],
    activeRunId?: string | null,
    desiredMode?: string | null,
    desiredConfig?: Record<string, ConfigOptionValue>,
  ) => void;
  /** Applies a "run:event" payload; seeds a view for unknown runs. */
  receiveRunEvent: (runId: string, event: AppEvent) => void;
  /** Applies a whole coalesced batch in ONE store notification. */
  receiveRunEventsBatch: (runId: string, events: AppEvent[]) => void;
  /** Replaces the thread's queue ("queue:update" / threads_get). */
  setQueue: (threadId: string, items: QueueItem[]) => void;
  /** Thread id for a run, or null when unknown (event fan-in helpers). */
  runThreadId: (runId: string) => string | null;
  /** Drops all run/queue state of a removed thread (no live run survives it). */
  dropThreadState: (threadId: string) => void;
}

export const useRunsStore = create<RunsState>((set, get) => ({
  runsByThread: {},
  viewsByRun: {},
  appliedEvents: {},
  commandsByThread: {},
  filesByThread: {},
  queueByThread: {},
  pendingUserByThread: {},
  activeElicitation: null,
  desiredModeByThread: {},
  desiredConfigByThread: {},

  runThreadId: (runId) => {
    for (const [threadId, runs] of Object.entries(get().runsByThread)) {
      if (runs.some((r) => r.id === runId)) return threadId;
    }
    return null;
  },

  dropThreadState: (threadId) =>
    set((s) => {
      const runIds = new Set((s.runsByThread[threadId] ?? []).map((r) => r.id));
      const viewsByRun = Object.fromEntries(
        Object.entries(s.viewsByRun).filter(([id]) => !runIds.has(id)),
      );
      const appliedEvents = Object.fromEntries(
        Object.entries(s.appliedEvents).filter(([id]) => !runIds.has(id)),
      );
      const runsByThread = { ...s.runsByThread };
      delete runsByThread[threadId];
      const queueByThread = { ...s.queueByThread };
      delete queueByThread[threadId];
      const desiredModeByThread = { ...s.desiredModeByThread };
      delete desiredModeByThread[threadId];
      const desiredConfigByThread = { ...s.desiredConfigByThread };
      delete desiredConfigByThread[threadId];
      const commandsByThread = { ...s.commandsByThread };
      delete commandsByThread[threadId];
      const filesByThread = { ...s.filesByThread };
      delete filesByThread[threadId];
      const activeElicitation =
        s.activeElicitation && runIds.has(s.activeElicitation.runId) ? null : s.activeElicitation;
      return {
        runsByThread,
        viewsByRun,
        appliedEvents,
        queueByThread,
        desiredModeByThread,
        desiredConfigByThread,
        commandsByThread,
        filesByThread,
        activeElicitation,
      };
    }),

  registerRun: (run) =>
    set((s) => {
      const runs = s.runsByThread[run.threadId] ?? [];
      const exists = runs.some((r) => r.id === run.id);
      const nextRuns = exists
        ? runs.map((r) => (r.id === run.id ? run : r))
        : [...runs, run].sort((a, b) => a.idx - b.idx);
      const viewsByRun = { ...s.viewsByRun };
      if (!exists && !(run.id in viewsByRun)) {
        viewsByRun[run.id] = emptyRunView(run.status === "running" || run.status === "queued");
      }
      // The real run exists now; the optimistic bubble is replaced by its
      // user_message event (which arrives right after run:started).
      const { [run.threadId]: _dropped, ...pendingUserByThread } = s.pendingUserByThread;
      void _dropped;
      return {
        runsByThread: { ...s.runsByThread, [run.threadId]: nextRuns },
        viewsByRun,
        pendingUserByThread,
      };
    }),

  setPendingUser: (threadId, text, images) =>
    set((s) => ({
      pendingUserByThread: {
        ...s.pendingUserByThread,
        [threadId]: { type: "user", text, images, ts: Date.now() },
      },
    })),

  clearPendingUser: (threadId) =>
    set((s) => {
      if (!(threadId in s.pendingUserByThread)) return s;
      const { [threadId]: _dropped, ...pendingUserByThread } = s.pendingUserByThread;
      void _dropped;
      return { pendingUserByThread };
    }),

  hydrateThread: (threadId, runs, events, queue, activeRunId, desiredMode, desiredConfig) =>
    set((s) => {
      // Merge, don't replace: a threads_get snapshot taken before a local
      // runs_dispatch resolved may lack the run that is already streaming.
      // Fetched records win (authoritative status); local extras survive.
      const byId = new Map((s.runsByThread[threadId] ?? []).map((r) => [r.id, r]));
      for (const r of runs) {
        const local = byId.get(r.id);
        // A stale snapshot must not resurrect a run the live stream already
        // finished (threads_get reads runs and the active id non-atomically).
        const localDone =
          local !== undefined && local.status !== "running" && local.status !== "queued";
        const fetchedLive = r.status === "running" || r.status === "queued";
        byId.set(r.id, localDone && fetchedLive ? local : r);
      }
      // A run the DB calls active but the runtime no longer holds died with
      // the previous app session: mark it interrupted (crash diagnostics).
      const records = [...byId.values()].map((r) =>
        (r.status === "running" || r.status === "queued") && r.id !== activeRunId
          ? {
              ...r,
              status: "failed" as const,
              stopReason: r.stopReason ?? "failed",
              error: r.error ?? "pult restarted while this run was active",
            }
          : r,
      );
      const sorted = records.sort((a, b) => a.idx - b.idx);
      const viewsByRun = { ...s.viewsByRun };
      const appliedEvents = { ...s.appliedEvents };
      for (const run of sorted) {
        const runEvents = events.filter((e) => e.runId === run.id).sort((a, b) => a.seq - b.seq);
        let view =
          viewsByRun[run.id] ?? emptyRunView(run.status === "running" || run.status === "queued");
        const applied = new Set(appliedEvents[run.id] ?? []);
        for (const e of runEvents) {
          if (applied.has(e.id)) continue;
          view = applyRunEvent(view, e);
          applied.add(e.id);
        }
        appliedEvents[run.id] = applied;
        if (run.status !== "running" && run.status !== "queued") {
          view = {
            ...view,
            items: closeStreamingText(view.items),
            streaming: false,
            pendingApproval: undefined,
          };
          if (!view.stopReason && run.stopReason) view = { ...view, stopReason: run.stopReason };
          if (!view.error && run.error) view = { ...view, error: run.error };
        }
        viewsByRun[run.id] = view;
      }
      // Thread-level session state replays from the transcript too.
      let commands = s.commandsByThread[threadId];
      const files: FileChange[] = [];
      for (const e of events) {
        if (e.kind === "commands_update") commands = e.payload.commands;
        if (e.kind === "file_changed") {
          const i = files.findIndex((f) => f.path === e.payload.path);
          const change: FileChange = {
            runId: e.runId,
            path: e.payload.path,
            diff: e.payload.diff,
            added: e.payload.added,
            removed: e.payload.removed,
          };
          if (i >= 0) files[i] = change;
          else files.push(change);
        }
      }
      return {
        runsByThread: { ...s.runsByThread, [threadId]: sorted },
        viewsByRun,
        appliedEvents,
        commandsByThread:
          commands !== undefined
            ? { ...s.commandsByThread, [threadId]: commands }
            : s.commandsByThread,
        filesByThread: { ...s.filesByThread, [threadId]: files },
        queueByThread: { ...s.queueByThread, [threadId]: queue },
        desiredModeByThread:
          desiredMode && desiredMode !== s.desiredModeByThread[threadId]
            ? { ...s.desiredModeByThread, [threadId]: desiredMode }
            : s.desiredModeByThread,
        desiredConfigByThread:
          desiredConfig && Object.keys(desiredConfig).length > 0
            ? { ...s.desiredConfigByThread, [threadId]: desiredConfig }
            : s.desiredConfigByThread,
      };
    }),

  receiveRunEventsBatch: (runId, events) =>
    set((s) => {
      if (events.length === 0) return s;
      const threadId = threadIdForRun(s, runId);
      let view = s.viewsByRun[runId] ?? emptyRunView(true);
      let runsByThread = s.runsByThread;
      let commandsByThread = s.commandsByThread;
      let applied: Set<string> | null = null;
      let viewChanged = false;
      for (const event of events) {
        // Thread-level session state: slash commands and agent-chosen titles.
        if (event.kind === "commands_update") {
          if (!threadId) continue;
          commandsByThread = { ...commandsByThread, [threadId]: event.payload.commands };
          continue;
        }
        if (event.kind === "session_info") {
          const title = event.payload.title?.trim();
          if (threadId && title) useThreadsStore.getState().renameThreadLocal(threadId, title);
          continue;
        }
        const seen: Set<string> | undefined = applied ?? s.appliedEvents[runId];
        if (seen?.has(event.id)) continue;
        applied ??= new Set(seen ?? []);
        view = applyRunEvent(view, event);
        applied.add(event.id);
        viewChanged = true;
        // Keep the run record's status live: run_finished arrives as an event
        // before any threads_get refresh, and the composer reads record status.
        if (event.kind === "run_finished") {
          const status =
            event.payload.stopReason === "cancelled"
              ? "cancelled"
              : event.payload.stopReason === "failed"
                ? "failed"
                : "finished";
          runsByThread = mapRunRecord(runsByThread, runId, (r) => ({
            ...r,
            status,
            stopReason: event.payload.stopReason,
            error: event.payload.error ?? r.error,
          }));
        }
      }
      if (!viewChanged && commandsByThread === s.commandsByThread) return s;
      return {
        runsByThread,
        viewsByRun: viewChanged ? { ...s.viewsByRun, [runId]: view } : s.viewsByRun,
        appliedEvents: applied ? { ...s.appliedEvents, [runId]: applied } : s.appliedEvents,
        commandsByThread,
      };
    }),

  receiveRunEvent: (runId, event) => get().receiveRunEventsBatch(runId, [event]),

  setQueue: (threadId, items) =>
    set((s) => ({ queueByThread: { ...s.queueByThread, [threadId]: items } })),
  setElicitation: (surface) => set({ activeElicitation: surface }),
  clearElicitation: () => set({ activeElicitation: null }),
  setDesiredMode: (threadId, modeId) =>
    set((s) => ({
      desiredModeByThread: { ...s.desiredModeByThread, [threadId]: modeId },
    })),
  setDesiredConfig: (threadId, configId, value) =>
    set((s) => ({
      desiredConfigByThread: {
        ...s.desiredConfigByThread,
        [threadId]: { ...s.desiredConfigByThread[threadId], [configId]: value },
      },
    })),
  pruneDesiredConfigForInstance: (slot, options) =>
    set((s) => {
      const current = s.desiredConfigByThread[slot];
      if (!current) return s;
      const next: Record<string, ConfigOptionValue> = {};
      for (const [id, value] of Object.entries(current)) {
        const option = options.find((candidate) => candidate.id === id);
        if (option && configValueFits(option, value)) next[id] = value;
      }
      const desiredConfigByThread = { ...s.desiredConfigByThread };
      if (Object.keys(next).length === 0) delete desiredConfigByThread[slot];
      else desiredConfigByThread[slot] = next;
      return { desiredConfigByThread };
    }),
  clearDesiredConfig: (threadId) =>
    set((s) => {
      const desiredConfigByThread = { ...s.desiredConfigByThread };
      delete desiredConfigByThread[threadId];
      return { desiredConfigByThread };
    }),
}));

/** True when a persisted value is still one of the option's advertised values. */
function configValueFits(option: SessionConfigOption, value: ConfigOptionValue): boolean {
  if (option.type === "boolean") return typeof value === "boolean";
  if (typeof value !== "string") return false;
  const first = option.options[0];
  const flat =
    first && "group" in first
      ? (option.options as SessionConfigSelectGroup[]).flatMap((group) => group.options)
      : (option.options as SessionConfigSelectOption[]);
  return flat.some((candidate) => candidate.value === value);
}

function threadIdForRun(
  s: { runsByThread: Record<string, Run[]> },
  runId: string,
): string | undefined {
  for (const [threadId, runs] of Object.entries(s.runsByThread)) {
    if (runs.some((r) => r.id === runId)) return threadId;
  }
  return undefined;
}

/** Patches one run record in place (immutably) across all threads. */
function mapRunRecord(
  runsByThread: Record<string, Run[]>,
  runId: string,
  patch: (run: Run) => Run,
): Record<string, Run[]> {
  let changed = false;
  const next: Record<string, Run[]> = {};
  for (const [threadId, runs] of Object.entries(runsByThread)) {
    if (!runs.some((r) => r.id === runId)) {
      next[threadId] = runs;
      continue;
    }
    changed = true;
    next[threadId] = runs.map((r) => (r.id === runId ? patch(r) : r));
  }
  return changed ? next : runsByThread;
}
