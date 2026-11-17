import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { isTauri } from "./tauri";
import { localizeIpcError } from "./i18n";
import type {
  AgentProcessPayload,
  CommitOutcome,
  ConfigOptionValue,
  DetectedAgent,
  DiffFile,
  DelegatedTask,
  GitDiff,
  GitDiffSummary,
  GitStatus,
  ImageInput,
  InstanceInfo,
  InstanceSpec,
  IpcError,
  McpBinding,
  McpImportOutcome,
  McpProbeResult,
  McpServer,
  McpServerInput,
  McpServerStats,
  PrOutcome,
  Project,
  PtyExitPayload,
  PtyInfo,
  PtyOutputPayload,
  PushOutcome,
  PreflightReport,
  ProcessNode,
  ProviderModelPrefs,
  QueueUpdatedPayload,
  RememberedPermission,
  Run,
  AgentCapsPayload,
  RunEventPayload,
  RunEventsPayload,
  SendOutcome,
  Thread,
  ThreadDetail,
  UsageReport,
  WorktreeDirtyStatus,
} from "./types";

/**
 * Hand-written wrappers over the Rust command surface (§4.3, M1 subset).
 * Every invoke/listen is guarded: in a plain browser tab (`pnpm dev`, no
 * Tauri runtime) reads resolve to empty fallbacks, mutations reject with
 * `IpcUnavailableError`, and event subscriptions resolve to a no-op.
 */

class IpcUnavailableError extends Error {
  readonly code = "ipc_unavailable";
  constructor(command: string) {
    super(`${command} requires the Tauri runtime`);
    this.name = "IpcUnavailableError";
  }
}

export function isIpcError(error: unknown): error is IpcError {
  if (typeof error !== "object" || error === null) return false;
  const e = error as Record<string, unknown>;
  return typeof e.code === "string" && typeof e.message === "string";
}

/** Human-readable line for inline notices (M1 surfaces errors inline, no toasts). */
export function ipcErrorMessage(error: unknown): string {
  // Structured codes get the active locale; unknown errors keep the backend
  // message. Every existing call site localizes for free.
  return localizeIpcError(error);
}

function invokeRequired<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) return Promise.reject(new IpcUnavailableError(command));
  return invoke<T>(command, args);
}

function invokeWithFallback<T>(
  command: string,
  fallback: T,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauri()) return Promise.resolve(fallback);
  return invoke<T>(command, args);
}

function listenOrNoop<T>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (!isTauri()) return Promise.resolve(() => {});
  return listen<T>(event, (e) => handler(e.payload));
}

/** Proves the IPC bridge end-to-end; empty string outside the Tauri runtime. */
export async function appVersion(): Promise<string> {
  return invokeWithFallback<string>("app_version", "");
}

export interface AppUpdateInfo {
  version: string;
  currentVersion: string;
  body: string | null;
}

/** Null means the app is up to date (or no release feed is configured yet). */
export function appUpdateCheck(): Promise<AppUpdateInfo | null> {
  return invokeRequired<AppUpdateInfo | null>("app_update_check", {});
}

/** Downloads, installs silently, and restarts the app. */
export function appUpdateInstall(): Promise<void> {
  return invokeRequired<void>("app_update_install", {});
}

export function onAppUpdateProgress(
  handler: (payload: { downloaded: number; total: number | null }) => void,
): Promise<UnlistenFn> {
  return listenOrNoop<{ downloaded: number; total: number | null }>("app:updateProgress", handler);
}

/** Native OS notification (Windows toast / macOS / Linux). */
export function appNotify(title: string, body: string): Promise<void> {
  return invokeRequired<void>("app_notify", { title, body });
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string | null;
  author: string | null;
  path: string;
  enabled: boolean;
  commands: string[];
  slots: string[];
}

export interface PluginList {
  dir: string;
  plugins: PluginInfo[];
}

export function pluginsList(): Promise<PluginList> {
  return invokeWithFallback<PluginList>("plugins_list", { dir: "", plugins: [] });
}

export function pluginsSetEnabled(id: string, enabled: boolean): Promise<void> {
  return invokeRequired<void>("plugins_set_enabled", { id, enabled });
}

// ---- threads ----

