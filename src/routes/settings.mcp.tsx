import { useCallback, useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import { McpServerModal } from "../components/settings/McpServerModal";
import { McpImportExportModal } from "../components/settings/McpImportExportModal";
import {
  mcpCheckAll,
  mcpDeleteServer,
  mcpListServers,
  mcpSetServerEnabled,
  mcpTestConnection,
  projectsList,
  providersInstancesList,
  threadsList,
} from "../lib/ipc";
import { localizeIpcError, useT } from "../lib/i18n";
import type { InstanceInfo, McpProbeResult, McpServer, Project, Thread } from "../lib/types";

export const Route = createFileRoute("/settings/mcp")({ component: McpSettings });

function statusClass(status: string) {
  switch (status) {
    case "connected":
      return "bg-success";
    case "degraded":
      return "bg-warning";
    case "error":
      return "bg-danger";
    case "disabled":
      return "bg-border-strong";
    default:
      return "bg-text-tertiary";
  }
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={`relative h-4 w-8 shrink-0 rounded-full transition-colors ${
        on ? "bg-accent" : "bg-border-strong"
      }`}
    >
      <span
        className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-[left] ${
          on ? "left-4.5" : "left-0.5"
        }`}
      />
    </button>
  );
}

function McpSettings() {
  const t = useT();
  const [servers, setServers] = useState<McpServer[]>([]);
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<{ server: McpServer | null } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [probe, setProbe] = useState<McpProbeResult | null>(null);
  const [probing, setProbing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, infos, projectList, threadList] = await Promise.all([
        mcpListServers(),
        providersInstancesList().catch(() => []),
        projectsList().catch(() => []),
        threadsList().catch(() => []),
      ]);
      setServers(list);
      setInstances(infos);
      setProjects(projectList);
      setThreads(threadList.filter((thread) => !thread.parentThreadId));
      setSelectedId((current) =>
        current && list.some((server) => server.id === current) ? current : (list[0]?.id ?? null),
      );
    } catch (err) {
      setError(localizeIpcError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = servers.find((server) => server.id === selectedId) ?? null;

  const toggle = async (server: McpServer) => {
    try {
      await mcpSetServerEnabled(server.id, !server.enabled);
      await load();
    } catch (err) {
      setError(localizeIpcError(err));
    }
  };

  const remove = async (server: McpServer) => {
    if (!window.confirm(t("settings.mcp.confirmDelete", { name: server.name }))) return;
    try {
      await mcpDeleteServer(server.id);
      setProbe(null);
      await load();
    } catch (err) {
      setError(localizeIpcError(err));
    }
  };

  const test = async (server: McpServer) => {
    setProbing(true);
    setProbe(null);
    try {
      setProbe(await mcpTestConnection(server.id));
      await load();
    } catch (err) {
      setError(localizeIpcError(err));
    } finally {
      setProbing(false);
    }
  };

  const refreshAll = async () => {
    setError(null);
    try {
      await mcpCheckAll();
      await load();
    } catch (err) {
      setError(localizeIpcError(err));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-2.5">
        <Plug size={14} className="text-text-tertiary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-primary">{t("settings.mcp.title")}</p>
          <p className="truncate text-xs text-text-tertiary">{t("settings.mcp.subtitle")}</p>
        </div>
        <button
          onClick={() => void refreshAll()}
          title={t("settings.mcp.refresh")}
          className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) border border-border-subtle text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
        >
          <RefreshCw size={12} />
        </button>
        <button
          onClick={() => setImportOpen(true)}
          className="h-7 rounded-(--radius-sm) border border-border-subtle px-2 text-xs text-text-secondary transition hover:bg-hover"
        >
          {t("settings.mcp.importExport")}
        </button>
        <button
          onClick={() => setModal({ server: null })}
          className="flex h-7 items-center gap-1 rounded-(--radius-sm) bg-accent px-2 text-xs font-medium text-white transition hover:opacity-90"
        >
          <Plus size={12} /> {t("settings.mcp.add")}
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside className="w-full shrink-0 overflow-y-auto border-r border-border-subtle min-[1120px]:w-72">
          {loading && <p className="px-3 py-3 text-xs text-text-tertiary">{t("common.loading")}</p>}
          {!loading && servers.length === 0 && (
            <div className="px-4 py-6 text-center">
              <Plug size={20} className="mx-auto text-text-tertiary" />
              <p className="mt-2 text-sm text-text-secondary">{t("settings.mcp.empty")}</p>
              <p className="mt-1 text-xs text-text-tertiary">{t("settings.mcp.emptyHint")}</p>
            </div>
          )}
          {servers.map((server) => (
            <button
              key={server.id}
              onClick={() => {
                setSelectedId(server.id);
                setProbe(null);
              }}
              className={`flex w-full items-center gap-2 border-b border-border-subtle px-3 py-2 text-left transition ${
                server.id === selectedId ? "bg-active" : "hover:bg-hover"
              }`}
            >
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusClass(server.status)}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-text-primary">{server.name}</span>
                <span className="block truncate text-xs text-text-tertiary">
                  {server.transport.kind.toUpperCase()} · {server.scope}
                  {server.toolsCount > 0 ? ` · ${server.toolsCount} tools` : ""}
                </span>
              </span>
              <Toggle
                on={server.enabled}
                onClick={() => void toggle(server)}
                label={t("settings.mcp.enabled")}
              />
            </button>
          ))}
        </aside>

        <section className="min-w-0 flex-1 overflow-y-auto px-5 py-4">
          {error && <p className="mb-3 text-xs text-danger">{error}</p>}
          {!selected && !loading && (
            <p className="text-sm text-text-tertiary">{t("settings.mcp.selectHint")}</p>
          )}
          {selected && (
            <div className="mx-auto max-w-2xl">
              <div className="flex items-start gap-2">
                <span className={`mt-1.5 h-2 w-2 rounded-full ${statusClass(selected.status)}`} />
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-lg font-medium text-text-primary">
                    {selected.name}
                  </h2>
                  <p className="font-mono text-xs break-all text-text-tertiary">
                    {selected.transport.kind === "stdio"
                      ? `${selected.transport.command} ${selected.transport.args.join(" ")}`
                      : selected.transport.url}
                  </p>
                </div>
                <button
                  onClick={() => void test(selected)}
                  disabled={probing}
                  className="h-7 shrink-0 rounded-(--radius-sm) border border-border-subtle px-2 text-xs text-text-secondary transition hover:bg-hover disabled:opacity-50"
                >
                  {probing ? t("settings.mcp.testing") : t("settings.mcp.test")}
                </button>
                <button
                  onClick={() => setModal({ server: selected })}
                  className="h-7 shrink-0 rounded-(--radius-sm) border border-border-subtle px-2 text-xs text-text-secondary transition hover:bg-hover"
                >
                  {t("common.edit")}
                </button>
                <button
                  onClick={() => void remove(selected)}
                  aria-label={t("common.delete")}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-danger"
                >
                  <Trash2 size={13} />
                </button>
              </div>

              <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <dt className="text-text-tertiary">{t("settings.mcp.scope")}</dt>
                <dd className="text-text-secondary">
                  {selected.scope}
                  {selected.scope === "project" && selected.projectId
                    ? ` · ${projects.find((p) => p.id === selected.projectId)?.name ?? selected.projectId}`
                    : ""}
                  {selected.scope === "thread" && selected.threadId
                    ? ` · ${threads.find((thread) => thread.id === selected.threadId)?.title ?? selected.threadId}`
                    : ""}
                </dd>
                <dt className="text-text-tertiary">{t("settings.mcp.providers")}</dt>
                <dd className="text-text-secondary">
                  {selected.providerIds.length === 0
                    ? t("settings.mcp.allProviders")
                    : selected.providerIds
                        .map((id) => instances.find((i) => i.id === id)?.displayName ?? id)
                        .join(", ")}
                </dd>
                <dt className="text-text-tertiary">{t("settings.mcp.tools")}</dt>
                <dd className="text-text-secondary">{selected.toolsCount}</dd>
                <dt className="text-text-tertiary">{t("settings.mcp.latency")}</dt>
                <dd className="text-text-secondary">
                  {selected.lastLatencyMs != null ? `${selected.lastLatencyMs} ms` : "—"}
                </dd>
                <dt className="text-text-tertiary">{t("settings.mcp.timeout")}</dt>
                <dd className="text-text-secondary">{selected.timeoutMs} ms</dd>
                <dt className="text-text-tertiary">{t("settings.mcp.allowTools")}</dt>
                <dd className="font-mono text-xs text-text-secondary">
                  {selected.allowTools.length > 0 ? selected.allowTools.join(", ") : "—"}
                </dd>
                <dt className="text-text-tertiary">{t("settings.mcp.denyTools")}</dt>
                <dd className="font-mono text-xs text-text-secondary">
                  {selected.denyTools.length > 0 ? selected.denyTools.join(", ") : "—"}
                </dd>
              </dl>

              {selected.lastError && (
                <p className="mt-3 rounded-(--radius-sm) bg-danger/10 px-2 py-1.5 font-mono text-xs whitespace-pre-wrap text-danger">
                  {selected.lastError}
                </p>
              )}

              {probe && (
                <div className="mt-4 rounded-(--radius-md) border border-border-subtle p-3">
                  <p className="text-xs tracking-wider text-text-tertiary uppercase">
                    {t("settings.mcp.testResult")}
                  </p>
                  {probe.ok ? (
                    <>
                      <p className="mt-1 text-sm text-success">
                        {t("settings.mcp.testOk", {
                          ms: probe.latencyMs,
                          tools: probe.tools.length,
                        })}
                      </p>
                      <p className="mt-1 font-mono text-xs text-text-tertiary">
                        {probe.protocolVersion ?? ""}
                      </p>
                      <div className="mt-2 space-y-1">
                        {probe.tools.map((tool) => (
                          <div key={tool.name} className="text-xs">
                            <span className="font-mono text-text-primary">{tool.name}</span>
                            {tool.description && (
                              <span className="text-text-tertiary"> — {tool.description}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p className="mt-1 font-mono text-xs text-danger">{probe.error}</p>
                  )}
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      <McpServerModal
        open={modal !== null}
        server={modal?.server ?? null}
        projects={projects}
        threads={threads}
        instances={instances}
        onClose={() => setModal(null)}
        onSaved={(saved) => {
          setModal(null);
          setSelectedId(saved.id);
          setProbe(null);
          void load();
        }}
      />
      <McpImportExportModal
        open={importOpen}
        serverIds={[]}
        onClose={() => setImportOpen(false)}
        onImported={() => void load()}
      />
    </div>
  );
}
