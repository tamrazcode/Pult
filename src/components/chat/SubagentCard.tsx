import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { ChevronRight, RotateCcw, Square } from "lucide-react";
import { orchestratorCancelTask, orchestratorRetryTask } from "../../lib/ipc";
import { useT } from "../../lib/i18n";
import type { DelegatedTask } from "../../lib/types";
import { isTaskActive, useSubagentsStore } from "../../stores/subagents";
import { ProviderLogo } from "./ProviderLogo";

const STATUS_KEYS: Record<string, string> = {
  queued: "subagents.status.queued",
  running: "subagents.status.running",
  completed: "subagents.status.completed",
  failed: "subagents.status.failed",
  cancelled: "subagents.status.cancelled",
  orphaned: "subagents.status.failed",
  interrupted: "subagents.status.cancelled",
};

function elapsed(startedAt: number, finishedAt?: number | null): string {
  const seconds = Math.max(0, Math.floor(((finishedAt ?? Date.now()) - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** One delegated child as a card in the parent's timeline. The child's own
 *  transcript stays out of the parent; Open chat is the way in. */
export function SubagentCard({ task }: { task: DelegatedTask }) {
  const t = useT();
  const router = useRouter();
  const [now, setNow] = useState(() => Date.now());
  const active = isTaskActive(task.status);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  const identity = {
    id: task.targetInstanceId,
    driver: "acp",
    displayName: task.targetInstanceId,
    command: task.targetInstanceId,
    args: [] as string[],
  };
  const statusKey = STATUS_KEYS[task.status] ?? "subagents.status.running";
  const preview = task.summary?.trim() || task.promptSummary.trim();
  void now;

  const stop = () => {
    void orchestratorCancelTask(task.taskId, true).catch((error) =>
      console.error("orchestrator_cancel_task failed", error),
    );
  };
  const retry = () => {
    void orchestratorRetryTask(task.taskId)
      .then((updated) => useSubagentsStore.getState().upsert(updated))
      .catch((error) => console.error("orchestrator_retry_task failed", error));
  };
  const open = () => {
    void router.navigate({
      to: "/thread/$threadId",
      params: { threadId: task.childThreadId },
    });
  };

  return (
    <div
      data-subagent-card
      className="rounded-(--radius-md) border border-border-subtle bg-surface px-3 py-2.5"
    >
      <div className="flex items-center gap-2">
        <ProviderLogo instance={identity} />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
          {task.title}
        </span>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
            task.status === "failed"
              ? "bg-danger/10 text-danger"
              : task.status === "completed"
                ? "bg-accent/10 text-accent"
                : active
                  ? "bg-active text-text-secondary"
                  : "bg-active text-text-tertiary"
          }`}
        >
          {t(statusKey)}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-text-tertiary">
        <span className="font-mono">{task.targetModel ?? task.targetInstanceId}</span>
        {task.role && task.role !== "general" && <span>· {task.role}</span>}
        {task.isolation === "worktree" && <span>· worktree</span>}
        <span>· {elapsed(task.startedAt, task.finishedAt)}</span>
      </div>

      {preview && (
        <p className="mt-1.5 line-clamp-2 text-xs leading-snug text-text-secondary">{preview}</p>
      )}
      {task.error && (
        <p className="mt-1 line-clamp-2 text-xs leading-snug text-danger">{task.error}</p>
      )}

      <div className="mt-2 flex items-center gap-1">
        <button
          type="button"
          onClick={open}
          className="flex h-6 items-center gap-1 rounded-(--radius-sm) px-1.5 text-xs text-text-secondary transition hover:bg-hover"
        >
          {t("subagents.card.open")}
          <ChevronRight size={11} />
        </button>
        <span className="flex-1" />
        {active ? (
          <button
            type="button"
            onClick={stop}
            aria-label={t("subagents.card.stop")}
            title={t("subagents.card.stop")}
            className="flex h-6 w-6 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
          >
            <Square size={11} />
          </button>
        ) : (
          <button
            type="button"
            onClick={retry}
            aria-label={t("subagents.card.retry")}
            title={t("subagents.card.retry")}
            className="flex h-6 w-6 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
          >
            <RotateCcw size={11} />
          </button>
        )}
      </div>
    </div>
  );
}