/**
 * Creates a thread. `workspace` pins the session cwd; with `worktree` the
 * thread works in a fresh git worktree of the repo containing `workspace`
 * (or the global root) — isolated changes, cleaned up on delete.
 */
export function threadsCreate(
  projectId: string | null,
  title: string,
  workspace?: string | null,
  worktree?: boolean | null,
): Promise<Thread> {
  return invokeRequired<Thread>("threads_create", {
    projectId,
    title,
    workspace,
    worktree: worktree ?? null,
  });
}

export function threadsList(): Promise<Thread[]> {
  return invokeWithFallback<Thread[]>("threads_list", []);
}

// ---- projects ----

export function projectsList(): Promise<Project[]> {
  return invokeWithFallback<Project[]>("projects_list", []);
}

export function projectsCreate(
  name: string,
  rootPath: string,
  color?: string | null,
  worktreeStrategy?: "root" | "worktree",
): Promise<Project> {
  return invokeRequired<Project>("projects_create", {
    name,
    rootPath,
    color,
    worktreeStrategy,
  });
}

export function projectsUpdate(
  id: string,
  patch: {
    name?: string;
    color?: string | null;
    worktreeStrategy?: "root" | "worktree";
    pinned?: boolean;
  },
): Promise<Project> {
  return invokeRequired<Project>("projects_update", { id, ...patch });
}

export function projectsDelete(id: string): Promise<void> {
  return invokeRequired<void>("projects_delete", { id });
}

/** Reads a local raster image as a data URL (Markdown image artifacts). */
export function readImageDataUrl(path: string, threadId?: string): Promise<string> {
  return invokeRequired<string>("read_image_data_url", { path, threadId: threadId ?? null });
}

export interface AttachmentStatus {
  path: string;
  exists: boolean;
  size: number | null;
}

/** Saves a pasted image under ~/.pult/attachments and returns its path. */
export function attachmentsSaveImage(data: string, mimeType: string): Promise<string> {
  return invokeRequired<string>("attachments_save_image", { data, mimeType });
}

/** Saves a text attachment under ~/.pult/attachments and returns its path. */
export function attachmentsSaveText(name: string, text: string): Promise<string> {
  return invokeRequired<string>("attachments_save_text", { name, text });
}

export function attachmentsCheckPaths(paths: string[]): Promise<AttachmentStatus[]> {
  return invokeRequired<AttachmentStatus[]>("attachments_check_paths", { paths });
}

/** Native folder picker; null outside Tauri or when the user cancels. */
export async function pickFolder(title = "Choose folder"): Promise<string | null> {
  if (!isTauri()) return null;
  const result = await openDialog({ directory: true, multiple: false, title });
  return typeof result === "string" ? result : null;
}

export function threadsGet(threadId: string): Promise<ThreadDetail> {
  return invokeRequired<ThreadDetail>("threads_get", { threadId });
}

export function threadsRename(threadId: string, title: string): Promise<void> {
  return invokeRequired<void>("threads_rename", { threadId, title });
}

export function threadsSetStatus(threadId: string, status: Thread["status"]): Promise<void> {
  return invokeRequired<void>("threads_set_status", { threadId, status });
}

export function threadsSetPinned(threadId: string, pinned: boolean): Promise<void> {
  return invokeRequired<void>("threads_set_pinned", { threadId, pinned });
}

/**
 * `keep` leaves the worktree on disk, `force_remove` discards its files,
 * `safe` (default) refuses to delete a dirty worktree.
 */
export function threadsDelete(
  threadId: string,
  worktreeMode?: "safe" | "keep" | "force_remove",
): Promise<void> {
  return invokeRequired<void>("threads_delete", {
    threadId,
    worktreeMode: worktreeMode ?? null,
  });
}

/** Dirty/untracked files in the thread's worktree (null when it has none). */
export function threadsWorktreeStatus(threadId: string): Promise<WorktreeDirtyStatus | null> {
  return invokeWithFallback<WorktreeDirtyStatus | null>("threads_worktree_status", null, {
    threadId,
  });
}

/** Flattened workspace tree for the Files surface (capped, ignored dirs). */
export interface WorkspaceEntry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
}

export interface WorkspaceTree {
  entries: WorkspaceEntry[];
  truncated: boolean;
}

