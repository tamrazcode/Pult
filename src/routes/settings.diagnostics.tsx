import { useEffect, useState, type ReactNode } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import {
  diagnosticsFrames,
  diagnosticsKillProcess,
  diagnosticsProcessTree,
  mcpListServers,
  mcpReconnectServer,
  mcpServerLogs,
  mcpServerStats,
  providersInstancesList,
} from "../lib/ipc";
import { isTauri } from "../lib/tauri";
import { useUiStore } from "../stores/ui";
import { useSettingsStore } from "../stores/settings";
import { formatTime, localizeIpcError, useT } from "../lib/i18n";
import type { InstanceInfo, McpServer, McpServerStats, ProcessNode } from "../lib/types";

export const Route = createFileRoute("/settings/diagnostics")({ component: DiagnosticsSettings });

/** One instance card: caps, process log, last raw frames (§8 M6). */
function InstanceDiagnostics({ info }: { info: InstanceInfo }) {
  const t = useT();
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const [frames, setFrames] = useState<string[] | null>(null);
  const [framesError, setFramesError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Select the stable record — `?? []` inside the selector would return a
  // fresh array each getSnapshot and loop React's useSyncExternalStore.
  const ring = useUiStore((s) => s.processEvents[info.id]);
  const processEvents = ring ?? [];

  const loadFrames = async () => {
    setLoading(true);
    setFramesError(null);
    try {
      setFrames(await diagnosticsFrames(info.id));
    } catch (err) {
      setFrames(null);
      setFramesError(localizeIpcError(err));
    } finally {
      setLoading(false);
    }
  };

  const caps = [
    info.promptImage ? t("settings.diagnostics.images") : null,
    info.loadSession ? t("settings.diagnostics.resume") : null,
    info.modes.length > 0
      ? t("settings.diagnostics.modes", { count: info.modes.length })
      : t("settings.diagnostics.noModes"),
    info.configOptions.length > 0
      ? t("settings.diagnostics.configOptions", { count: info.configOptions.length })
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="rounded-(--radius-md) border border-border-subtle bg-surface p-3">
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            processEvents.at(-1)?.kind === "crashed"
              ? "bg-danger"
              : processEvents.at(-1)?.kind === "spawned" || processEvents.at(-1)?.kind === "running"
                ? "bg-success"
                : processEvents.at(-1)?.kind === "starting"
                  ? "bg-warning"
                  : "bg-text-tertiary"
          }`}
        />
        <p className="min-w-0 flex-1 truncate text-sm text-text-primary">{info.displayName}</p>
        <button
          onClick={() => void loadFrames()}
          title={t("settings.diagnostics.grabFrames")}
          className="flex h-7 items-center gap-1 rounded-(--radius-sm) border border-border-subtle px-2 text-xs text-text-secondary transition hover:bg-hover"
        >
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} />{" "}
          {t("settings.diagnostics.frames")}
        </button>
      </div>
      <p className="mt-1 font-mono text-xs text-text-tertiary">
        {info.driver === "mock"
          ? t("settings.diagnostics.mockAgent")
          : `${info.command} ${info.args.join(" ")}`}
      </p>
      <p className="mt-1 text-xs text-text-tertiary">
        {t("settings.diagnostics.caps")} {caps}
      </p>

      {processEvents.length > 0 && (
        <div className="mt-2">
          <p className="text-xs tracking-wider text-text-tertiary uppercase">
            {t("settings.diagnostics.processLog")}
          </p>
          <div className="mt-1 max-h-24 space-y-0.5 overflow-y-auto font-mono text-[13px] text-text-tertiary">
            {processEvents.map((event, i) => (
              <p key={i}>
                {formatTime(event.at, undefined, timeFormat === "12h")} {event.kind}
                {event.detail ? ` — ${event.detail}` : ""}
              </p>
            ))}
          </div>
        </div>
      )}

      {framesError && <p className="mt-2 text-xs text-warning">{framesError}</p>}
      {frames && (
        <div className="mt-2">
          <p className="text-xs tracking-wider text-text-tertiary uppercase">
            {t("settings.diagnostics.lastFrames")}
          </p>
          <pre className="mt-1 max-h-48 overflow-auto rounded-(--radius-sm) bg-canvas p-2 font-mono text-[13px] whitespace-pre-wrap text-text-tertiary">
            {frames.join("\n")}
          </pre>
        </div>
      )}
    </div>
  );
}

function McpDiagnostics() {
  const t = useT();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [logs, setLogs] = useState<Record<string, string[]>>({});
  const [stats, setStats] = useState<Record<string, McpServerStats>>({});
  const [reconnecting, setReconnecting] = useState<string | null>(null);
  const [reconnectError, setReconnectError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    mcpListServers()
      .then(setServers)
      .catch(() => setServers([]));
  }, []);

  const grab = async (id: string) => {
    try {
      const [lines, counters] = await Promise.all([mcpServerLogs(id), mcpServerStats(id)]);
      setLogs((current) => ({ ...current, [id]: lines }));
      setStats((current) => ({ ...current, [id]: counters }));
    } catch {
      setLogs((current) => ({ ...current, [id]: [] }));
    }
  };

  const reconnect = async (id: string) => {
    setReconnecting(id);
    setReconnectError(null);
    try {
      const result = await mcpReconnectServer(id);
      if (!result.ok) setReconnectError(result.error ?? "reconnect failed");
      await grab(id);
    } catch (err) {
      setReconnectError(localizeIpcError(err));
    } finally {
      setReconnecting(null);
    }
  };

  if (servers.length === 0) return null;
  return (
    <div className="mt-6">
      <h3 className="text-sm font-medium text-text-primary">
        {t("settings.diagnostics.mcpTitle")}
      </h3>
      <p className="mt-1 text-xs text-text-tertiary">{t("settings.diagnostics.mcpSubtitle")}</p>
      <div className="mt-2 space-y-2">
        {servers.map((server) => {
          const counters = stats[server.id];
          return (
            <div
              key={server.id}
              className="rounded-(--radius-md) border border-border-subtle bg-surface p-3"
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
                  {server.name}
                </span>
                <span className="text-xs text-text-tertiary">
                  {server.status}
                  {counters
                    ? ` · ${t("settings.diagnostics.mcpCalls", {
                        calls: counters.callsTotal,
                        errors: counters.errorsTotal,
                      })}`
                    : ""}
                </span>
                <button
                  onClick={() => void grab(server.id)}
                  className="flex h-7 items-center gap-1 rounded-(--radius-sm) border border-border-subtle px-2 text-xs text-text-secondary transition hover:bg-hover"
                >
                  <RefreshCw size={11} /> {t("settings.diagnostics.mcpLogs")}
                </button>
                <button
                  onClick={() => void reconnect(server.id)}
                  disabled={reconnecting === server.id}
                  className="flex h-7 items-center gap-1 rounded-(--radius-sm) border border-border-subtle px-2 text-xs text-text-secondary transition hover:bg-hover disabled:opacity-50"
                >
                  <RefreshCw
                    size={11}
                    className={reconnecting === server.id ? "animate-spin" : ""}
                  />
                  {t("settings.diagnostics.mcpReconnect")}
                </button>
              </div>
              {reconnectError && (
                <p className="mt-1 font-mono text-xs text-danger">{reconnectError}</p>
              )}
              {server.lastError && (
                <p className="mt-1 font-mono text-xs text-danger">{server.lastError}</p>
              )}
              {logs[server.id] && (
                <pre className="mt-2 max-h-32 overflow-auto rounded-(--radius-sm) bg-canvas p-2 font-mono text-[12px] whitespace-pre-wrap text-text-tertiary">
                  {logs[server.id].length > 0 ? logs[server.id].join("\n") : "—"}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ProcessesDiagnostics() {
  const t = useT();
  const [tree, setTree] = useState<ProcessNode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const load = async () => {
      // Hidden windows do not need a 3 s process snapshot.
      if (document.visibilityState !== "visible") return;
      try {
        const next = await diagnosticsProcessTree();
        if (!cancelled) {
          setTree(next);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(localizeIpcError(err));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    const onVisible = () => void load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const kill = async (node: ProcessNode) => {
    if (!window.confirm(t("settings.diagnostics.processesConfirm", { pid: node.pid }))) {
      return;
    }
    try {
      await diagnosticsKillProcess(node.pid);
    } catch (err) {
      setError(localizeIpcError(err));
    }
  };

  const row = (node: ProcessNode, depth: number): ReactNode => {
    const isCollapsed = collapsed.has(node.pid);
    const toggle = () =>
      setCollapsed((current) => {
        const next = new Set(current);
        if (next.has(node.pid)) next.delete(node.pid);
        else next.add(node.pid);
        return next;
      });
    return (
      <div key={node.pid} role="treeitem" aria-expanded={!isCollapsed}>
        <div
          className="flex items-center gap-2 border-b border-border-subtle/60 py-1 text-xs"
          style={{ paddingLeft: depth * 14 }}
        >
          {node.children.length > 0 ? (
            <button
              onClick={toggle}
              aria-label={isCollapsed ? "Expand" : "Collapse"}
              className="flex h-4 w-4 shrink-0 items-center justify-center text-text-tertiary"
            >
              {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
            </button>
          ) : (
            <span className="w-4 shrink-0" />
          )}
          <span className="w-16 shrink-0 rounded bg-active px-1 text-center font-mono text-xs text-text-tertiary">
            {node.role}
          </span>
          <span className="min-w-0 flex-1 truncate text-text-primary">
            {node.label ?? node.name}
            {node.threadId ? (
              <span className="ml-2 text-text-tertiary">{node.threadId}</span>
            ) : null}
          </span>
          <span className="shrink-0 font-mono text-text-tertiary">pid {node.pid}</span>
          <span className="w-14 shrink-0 text-right font-mono text-text-tertiary">
            {node.cpuPercent != null ? `${node.cpuPercent.toFixed(1)}%` : "—"}
          </span>
          <span className="w-16 shrink-0 text-right font-mono text-text-tertiary">
            {node.memoryBytes != null ? `${Math.round(node.memoryBytes / (1024 * 1024))} MB` : "—"}
          </span>
          {node.killable ? (
            <button
              onClick={() => void kill(node)}
              className="shrink-0 rounded border border-border-subtle px-1.5 py-0.5 text-xs text-text-tertiary transition hover:bg-hover hover:text-danger"
            >
              {t("settings.diagnostics.processesKill")}
            </button>
          ) : (
            <span className="w-[42px] shrink-0" />
          )}
        </div>
        {!isCollapsed && node.children.map((child) => row(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="mt-6">
      <h3 className="text-sm font-medium text-text-primary">
        {t("settings.diagnostics.processesTitle")}
      </h3>
      <p className="mt-1 text-xs text-text-tertiary">
        {t("settings.diagnostics.processesSubtitle")}
      </p>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      <div
        role="tree"
        className="mt-2 rounded-(--radius-md) border border-border-subtle bg-surface px-3 py-1"
      >
        {tree.length === 0 ? (
          <p className="py-2 text-xs text-text-tertiary">
            {t("settings.diagnostics.processesEmpty")}
          </p>
        ) : (
          tree.map((node) => row(node, 0))
        )}
      </div>
    </div>
  );
}

function DiagnosticsSettings() {
  const t = useT();
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isTauri()) {
      setLoaded(true);
      return;
    }
    // Direct visits must still subscribe to "agent:process" (the composer's
    // picker normally does this) so the ring fills while the page is open.
    void useUiStore.getState().loadInstances();
    void providersInstancesList().then((list) => {
      setInstances(list);
      setLoaded(true);
    });
  }, []);

  return (
    <div className="mx-auto max-w-2xl">
      <h2 className="text-lg font-medium text-text-primary">{t("settings.diagnostics.title")}</h2>
      <p className="mt-1 text-sm text-text-tertiary">{t("settings.diagnostics.subtitle")}</p>
      <div className="mt-4 space-y-2">
        {loaded && instances.length === 0 && (
          <p className="text-sm text-text-tertiary">{t("settings.diagnostics.empty")}</p>
        )}
        {instances.map((info) => (
          <InstanceDiagnostics key={info.id} info={info} />
        ))}
      </div>
      <McpDiagnostics />
      <ProcessesDiagnostics />
    </div>
  );
}
