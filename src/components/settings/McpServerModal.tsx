import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, Trash2, X } from "lucide-react";
import type {
  InstanceInfo,
  McpProbeResult,
  McpServer,
  McpServerInput,
  McpTransportInput,
  Project,
  Thread,
} from "../../lib/types";
import { localizeIpcError, useT } from "../../lib/i18n";
import { mcpCreateServer, mcpTestConnection, mcpUpdateServer } from "../../lib/ipc";

type Kind = "stdio" | "http" | "sse";

interface Row {
  key: string;
  value: string;
  secret: boolean;
  hasValue?: boolean;
  masked?: string | null;
}

interface Props {
  open: boolean;
  server: McpServer | null;
  projects: Project[];
  threads: Thread[];
  instances: InstanceInfo[];
  onClose: () => void;
  onSaved: (server: McpServer) => void;
}

function rowsOf(
  plain: Record<string, string>,
  secrets: { key: string; hasValue: boolean; masked?: string | null }[],
): Row[] {
  return [
    ...Object.entries(plain).map(([key, value]) => ({ key, value, secret: false })),
    ...secrets.map((secret) => ({
      key: secret.key,
      value: "",
      secret: true,
      hasValue: secret.hasValue,
      masked: secret.masked,
    })),
  ];
}

/** Add/Edit custom MCP server. Mirrors the provider wizard's modal styling. */
export function McpServerModal({
  open,
  server,
  projects,
  threads,
  instances,
  onClose,
  onSaved,
}: Props) {
  const t = useT();
  const editing = server !== null;
  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [kind, setKind] = useState<Kind>("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [cwd, setCwd] = useState("");
  const [url, setUrl] = useState("");
  const [envRows, setEnvRows] = useState<Row[]>([]);
  const [scope, setScope] = useState<"global" | "project" | "thread">("global");
  const [projectId, setProjectId] = useState("");
  const [threadId, setThreadId] = useState("");
  const [providerIds, setProviderIds] = useState<string[]>([]);
  const [allowTools, setAllowTools] = useState("");
  const [denyTools, setDenyTools] = useState("");
  const [timeoutMs, setTimeoutMs] = useState(30_000);
  const [allowLocalhost, setAllowLocalhost] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<McpProbeResult | null>(null);
  const [probing, setProbing] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setProbe(null);
    if (!server) {
      setName("");
      setEnabled(true);
      setKind("stdio");
      setCommand("");
      setArgs("");
      setCwd("");
      setUrl("");
      setEnvRows([]);
      setScope("global");
      setProjectId("");
      setThreadId("");
      setProviderIds([]);
      setAllowTools("");
      setDenyTools("");
      setTimeoutMs(30_000);
      setAllowLocalhost(true);
      return;
    }
    setName(server.name);
    setEnabled(server.enabled);
    setKind(server.transport.kind);
    setCommand(server.transport.kind === "stdio" ? server.transport.command : "");
    setArgs(server.transport.kind === "stdio" ? server.transport.args.join("\n") : "");
    setCwd(server.transport.kind === "stdio" ? (server.transport.cwd ?? "") : "");
    setUrl(server.transport.kind === "stdio" ? "" : server.transport.url);
    setEnvRows(
      server.transport.kind === "stdio"
        ? rowsOf(server.transport.env, server.transport.secretEnvKeys)
        : rowsOf(server.transport.headers, server.transport.secretHeaderKeys),
    );
    setScope(server.scope);
    setProjectId(server.projectId ?? "");
    setThreadId(server.threadId ?? "");
    setProviderIds(server.providerIds);
    setAllowTools(server.allowTools.join(", "));
    setDenyTools(server.denyTools.join(", "));
    setTimeoutMs(server.timeoutMs);
    setAllowLocalhost(server.allowLocalhost);
  }, [open, server]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const list = (value: string) =>
    value
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);

  const buildInput = (): McpServerInput => {
    const plain: Record<string, string> = {};
    const secrets = envRows
      .filter((row) => row.key.trim())
      .filter((row) => {
        if (!row.secret) plain[row.key.trim()] = row.value;
        return row.secret;
      })
      .map((row) => ({
        key: row.key.trim(),
        value: row.value === "" ? undefined : row.value,
      }));
    const transport: McpTransportInput =
      kind === "stdio"
        ? {
            kind,
            command: command.trim(),
            args: args
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
            cwd: cwd.trim() || null,
            env: plain,
            secretEnv: secrets,
          }
        : {
            kind,
            url: url.trim(),
            headers: plain,
            secretHeaders: secrets,
          };
    return {
      name: name.trim(),
      enabled,
      transport,
      scope,
      projectId: scope === "project" ? projectId || null : null,
      threadId: scope === "thread" ? threadId || null : null,
      providerIds,
      allowTools: list(allowTools),
      denyTools: list(denyTools),
      timeoutMs,
      allowLocalhost,
    };
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const input = buildInput();
      const saved = server ? await mcpUpdateServer(server.id, input) : await mcpCreateServer(input);
      onSaved(saved);
    } catch (err) {
      setError(localizeIpcError(err));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    if (!server) return;
    setProbing(true);
    setError(null);
    try {
      setProbe(await mcpTestConnection(server.id));
    } catch (err) {
      setError(localizeIpcError(err));
    } finally {
      setProbing(false);
    }
  };

  const updateRow = (index: number, patch: Partial<Row>) =>
    setEnvRows((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-md">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={editing ? t("settings.mcp.editTitle") : t("settings.mcp.addTitle")}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-(--radius-lg) border border-border-subtle bg-canvas shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
          <h2 className="text-sm font-medium text-text-primary">
            {editing ? t("settings.mcp.editTitle") : t("settings.mcp.addTitle")}
          </h2>
          <button
            onClick={onClose}
            aria-label={t("common.close")}
            className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-primary"
          >
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="col-span-2 flex flex-col gap-1">
              <span className="text-xs tracking-wider text-text-tertiary uppercase">
                {t("settings.mcp.name")}
              </span>
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="filesystem"
                className="h-8 rounded-(--radius-sm) border border-border-subtle bg-surface px-2 text-sm text-text-primary focus:outline-none"
              />
            </label>
          </div>

          <div className="flex gap-1 rounded-(--radius-sm) border border-border-subtle bg-surface p-1">
            {(["stdio", "http", "sse"] as Kind[]).map((option) => (
              <button
                key={option}
                onClick={() => {
                  setKind(option);
                  setEnvRows([]);
                }}
                className={`flex-1 rounded-(--radius-sm) px-2 py-1 text-xs transition ${
                  kind === option
                    ? "bg-active text-text-primary"
                    : "text-text-tertiary hover:text-text-secondary"
                }`}
              >
                {option === "stdio"
                  ? "stdio"
                  : option === "http"
                    ? "Streamable HTTP"
                    : "Legacy SSE"}
              </button>
            ))}
          </div>

          {kind === "stdio" ? (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-xs tracking-wider text-text-tertiary uppercase">
                  {t("settings.mcp.command")}
                </span>
                <input
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  placeholder="npx"
                  className="h-8 rounded-(--radius-sm) border border-border-subtle bg-surface px-2 font-mono text-sm text-text-primary focus:outline-none"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs tracking-wider text-text-tertiary uppercase">
                  {t("settings.mcp.arguments")}
                </span>
                <textarea
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                  rows={3}
                  placeholder={"-y\n@modelcontextprotocol/server-filesystem\n."}
                  className="rounded-(--radius-sm) border border-border-subtle bg-surface px-2 py-1 font-mono text-sm text-text-primary focus:outline-none"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs tracking-wider text-text-tertiary uppercase">
                  {t("settings.mcp.cwd")}
                </span>
                <input
                  value={cwd}
                  onChange={(event) => setCwd(event.target.value)}
                  className="h-8 rounded-(--radius-sm) border border-border-subtle bg-surface px-2 font-mono text-sm text-text-primary focus:outline-none"
                />
              </label>
              <p className="rounded-(--radius-sm) bg-warning/10 px-2 py-1.5 text-xs text-warning">
                {t("settings.mcp.stdioWarning")}
              </p>
            </>
          ) : (
            <>
              <label className="flex flex-col gap-1">
                <span className="text-xs tracking-wider text-text-tertiary uppercase">URL</span>
                <input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://mcp.example.com/mcp"
                  className="h-8 rounded-(--radius-sm) border border-border-subtle bg-surface px-2 font-mono text-sm text-text-primary focus:outline-none"
                />
              </label>
              <p className="rounded-(--radius-sm) bg-warning/10 px-2 py-1.5 text-xs text-warning">
                {t("settings.mcp.remoteWarning")}
              </p>
            </>
          )}

          <div>
            <div className="flex items-center justify-between">
              <p className="text-xs tracking-wider text-text-tertiary uppercase">
                {kind === "stdio" ? t("settings.mcp.env") : t("settings.mcp.headers")}
              </p>
              <button
                onClick={() =>
                  setEnvRows((rows) => [...rows, { key: "", value: "", secret: false }])
                }
                className="flex items-center gap-1 text-xs text-text-secondary transition hover:text-text-primary"
              >
                <Plus size={11} /> {t("settings.mcp.addRow")}
              </button>
            </div>
            <div className="mt-1 space-y-1">
              {envRows.map((row, index) => (
                <div key={index} className="flex items-center gap-1">
                  <input
                    value={row.key}
                    onChange={(event) => updateRow(index, { key: event.target.value })}
                    placeholder={t("settings.mcp.key")}
                    className="h-7 w-40 rounded-(--radius-sm) border border-border-subtle bg-surface px-2 font-mono text-xs text-text-primary focus:outline-none"
                  />
                  <input
                    value={row.value}
                    onChange={(event) => updateRow(index, { value: event.target.value })}
                    placeholder={row.hasValue ? (row.masked ?? "••••") : t("settings.mcp.value")}
                    className="h-7 min-w-0 flex-1 rounded-(--radius-sm) border border-border-subtle bg-surface px-2 font-mono text-xs text-text-primary focus:outline-none"
                  />
                  <label className="flex shrink-0 items-center gap-1 text-xs text-text-tertiary">
                    <input
                      type="checkbox"
                      checked={row.secret}
                      onChange={(event) => updateRow(index, { secret: event.target.checked })}
                    />
                    {t("settings.mcp.secret")}
                  </label>
                  <button
                    onClick={() => setEnvRows((rows) => rows.filter((_, i) => i !== index))}
                    aria-label={t("common.delete")}
                    className="flex h-7 w-7 items-center justify-center text-text-tertiary transition hover:text-danger"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs tracking-wider text-text-tertiary uppercase">
                {t("settings.mcp.scope")}
              </span>
              <select
                value={scope}
                onChange={(event) => setScope(event.target.value as typeof scope)}
                className="h-8 rounded-(--radius-sm) border border-border-subtle bg-surface px-2 text-sm text-text-primary focus:outline-none"
              >
                <option value="global">{t("settings.mcp.scopeGlobal")}</option>
                <option value="project">{t("settings.mcp.scopeProject")}</option>
                <option value="thread">{t("settings.mcp.scopeThread")}</option>
              </select>
            </label>
            {scope === "project" && (
              <label className="flex flex-col gap-1">
                <span className="text-xs tracking-wider text-text-tertiary uppercase">
                  {t("settings.mcp.project")}
                </span>
                <select
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                  className="h-8 rounded-(--radius-sm) border border-border-subtle bg-surface px-2 text-sm text-text-primary focus:outline-none"
                >
                  <option value="">—</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {scope === "thread" && (
              <label className="flex flex-col gap-1">
                <span className="text-xs tracking-wider text-text-tertiary uppercase">
                  {t("settings.mcp.thread")}
                </span>
                <select
                  value={threadId}
                  onChange={(event) => setThreadId(event.target.value)}
                  className="h-8 rounded-(--radius-sm) border border-border-subtle bg-surface px-2 text-sm text-text-primary focus:outline-none"
                >
                  <option value="">—</option>
                  {threads.map((thread) => (
                    <option key={thread.id} value={thread.id}>
                      {thread.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex flex-col gap-1">
              <span className="text-xs tracking-wider text-text-tertiary uppercase">
                {t("settings.mcp.timeout")}
              </span>
              <input
                type="number"
                min={1000}
                max={120000}
                value={timeoutMs}
                onChange={(event) => setTimeoutMs(Number(event.target.value))}
                className="h-8 rounded-(--radius-sm) border border-border-subtle bg-surface px-2 text-sm text-text-primary focus:outline-none"
              />
            </label>
          </div>

          <div>
            <p className="text-xs tracking-wider text-text-tertiary uppercase">
              {t("settings.mcp.providers")}
            </p>
            <div className="mt-1 flex flex-wrap gap-2">
              {instances.map((instance) => (
                <label
                  key={instance.id}
                  className="flex items-center gap-1 rounded-(--radius-sm) border border-border-subtle px-2 py-1 text-xs text-text-secondary"
                >
                  <input
                    type="checkbox"
                    checked={providerIds.includes(instance.id)}
                    onChange={(event) =>
                      setProviderIds((ids) =>
                        event.target.checked
                          ? [...ids, instance.id]
                          : ids.filter((id) => id !== instance.id),
                      )
                    }
                  />
                  {instance.displayName}
                </label>
              ))}
              {instances.length === 0 && (
                <span className="text-xs text-text-tertiary">{t("settings.mcp.allProviders")}</span>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs tracking-wider text-text-tertiary uppercase">
                {t("settings.mcp.allowTools")}
              </span>
              <input
                value={allowTools}
                onChange={(event) => setAllowTools(event.target.value)}
                placeholder="read_*, list"
                className="h-8 rounded-(--radius-sm) border border-border-subtle bg-surface px-2 font-mono text-xs text-text-primary focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs tracking-wider text-text-tertiary uppercase">
                {t("settings.mcp.denyTools")}
              </span>
              <input
                value={denyTools}
                onChange={(event) => setDenyTools(event.target.value)}
                placeholder="*_delete"
                className="h-8 rounded-(--radius-sm) border border-border-subtle bg-surface px-2 font-mono text-xs text-text-primary focus:outline-none"
              />
            </label>
          </div>

          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-sm text-text-secondary">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
              {t("settings.mcp.enabled")}
            </label>
            <label className="flex items-center gap-1.5 text-sm text-text-secondary">
              <input
                type="checkbox"
                checked={allowLocalhost}
                onChange={(event) => setAllowLocalhost(event.target.checked)}
              />
              {t("settings.mcp.allowLocalhost")}
            </label>
          </div>

          {error && <p className="text-xs text-danger">{error}</p>}

          {!editing && <p className="text-xs text-text-tertiary">{t("settings.mcp.saveFirst")}</p>}

          {editing && (
            <div className="rounded-(--radius-sm) border border-border-subtle p-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void test()}
                  disabled={probing}
                  className="h-7 rounded-(--radius-sm) border border-border-subtle px-2 text-xs text-text-secondary transition hover:bg-hover disabled:opacity-50"
                >
                  {probing ? t("settings.mcp.testing") : t("settings.mcp.test")}
                </button>
                {probe && (
                  <span className={`text-xs ${probe.ok ? "text-success" : "text-danger"}`}>
                    {probe.ok
                      ? t("settings.mcp.testOk", { ms: probe.latencyMs, tools: probe.tools.length })
                      : probe.error}
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-text-tertiary">{t("settings.mcp.testsSaved")}</p>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border-subtle px-4 py-3">
          <button
            onClick={onClose}
            className="h-8 rounded-(--radius-sm) px-3 text-sm text-text-secondary transition hover:bg-hover"
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={() => void save()}
            disabled={saving || !name.trim()}
            className="h-8 rounded-(--radius-sm) bg-accent px-3 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {saving ? t("common.saving") : editing ? t("common.save") : t("settings.mcp.add")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