export function workspaceTree(threadId: string): Promise<WorkspaceTree> {
  return invokeRequired<WorkspaceTree>("workspace_tree", { threadId });
}

/** Absolute root for threads without a project (`PULT_WORKSPACE` or `~/pult-workspace`). */
export function workspaceGlobalRoot(): Promise<string | null> {
  return invokeWithFallback<string | null>("workspace_global_root", null);
}

/** UTF-8 text preview from a thread workspace (max 512 KB). */
export function workspaceReadText(threadId: string, path: string): Promise<string> {
  return invokeRequired<string>("workspace_read_text", { threadId, path });
}

/** Raw HTML for the built-in browser surface. */
export function workspaceReadHtml(threadId: string, path: string): Promise<string> {
  return invokeRequired<string>("workspace_read_html", { threadId, path });
}

export interface BrowserTarget {
  kind: "url" | "file";
  target: string;
}

export interface EmbedCheck {
  embeddable: boolean;
  reason?: string | null;
}

/** Classifies a browser target as an http(s) URL or a workspace HTML file. */
export function browserValidateTarget(target: string): Promise<BrowserTarget> {
  return invokeRequired<BrowserTarget>("browser_validate_target", { target });
}

/** Checks X-Frame-Options / CSP before mounting an iframe. */
export function browserCheckFrameHeaders(url: string): Promise<EmbedCheck> {
  return invokeRequired<EmbedCheck>("browser_check_frame_headers", { url });
}

/**
 * Native child webview: any http(s) URL, or a local path (absolute,
 * workspace-relative, or file://). Local files are served from a token-scoped
 * loopback server so modules and relative assets resolve.
 */
export function browserNavigate(target: string, threadId?: string | null): Promise<string> {
  return invokeRequired<string>("browser_navigate", { target, threadId: threadId ?? null });
}

export function browserSetBounds(bounds: {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}): Promise<void> {
  return invokeRequired<void>("browser_set_bounds", bounds);
}

export function browserHistory(action: "back" | "forward" | "reload"): Promise<void> {
  return invokeRequired<void>("browser_history", { action });
}

export function browserClose(): Promise<void> {
  return invokeRequired<void>("browser_close");
}

/** Current child-webview URL (panel remounts restore the page). */
export function browserState(): Promise<string | null> {
  return invokeWithFallback<string | null>("browser_state", null);
}

/** Payload of the "browser:navigated" event emitted by the child webview. */
export interface BrowserNavigatedPayload {
  url: string;
  event: "started" | "finished";
}

export function onBrowserNavigated(
  handler: (payload: BrowserNavigatedPayload) => void,
): Promise<UnlistenFn> {
  return listenOrNoop<BrowserNavigatedPayload>("browser:navigated", handler);
}

/**
 * Workspace-relative files for composer `@` mentions (build/VCS dirs are
 * skipped server-side). Empty outside Tauri.
 */
export function workspaceFiles(params: {
  threadId?: string;
  workspace?: string;
  query?: string;
}): Promise<string[]> {
  return invokeWithFallback<string[]>("workspace_files", [], params);
}

// ---- runs ----

/**
 * Queue-aware send: starts a turn, or — while a run is active — stores the
 * message in the backend queue (auto-dispatched when the run finishes).
 */
export function runsDispatch(
  threadId: string,
  text: string,
  instanceId: string,
  images: ImageInput[] = [],
  mode?: string | null,
  configOptions?: Record<string, ConfigOptionValue> | null,
): Promise<SendOutcome> {
  return invokeRequired<SendOutcome>("runs_dispatch", {
    threadId,
    text,
    images,
    instanceId,
    mode: mode ?? null,
    configOptions: configOptions ?? null,
  });
}

/** Applies one session config option now and remembers it for the next run. */
export function runsSetConfigOption(
  threadId: string,
  configId: string,
  value: ConfigOptionValue,
): Promise<void> {
  return invokeRequired<void>("runs_set_config_option", { threadId, configId, value });
}

/** `force` skips the cancel grace period and kills the agent process. */
export function runsCancel(runId: string, force = false): Promise<void> {
  return invokeRequired<void>("runs_cancel", { runId, force });
}

/** Persisted allow_always decisions (Settings ▸ General revoke list). */
export function permissionsRememberedList(): Promise<RememberedPermission[]> {
  return invokeWithFallback<RememberedPermission[]>("permissions_remembered_list", []);
}

