import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { isTauri } from "./tauri";
import type {
  AgentProcessPayload,
  CommitOutcome,
  ConfigOptionValue,
  DetectedAgent,
  DiffFile,
  GitDiff,
  GitDiffSummary,
  GitStatus,
  ImageInput,
  InstanceInfo,
  InstanceSpec,
  IpcError,
  PrOutcome,
  Project,
  PtyExitPayload,
  PtyInfo,
  PtyOutputPayload,
  PushOutcome,
  PreflightReport,
  QueueUpdatedPayload,
  Run,
  AgentCapsPayload,
  RunEventPayload,
  RunEventsPayload,
  SendOutcome,
  Thread,
  ThreadDetail,
  UsageReport,
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
  if (isIpcError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
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
export function readImageDataUrl(path: string): Promise<string> {
  return invokeRequired<string>("read_image_data_url", { path });
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

export function threadsDelete(threadId: string): Promise<void> {
  return invokeRequired<void>("threads_delete", { threadId });
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

export function runsCancel(runId: string): Promise<void> {
  return invokeRequired<void>("runs_cancel", { runId });
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

export function onElicitationRequest(
  handler: (payload: ElicitationRequestPayload) => void,
): Promise<UnlistenFn> {
  return listenOrNoop<ElicitationRequestPayload>("elicitation:request", handler);
}
