import { useEffect, useState } from "react";
import { Plus, SquareTerminal, X } from "lucide-react";
import {
  ipcErrorMessage,
  terminalPtyCreate,
  terminalPtyKill,
  terminalPtyList,
} from "../../lib/ipc";
import { useRunsStore } from "../../stores/runs";
import type { ToolChatItem } from "../../stores/runs";
import { useThreadsStore } from "../../stores/threads";
import { useTerminalsStore } from "../../stores/terminals";
import { TerminalPane } from "./TerminalPane";

/** Tool rows from agent terminal callbacks, mirrored read-only (§8 M5). */
function useAgentTerminals(threadId: string | null): ToolChatItem[] {
  const runs = useRunsStore((s) => (threadId ? s.runsByThread[threadId] : undefined));
  const views = useRunsStore((s) => s.viewsByRun);
  if (!threadId) return [];
  const rows: ToolChatItem[] = [];
  for (const run of runs ?? []) {
    for (const item of views[run.id]?.items ?? []) {
      if (item.type === "tool" && item.kind === "execute") rows.push(item);
    }
  }
  return rows;
}

function AgentTerminalRow({ item }: { item: ToolChatItem }) {
  const statusColor =
    item.status === "failed"
      ? "bg-danger"
      : item.status === "completed"
        ? "bg-success"
        : "bg-warning";
  const preview =
    typeof item.rawOutput === "object" && item.rawOutput !== null && "text" in item.rawOutput
      ? String((item.rawOutput as { text?: unknown }).text ?? "")
      : "";
  return (
    <div className="rounded-(--radius-sm) border border-border-subtle bg-surface px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${statusColor}`} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-secondary">
          {item.title}
        </span>
        <span className="shrink-0 text-xs text-text-tertiary">{item.status}</span>
      </div>
      {preview && (
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-[13px] text-text-tertiary">
          {preview}
        </pre>
      )}
    </div>
  );
}

/**
 * The M5 terminal panel: user PTYs (xterm.js panes wired to ConPTY) plus a
 * read-only mirror of the agent's terminal tool rows. PTYs are children of
 * the app — after a restart they are gone (clean restart policy, surfaced
 * as this tab's empty state).
 */
export function TerminalPanel({ threadId }: { threadId: string | null }) {
  const terminals = useTerminalsStore((s) => (threadId ? s.byThread[threadId] : undefined));
  const activeId = useTerminalsStore((s) => (threadId ? s.activeByThread[threadId] : undefined));
  const setActive = useTerminalsStore((s) => s.setActive);
  const addTerminal = useTerminalsStore((s) => s.addTerminal);
  const removeTerminal = useTerminalsStore((s) => s.removeTerminal);
  const setList = useTerminalsStore((s) => s.setList);
  const workspace = useThreadsStore((s) =>
    threadId ? s.threads.find((t) => t.id === threadId)?.workspace : undefined,
  );
  const agentTerminals = useAgentTerminals(threadId);
  const [error, setError] = useState<string | null>(null);

  // Errors belong to the thread that produced them.
  useEffect(() => setError(null), [threadId]);

  // Re-sync the list whenever the thread changes (a restart orphans old ids).
  useEffect(() => {
    if (!threadId) return;
    void terminalPtyList(threadId)
      .then((list) => setList(threadId, list))
      .catch((err) => setError(ipcErrorMessage(err)));
  }, [threadId, setList]);

  const create = async () => {
    if (!threadId) return;
    try {
      const info = await terminalPtyCreate(threadId);
      setError(null);
      addTerminal(threadId, {
        terminalId: info.terminalId,
        title: info.title,
        exit: info.exit,
      });
    } catch (err) {
      setError(ipcErrorMessage(err));
    }
  };

  const kill = async (id: string) => {
    if (!threadId) return;
    try {
      await terminalPtyKill(id);
      setError(null);
      // Only forget the tab once the backend confirmed the kill: otherwise it
      // looks stopped while the process is still alive.
      removeTerminal(threadId, id);
    } catch (err) {
      setError(ipcErrorMessage(err));
    }
  };

  if (!threadId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 text-center">
        <p className="text-sm text-text-secondary">No thread open</p>
        <p className="text-xs text-text-tertiary">Terminals open inside a thread.</p>
      </div>
    );
  }

  const active = terminals?.find((t) => t.terminalId === activeId);
  const showEmpty = !terminals || terminals.length === 0;
  const workspaceLabel = workspace?.split(/[\\/]/).filter(Boolean).pop() ?? "workspace";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-border-subtle px-2 py-1.5">
        <button
          onClick={() => void create()}
          title="Open a shell in this thread's workspace"
          className="flex h-7 items-center gap-1 rounded-(--radius-sm) border border-border-subtle bg-surface px-2 text-xs text-text-secondary transition hover:bg-hover"
        >
          <Plus size={13} /> New terminal
        </button>
        <span className="ml-auto text-xs text-text-tertiary">
          {active ? `${active.title} · ${workspaceLabel}` : `Shell · ${workspaceLabel}`}
        </span>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-border-subtle bg-danger/10 px-2.5 py-1.5 text-xs text-danger"
        >
          <span className="min-w-0 flex-1">{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="shrink-0 text-text-tertiary transition hover:text-text-secondary"
          >
            Dismiss
          </button>
        </div>
      )}

      {showEmpty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-8 text-center">
          <SquareTerminal size={18} className="text-text-tertiary" />
          <p className="text-sm text-text-secondary">No terminal yet</p>
          <p className="text-xs text-text-tertiary">
            Shells you open run in this thread's workspace. They are children of the app — after a
            restart they end, and new ones start fresh.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1 border-b border-border-subtle px-2 py-1.5">
            {terminals!.map((t) => (
              <div
                key={t.terminalId}
                className={`flex items-center gap-1 rounded-(--radius-sm) border px-1.5 py-0.5 text-xs transition ${
                  t.terminalId === activeId
                    ? "border-border-strong bg-active text-text-primary"
                    : "border-border-subtle text-text-tertiary hover:bg-hover"
                }`}
              >
                <button
                  onClick={() => setActive(threadId, t.terminalId)}
                  className="flex items-center gap-1 truncate font-mono"
                  title={t.title}
                >
                  {t.exit !== null ? (
                    <span className="text-danger">exit {t.exit}</span>
                  ) : (
                    <span className="text-success">●</span>
                  )}
                  <span className="max-w-24 truncate">{t.title}</span>
                </button>
                <button
                  onClick={() => void kill(t.terminalId)}
                  aria-label="Kill terminal"
                  title="Kill terminal"
                  className="text-text-tertiary transition hover:text-danger"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
          {active && active.exit === null ? (
            <TerminalPane terminalId={active.terminalId} />
          ) : (
            <div className="flex flex-1 items-center justify-center px-8 text-center text-xs text-text-tertiary">
              {active
                ? `This terminal exited with code ${active.exit}.`
                : "Select a terminal above."}
            </div>
          )}
        </>
      )}

      <div className="border-t border-border-subtle">
        <p className="px-2.5 py-1 text-xs tracking-wider text-text-tertiary uppercase">
          Agent terminals
        </p>
        <div className="max-h-40 space-y-1 overflow-y-auto px-2 pb-2">
          {agentTerminals.length === 0 ? (
            <p className="px-0.5 text-xs text-text-tertiary">
              Shells the agent runs appear here read-only.
            </p>
          ) : (
            agentTerminals.map((item) => (
              <AgentTerminalRow key={`${item.toolCallId}-${item.status}`} item={item} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