export function permissionsRememberedClear(filters?: {
  workspace?: string;
  instanceId?: string;
  toolKind?: string;
}): Promise<void> {
  return invokeRequired<void>("permissions_remembered_clear", {
    workspace: filters?.workspace ?? null,
    instanceId: filters?.instanceId ?? null,
    toolKind: filters?.toolKind ?? null,
  });
}

/** config.toml read/parse failure shown in Providers (null when healthy). */
export function providersConfigStatus(): Promise<string | null> {
  return invokeWithFallback<string | null>("providers_config_status", null);
}

/** Payload of the "elicitation:request" Tauri event. */
export interface ElicitationRequestPayload {
  runId: string;
  requestId: string;
  message: string;
  detail: unknown;
}

/** Removes one message from the thread's queue (composer row ✕). */
export function runsQueueRemove(threadId: string, queueId: string): Promise<void> {
  return invokeRequired<void>("runs_queue_remove", { threadId, queueId });
}

/** Rewrites one queued message in place. */
export function runsQueueUpdate(threadId: string, queueId: string, text: string): Promise<void> {
  return invokeRequired<void>("runs_queue_update", { threadId, queueId, text });
}

/** Persists the queue order after a drag. */
export function runsQueueReorder(threadId: string, queueIds: string[]): Promise<void> {
  return invokeRequired<void>("runs_queue_reorder", { threadId, queueIds });
}

/** Sends a queued message now, interrupting the active run. */
export function runsQueueSteer(threadId: string, queueId: string): Promise<void> {
  return invokeRequired<void>("runs_queue_steer", { threadId, queueId });
}

/** Switches the thread's permission mode (also stored as the default). */
export function runsSetPermissionMode(threadId: string, mode: string): Promise<void> {
  return invokeRequired<void>("runs_set_permission_mode", { threadId, mode });
}

/** Answers a permission request; `optionId: null` cancels it. */
export function runsRespondPermission(
  runId: string,
  requestId: string,
  optionId: string | null,
): Promise<void> {
  return invokeRequired<void>("runs_respond_permission", { runId, requestId, optionId });
}

export function runsRespondElicitation(
  runId: string,
  requestId: string,
  action: "accept" | "decline" | "cancel",
  content?: unknown,
): Promise<void> {
  return invokeRequired<void>("runs_respond_elicitation", { runId, requestId, action, content });
}

// ---- providers ----

export function providersInstancesList(): Promise<InstanceInfo[]> {
  return invokeWithFallback<InstanceInfo[]>("providers_instances_list", []);
}

/** Known agent CLIs found on PATH (M6 onboarding). */
export function providersDetectInstalled(): Promise<DetectedAgent[]> {
  return invokeWithFallback<DetectedAgent[]>("providers_detect_installed", []);
}

/** Installs a known provider CLI globally through npm (fixed package map). */
export function providersInstall(provider: string): Promise<string> {
  return invokeRequired<string>("providers_install", { provider });
}

/** Opens an interactive provider login in a visible terminal. */
export function providersLogin(provider: string): Promise<void> {
  return invokeRequired<void>("providers_login", { provider });
}

/** One-click connect check: spawn → handshake → cache caps → shut down. */
export function providersPreflight(instanceId: string): Promise<PreflightReport> {
  return invokeRequired<PreflightReport>("providers_preflight", { instanceId });
}

/** Pre-spawns the selected provider so the first message skips cold start. */
export function providersWarmup(instanceId: string, workspace?: string | null): Promise<void> {
  return invokeRequired<void>("providers_warmup", { instanceId, workspace });
}

export interface ProviderUpdate {
  instanceId: string;
  displayName: string;
  package: string | null;
  current: string | null;
  latest: string | null;
  managed: boolean;
}

/** Checks npm-distributed provider CLIs for newer global versions. */
export function providersUpdateCheck(): Promise<ProviderUpdate[]> {
  return invokeRequired<ProviderUpdate[]>("providers_update_check");
}

/** Installs the verified latest version of one provider package. */
export function providersUpdateInstall(instanceId: string): Promise<void> {
  return invokeRequired<void>("providers_update_install", { instanceId });
}

