import { useEffect, useState } from "react";
import { mcpActiveForThread, mcpSetBinding } from "../../lib/ipc";
import { isTauri } from "../../lib/tauri";
import { plural, useT } from "../../lib/i18n";
import { useRunsStore } from "../../stores/runs";
import { useUiStore } from "../../stores/ui";
import type { McpServer } from "../../lib/types";

const RING_RADIUS = 6.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/** Context fill ring plus the thread's active MCP counter (composer strip). */
export function ContextRing({ threadId, onCompact }: { threadId: string; onCompact?: () => void }) {
  const t = useT();
  const usage = useRunsStore((s) => {
    const runs = s.runsByThread[threadId] ?? [];
    for (let i = runs.length - 1; i >= 0; i -= 1) {
      const value = s.viewsByRun[runs[i].id]?.usage;
      if (value) return value;
    }
    return undefined;
  });
  const instanceId = useUiStore((s) => s.instanceByThread[threadId] ?? s.selectedInstanceId);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [mcpOpen, setMcpOpen] = useState(false);

  useEffect(() => {
    setMcpOpen(false);
    if (!isTauri() || !threadId || !instanceId) {
      setMcpServers([]);
      return;
    }
    let cancelled = false;
    void mcpActiveForThread(threadId, instanceId)
      .then((servers) => {
        if (!cancelled) setMcpServers(Array.isArray(servers) ? servers : []);
      })
      .catch(() => {
        if (!cancelled) setMcpServers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, instanceId]);

  useEffect(() => {
    if (mcpServers.length === 0) setMcpOpen(false);
  }, [mcpServers.length]);

  useEffect(() => {
    if (!mcpOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setMcpOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mcpOpen]);

  const size = usage?.size ?? 0;
  const percent =
    size > 0 ? Math.min(100, Math.max(0, Math.round(((usage?.used ?? 0) / size) * 100))) : 0;
  const hasRing = size > 0;
  if (!hasRing && mcpServers.length === 0) return null;

  const tone = percent >= 90 ? "var(--danger)" : percent >= 75 ? "var(--warning)" : "var(--accent)";

  return (
    <div className="relative flex items-center gap-2">
      {hasRing && (
        <button
          type="button"
          aria-label={t("chat.context.compact")}
          title={`${t("chat.context.used", { percent })} · ${t("chat.context.compact")}`}
          onClick={() => onCompact?.()}
          className="flex items-center gap-1 text-xs text-text-tertiary transition hover:text-text-secondary"
        >
          <svg width={14} height={14} viewBox="0 0 16 16" aria-hidden className="shrink-0">
            <circle
              cx={8}
              cy={8}
              r={RING_RADIUS}
              fill="none"
              stroke="var(--border-strong)"
              strokeWidth={2}
            />
            <circle
              cx={8}
              cy={8}
              r={RING_RADIUS}
              fill="none"
              stroke={tone}
              strokeWidth={2}
              strokeLinecap="round"
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={RING_CIRCUMFERENCE * (1 - percent / 100)}
              transform="rotate(-90 8 8)"
            />
          </svg>
          <span className="tabular-nums">{percent}%</span>
        </button>
      )}
      {mcpServers.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={mcpOpen}
            onClick={() => setMcpOpen((open) => !open)}
            className={`rounded-(--radius-sm) px-1 text-xs transition hover:text-text-secondary ${
              mcpOpen ? "bg-active text-text-secondary" : "text-text-tertiary"
            }`}
          >
            {plural("chat.context.mcpActive", mcpServers.length)}
          </button>
          {mcpOpen && (
            <>
              <div
                className="fixed inset-0 z-40"
                data-escape-layer
                onClick={() => setMcpOpen(false)}
              />
              <div className="absolute right-0 bottom-full z-50 mb-1 w-56 rounded-(--radius-md) border border-border-strong bg-surface-raised p-1 shadow-lg">
                {mcpServers.map((server) => (
                  <div key={server.id} className="flex items-center gap-2 px-2 py-1 text-xs">
                    <span className="min-w-0 flex-1 truncate text-text-secondary">
                      {server.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setMcpServers((current) =>
                          current.filter((candidate) => candidate.id !== server.id),
                        );
                        void mcpSetBinding("thread", threadId, server.id, "exclude").catch((err) =>
                          console.error("mcp_set_binding failed", err),
                        );
                      }}
                      className="shrink-0 text-text-tertiary transition hover:text-danger"
                    >
                      {t("common.disable")}
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
