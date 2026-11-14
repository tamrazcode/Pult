/**
 * IPC-facing domain types (§4.2/§4.3). Shapes mirror the Rust serde models,
 * which serialize camelCase (see src-tauri/src/store/records.rs, events.rs).
 * `AppEvent` matches the backend's `Event`: serde tag = "kind", content =
 * "payload", kind tags are snake_case, payload fields camelCase.
 */

export type ThreadStatus = "draft" | "working" | "waiting" | "snoozed" | "settled";
export type RunStatus = "queued" | "running" | "finished" | "cancelled" | "failed";

export interface Thread {
  id: string;
  projectId: string | null;
  title: string;
  status: ThreadStatus;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  /** Session cwd pinned at creation; null = the global workspace root. */
  workspace?: string | null;
  /** Parent repo when the thread works in a git worktree (M4). */
  mainRepo?: string | null;
  worktreeName?: string | null;
}

export interface Run {
  id: string;
  threadId: string;
  idx: number;
  status: RunStatus;
  instanceId: string;
  model?: string | null;
  mode?: string | null;
  effort?: string | null;
  startedAt: number;
  stoppedAt?: number | null;
  stopReason?: string | null;
  /** Failure detail for crashed runs (diagnostics UI). */
  error?: string | null;
}

/** An image attached to a prompt (base64 payload, mimeType). */
export interface ImageInput {
  data: string;
  mimeType: string;
}

export interface SessionMode {
  id: string;
  name: string;
  description?: string | null;
}

// ---- session config options (M10) ----

export type ConfigOptionValue = string | boolean;

export interface SessionConfigSelectOption {
  value: string;
  name: string;
  description?: string | null;
}

export interface SessionConfigSelectGroup {
  group: string;
  name: string;
  options: SessionConfigSelectOption[];
}

export type SessionConfigSelectOptions = SessionConfigSelectOption[] | SessionConfigSelectGroup[];

export interface SessionConfigSelectOptionDef {
  type: "select";
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  currentValue: string;
  options: SessionConfigSelectOptions;
}

export interface SessionConfigBooleanOptionDef {
  type: "boolean";
  id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  currentValue: boolean;
}

export type SessionConfigOption = SessionConfigSelectOptionDef | SessionConfigBooleanOptionDef;

export interface InstanceInfo {
  id: string;
  displayName: string;
  enabled: boolean;
  driver: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  status: "stopped" | "starting" | "running" | "crashed" | "needs_auth";
  /** From the last handshake: image content blocks accepted in prompts. */
  promptImage: boolean;
  /** From the last handshake: `session/load` supported (resume path). */
  loadSession: boolean;
  /** Session modes the agent advertised (M6 picker; empty until known). */
  modes: SessionMode[];
  /** Session config options (model, thought level, toggles). */
  configOptions: SessionConfigOption[];
  /** Auth methods advertised at the last handshake. */
  authMethods: AuthMethod[];
  /** Why the agent needs sign-in, when it does. */
  authHint?: string | null;
}

/** One configured agent instance (config.toml; M6 agent matrix). */
export interface InstanceSpec {
  id: string;
  displayName: string;
  driver: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Disabled providers stay configured but never spawn (T3-style toggle). */
  enabled: boolean;
}

/** One advertised ACP auth method (agent-managed or terminal). */
export interface AuthMethod {
  type?: string | null;
  id?: string | null;
  name?: string | null;
  description?: string | null;
  /** Terminal-only: extra argv appended to the configured agent invocation. */
  args?: string[];
  /** Terminal-only: env overrides on top of the instance env. */
  env?: Record<string, string>;
}

/** Targeted capability refresh for one instance ("agent:caps"). */
export interface AgentCapsPayload {
  instanceId: string;
  promptImage: boolean;
  loadSession: boolean;
  modes: SessionMode[];
  configOptions: SessionConfigOption[];
  authMethods: AuthMethod[];
  authHint: string | null;
}

/** A known agent CLI found on PATH (providers.detectInstalled). */
export interface DetectedAgent {
  id: string;
  displayName: string;
  command: string;
  suggestedInstanceId: string;
  suggestedCommand: string[] | null;
  notes: string;
}

/** Result of the one-click connect check (spawn → handshake → caps → stop). */
export interface PreflightReport {
  instanceId: string;
  agentName: string;
  agentVersion: string | null;
  loadSession: boolean;
  promptImage: boolean;
  authRequired: boolean;
  /** Detail when the probe failed (shown under "Needs sign-in"). */
  authHint: string | null;
  /** Session config options seen on the probe session (pickers warm). */
  configOptions: SessionConfigOption[];
  /** Auth methods advertised at handshake (sign-in actions). */
  authMethods: AuthMethod[];
}

/** A message waiting in the backend queue for the active run to finish. */
export interface QueueItem {
  id: string;
  threadId: string;
  instanceId: string;
  text: string;
  images: ImageInput[];
  createdAt: number;
}

/** Result of the queue-aware send: either a fresh run or a queue slot. */
export interface SendOutcome {
  run: Run | null;
  queued: boolean;
  queueId: string | null;
}

/** One slash command the agent advertised. */
export interface CommandInfo {
  name: string;
  description: string;
  input?: unknown;
}

/** `threads_get` payload: thread + runs + transcript + queue + live run id. */
export interface ThreadDetail {
  thread: Thread;
  runs: Run[];
  events: AppEvent[];
  queue: QueueItem[];
  /** The thread's live run; a DB-running run without this id is a zombie. */
  activeRunId?: string | null;
  /** Session mode picked for the next run (persisted per thread). */
  desiredMode?: string | null;
  /** Config options picked for the next run (persisted per thread). */
  desiredConfig?: Record<string, ConfigOptionValue>;
}

export interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface PermissionOption {
  optionId: string;
  name: string;
  /** ACP PermissionOptionKind: allow_once | allow_always | reject_once | reject_always. */
  kind: string;
}

export interface EventMeta {
  id: string;
  runId: string;
  seq: number;
  ts: number;
}

export type EventPayloadUnion =
  | { kind: "user_message"; payload: { text: string; images: ImageInput[] } }
  | { kind: "agent_message_delta"; payload: { delta: string } }
  | { kind: "agent_thought_delta"; payload: { delta: string } }
  | {
      kind: "tool_call";
      payload: {
        toolCallId: string;
        title: string;
        /** ACP ToolKind: read | edit | delete | move | search | execute | think | fetch | switch_mode | other. */
        kind: string;
        status: string;
        locations: string[];
        rawInput?: unknown;
      };
    }
  | {
      kind: "tool_call_update";
      payload: {
        toolCallId: string;
        status?: string | null;
        content?: unknown;
        rawOutput?: unknown;
      };
    }
  | { kind: "plan"; payload: { entries: PlanEntry[] } }
  | {
      kind: "approval_request";
      payload: {
        requestId: string;
        toolCallId?: string | null;
        title: string;
        options: PermissionOption[];
      };
    }
  | {
      kind: "approval_response";
      payload: { requestId: string; optionId?: string | null; auto?: boolean | null };
    }
  | {
      kind: "file_changed";
      payload: { path: string; diff: string; added: number; removed: number };
    }
  | {
      kind: "elicitation_request";
      payload: { message: string; detail: unknown };
    }
  | { kind: "mode_change"; payload: { modeId: string } }
  | { kind: "notice"; payload: { level: string; message: string } }
  | { kind: "commands_update"; payload: { commands: CommandInfo[] } }
  | { kind: "session_info"; payload: { title?: string | null } }
  | { kind: "config_options"; payload: { options: SessionConfigOption[] } }
  | {
      kind: "compaction";
      payload: {
        status?: string | null;
        compactionId?: string | null;
        summaryReplace?: string | null;
        summaryAppend?: string | null;
      };
    }
  | { kind: "usage"; payload: { detail: unknown } }
  | { kind: "run_finished"; payload: { stopReason: string; error?: string | null } };

export type AppEvent = EventMeta & EventPayloadUnion;

/** Shape commands reject with (PultError's Serialize impl). */
export interface IpcError {
  code: string;
  message: string;
}

/** Payload of the "run:event" Tauri event. */
export interface RunEventPayload {
  runId: string;
  event: AppEvent;
}

/** Payload of the batched "run:events" Tauri event (streaming coalescing). */
export interface RunEventsPayload {
  runId: string;
  events: AppEvent[];
}

/** Payload of the "agent:process" Tauri event. */
export interface AgentProcessPayload {
  instanceId: string;
  kind: string;
  detail?: string | null;
}

/** Payload of the "queue:update" Tauri event. */
export interface QueueUpdatedPayload {
  threadId: string;
  items: QueueItem[];
}

// ---- git (M4) ----

/** One porcelain status row. */
export interface GitStatusEntry {
  path: string;
  origPath?: string | null;
  indexStatus: string;
  worktreeStatus: string;
}

export interface GitStatus {
  repoRoot: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
}

/** One `diff --git` section split verbatim out of the raw diff. */
export interface DiffFile {
  path: string;
  oldPath?: string | null;
  /** Exact substring of the raw diff (byte-exact acceptance target). */
  raw: string;
  added: number;
  removed: number;
  binary: boolean;
  /** added | deleted | renamed | modified. */
  status: string;
}

export interface GitDiff {
  repoRoot: string;
  base: string;
  raw: string;
  files: DiffFile[];
}

export interface CommitOutcome {
  sha: string;
  filesCommitted: number;
}

export interface PushOutcome {
  output: string;
}

export interface PrOutcome {
  url: string;
}

export interface WorktreeOutcome {
  path: string;
  branch: string;
}

// ---- PTY terminals (M5) ----

export interface PtyInfo {
  terminalId: string;
  threadId: string;
  title: string;
  exit: number | null;
}

/** Payload of the "terminal:pty" Tauri event (base64 PTY bytes). */
export interface PtyOutputPayload {
  terminalId: string;
  threadId: string;
  data: string;
}

/** Payload of the "terminal:ptyExit" Tauri event. */
export interface PtyExitPayload {
  terminalId: string;
  threadId: string;
  exitCode: number | null;
}

// ---- usage report (M12) ----

export interface UsageCost {
  amount: number;
  currency?: string | null;
}

export interface RunUsageRecord {
  runId: string;
  threadId: string;
  threadTitle: string;
  runIdx: number;
  status: string;
  instanceId: string;
  model?: string | null;
  startedAt: number;
  stoppedAt?: number | null;
  usageTs: number;
  used?: number | null;
  size?: number | null;
  cost?: UsageCost | null;
}

export interface ThreadUsageSummary {
  threadId: string;
  threadTitle: string;
  runsWithUsage: number;
  latestRunId: string;
  latestInstanceId: string;
  latestStartedAt: number;
  latestUsed?: number | null;
  latestSize?: number | null;
  peakUsed?: number | null;
  latestCost?: UsageCost | null;
}

export interface InstanceUsageSummary {
  instanceId: string;
  runsWithUsage: number;
  medianUsed?: number | null;
  peakUsed?: number | null;
  latestCost?: UsageCost | null;
  lastUsedAt: number;
}

export interface UsageReport {
  totalRuns: number;
  runs: RunUsageRecord[];
  byThread: ThreadUsageSummary[];
  byInstance: InstanceUsageSummary[];
}