/** Agent-managed sign-in: authenticate + session re-probe. */
export function providersAuthenticate(
  instanceId: string,
  methodId: string,
): Promise<PreflightReport> {
  return invokeRequired<PreflightReport>("providers_authenticate", { instanceId, methodId });
}

/** Read-only usage report (last ACP usage snapshot per run). */
export function usageReport(): Promise<UsageReport> {
  return invokeWithFallback<UsageReport>("usage_report", {
    totalRuns: 0,
    runs: [],
    byThread: [],
    byInstance: [],
  });
}

/** Rewrites the agent matrix (config.toml) and swaps the live registry. */
export function providersInstancesSave(instances: InstanceSpec[]): Promise<void> {
  return invokeRequired<void>("providers_instances_save", { instances });
}

/** Switches the active run's session mode (agent echoes a mode_change). */
export function runsSetMode(threadId: string, modeId: string): Promise<void> {
  return invokeRequired<void>("runs_set_mode", { threadId, modeId });
}

/** Last raw protocol frames of the instance's live connection (M6). */
export function diagnosticsFrames(instanceId: string): Promise<string[]> {
  return invokeRequired<string[]>("diagnostics_frames", { instanceId });
}

/** Opens a project folder/file in the chosen editor or the OS file manager. */
export function openInEditor(path: string, editor?: string | null): Promise<void> {
  return invokeRequired<void>("open_in_editor", { path, editor });
}

/** Opens an http(s) link in the system browser (external, never a shell). */
export function openExternalUrl(url: string): Promise<void> {
  const target = url.trim();
  if (!/^https?:\/\//i.test(target)) {
    return Promise.reject(new Error("only http(s) links can be opened"));
  }
  if (!isTauri()) {
    window.open(target, "_blank", "noopener,noreferrer");
    return Promise.resolve();
  }
  return invokeRequired<void>("open_external_url", { url: target });
}

// ---- settings (§4.5) ----

/** Reads one JSON setting; null outside Tauri or when unset. */
export function settingsGet(key: string): Promise<unknown | null> {
  return invokeWithFallback<unknown | null>("settings_get", null, { key });
}

/** Writes one JSON setting of any shape. */
export function settingsSet(key: string, value: unknown): Promise<void> {
  return invokeRequired<void>("settings_set", { key, value });
}

// ---- git (M4) ----

export function gitStatus(threadId: string): Promise<GitStatus> {
  return invokeRequired<GitStatus>("git_status", { threadId });
}

export function gitDiff(threadId: string, base?: string | null): Promise<GitDiff> {
  return invokeRequired<GitDiff>("git_diff", { threadId, base });
}

export function gitDiffSummary(threadId: string, base?: string | null): Promise<GitDiffSummary> {
  return invokeRequired<GitDiffSummary>("git_diff_summary", { threadId, base });
}

export function gitDiffFile(
  threadId: string,
  path: string,
  base?: string | null,
): Promise<DiffFile> {
  return invokeRequired<DiffFile>("git_diff_file", { threadId, path, base });
}

export function gitCommit(threadId: string, message: string): Promise<CommitOutcome> {
  return invokeRequired<CommitOutcome>("git_commit", { threadId, message });
}

export function gitPush(threadId: string): Promise<PushOutcome> {
  return invokeRequired<PushOutcome>("git_push", { threadId });
}

export function gitPrCreate(threadId: string, title: string, body: string): Promise<PrOutcome> {
  return invokeRequired<PrOutcome>("git_pr_create", { threadId, title, body });
}

export function gitGhAvailable(): Promise<boolean> {
  return invokeWithFallback<boolean>("git_gh_available", false);
}

export function gitCheckpoint(threadId: string, runId: string): Promise<string> {
  return invokeRequired<string>("git_checkpoint", { threadId, runId });
}

// ---- PTY terminals (M5) ----

/** Spawns a PTY in the thread workspace (default shell: powershell -NoLogo). */
export function terminalPtyCreate(
  threadId: string,
  command?: string[] | null,
  rows = 24,
  cols = 80,
): Promise<PtyInfo> {
  return invokeRequired<PtyInfo>("terminal_pty_create", {
    threadId,
    command,
    rows,
    cols,
  });
}

/** Writes raw user input (base64 of the UTF-8 bytes) into the PTY. */
export function terminalPtyWrite(terminalId: string, dataB64: string): Promise<void> {
  return invokeRequired<void>("terminal_pty_write", { terminalId, data: dataB64 });
}

export function terminalPtyResize(terminalId: string, rows: number, cols: number): Promise<void> {
  return invokeRequired<void>("terminal_pty_resize", { terminalId, rows, cols });
}

export function terminalPtyKill(terminalId: string): Promise<void> {
  return invokeRequired<void>("terminal_pty_kill", { terminalId });
}

export function terminalPtyList(threadId: string): Promise<PtyInfo[]> {
  return invokeWithFallback<PtyInfo[]>("terminal_pty_list", [], { threadId });
}

export function onPtyOutput(handler: (payload: PtyOutputPayload) => void): Promise<UnlistenFn> {
  return listenOrNoop<PtyOutputPayload>("terminal:pty", handler);
}

export function onPtyExit(handler: (payload: PtyExitPayload) => void): Promise<UnlistenFn> {
  return listenOrNoop<PtyExitPayload>("terminal:ptyExit", handler);
}

// ---- events ----

export function onRunEvent(handler: (payload: RunEventPayload) => void): Promise<UnlistenFn> {
  return listenOrNoop<RunEventPayload>("run:event", handler);
}

export function onRunEvents(handler: (payload: RunEventsPayload) => void): Promise<UnlistenFn> {
  return listenOrNoop<RunEventsPayload>("run:events", handler);
}

export function onAgentCaps(handler: (payload: AgentCapsPayload) => void): Promise<UnlistenFn> {
  return listenOrNoop<AgentCapsPayload>("agent:caps", handler);
}

export function onThreadUpdate(handler: (thread: Thread) => void): Promise<UnlistenFn> {
  return listenOrNoop<{ thread: Thread }>("thread:update", (payload) => handler(payload.thread));
}

export function onAgentProcess(
  handler: (payload: AgentProcessPayload) => void,
): Promise<UnlistenFn> {
  return listenOrNoop<AgentProcessPayload>("agent:process", handler);
}

export function onQueueUpdate(
  handler: (payload: QueueUpdatedPayload) => void,
): Promise<UnlistenFn> {
  return listenOrNoop<QueueUpdatedPayload>("queue:update", handler);
}

/** Payload of the "run:started" Tauri event (backend-created runs). */
export function onRunStarted(handler: (run: Run) => void): Promise<UnlistenFn> {
  return listenOrNoop<{ run: Run }>("run:started", (payload) => handler(payload.run));
}

export interface SubagentSpawnedPayload {
  task: DelegatedTask;
  parentThreadId: string;
  parentRunId: string;
}

export interface SubagentFinishedPayload {
  taskId: string;
  status: string;
  summary?: string | null;
  error?: string | null;
}

export function onSubagentSpawned(
  handler: (payload: SubagentSpawnedPayload) => void,
): Promise<UnlistenFn> {
  return listenOrNoop<SubagentSpawnedPayload>("subagent:spawned", handler);
}

export function onSubagentFinished(
  handler: (payload: SubagentFinishedPayload) => void,
): Promise<UnlistenFn> {
  return listenOrNoop<SubagentFinishedPayload>("subagent:finished", handler);
}

export function onSubagentUpdated(
  handler: (payload: SubagentFinishedPayload) => void,
): Promise<UnlistenFn> {
  return listenOrNoop<SubagentFinishedPayload>("subagent:updated", handler);
}

/** Delegated tasks of one parent thread (inline subagent cards). */
export function orchestratorTasksList(threadId: string): Promise<DelegatedTask[]> {
  return invokeRequired<DelegatedTask[]>("orchestrator_tasks_list", { threadId });
}

export function orchestratorCancelTask(taskId: string, force = false): Promise<unknown> {
  return invokeRequired<unknown>("orchestrator_cancel_task", { taskId, force });
}

export function orchestratorCancelAll(threadId: string, force = false): Promise<void> {
  return invokeRequired<void>("orchestrator_cancel_all", { threadId, force });
}

export function orchestratorRetryTask(taskId: string): Promise<DelegatedTask> {
  return invokeRequired<DelegatedTask>("orchestrator_retry_task", { taskId });
}

export function orchestratorSteerTask(taskId: string, message: string): Promise<DelegatedTask> {
  return invokeRequired<DelegatedTask>("orchestrator_steer_task", { taskId, message });
}

/** Stop was pressed: the UI may offer a force-stop escalation. */
export function onRunCancelling(handler: (runId: string) => void): Promise<UnlistenFn> {
  return listenOrNoop<{ runId: string; threadId: string }>("run:cancelling", (payload) =>
    handler(payload.runId),
  );
}

export function onElicitationRequest(
  handler: (payload: ElicitationRequestPayload) => void,
): Promise<UnlistenFn> {
  return listenOrNoop<ElicitationRequestPayload>("elicitation:request", handler);
}

// ---- user MCP servers ------------------------------------------------------

export function mcpListServers(): Promise<McpServer[]> {
  return invokeRequired<McpServer[]>("mcp_list_servers");
}

export function mcpGetServer(id: string): Promise<McpServer> {
  return invokeRequired<McpServer>("mcp_get_server", { id });
}

export function mcpCreateServer(input: McpServerInput): Promise<McpServer> {
  return invokeRequired<McpServer>("mcp_create_server", { input });
}

export function mcpUpdateServer(id: string, input: McpServerInput): Promise<McpServer> {
  return invokeRequired<McpServer>("mcp_update_server", { id, input });
}

export function mcpDeleteServer(id: string): Promise<void> {
  return invokeRequired<void>("mcp_delete_server", { id });
}

export function mcpSetServerEnabled(id: string, enabled: boolean): Promise<McpServer> {
  return invokeRequired<McpServer>("mcp_set_server_enabled", { id, enabled });
}

export function mcpTestConnection(id: string): Promise<McpProbeResult> {
  return invokeRequired<McpProbeResult>("mcp_test_connection", { id });
}

export function mcpServerLogs(id: string): Promise<string[]> {
  return invokeRequired<string[]>("mcp_server_logs", { id });
}

export function mcpServerStats(id: string): Promise<McpServerStats> {
  return invokeRequired<McpServerStats>("mcp_server_stats", { id });
}

export function mcpCheckAll(): Promise<void> {
  return invokeRequired<void>("mcp_check_all");
}

export function mcpListBindings(scopeType: string, scopeId: string): Promise<McpBinding[]> {
  return invokeRequired<McpBinding[]>("mcp_list_bindings", { scopeType, scopeId });
}

export function mcpSetBinding(
  scopeType: string,
  scopeId: string,
  serverId: string,
  mode?: "include" | "exclude" | null,
): Promise<void> {
  return invokeRequired<void>("mcp_set_binding", { scopeType, scopeId, serverId, mode });
}

export function mcpActiveForThread(threadId: string, instanceId: string): Promise<McpServer[]> {
  return invokeRequired<McpServer[]>("mcp_active_for_thread", { threadId, instanceId });
}

export function mcpImportJson(json: string): Promise<McpImportOutcome[]> {
  return invokeRequired<McpImportOutcome[]>("mcp_import_json", { json });
}

export function mcpExportJson(ids: string[] = []): Promise<string> {
  return invokeRequired<string>("mcp_export_json", { ids });
}

export function diagnosticsProcessTree(): Promise<ProcessNode[]> {
  return invokeRequired<ProcessNode[]>("diagnostics_process_tree");
}

export function diagnosticsKillProcess(pid: number): Promise<void> {
  return invokeRequired<void>("diagnostics_kill_process", { pid });
}

export function mcpReconnectServer(id: string): Promise<McpProbeResult> {
  return invokeRequired<McpProbeResult>("mcp_reconnect_server", { id });
}

export function providersModelPrefsList(): Promise<ProviderModelPrefs[]> {
  return invokeRequired<ProviderModelPrefs[]>("providers_model_prefs_list");
}

export function providersModelPrefsGet(instanceId: string): Promise<ProviderModelPrefs | null> {
  return invokeRequired<ProviderModelPrefs | null>("providers_model_prefs_get", {
    instanceId,
  });
}

export function providersModelPrefsSet(prefs: ProviderModelPrefs): Promise<void> {
  return invokeRequired<void>("providers_model_prefs_set", { prefs });
}
