import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { ipcErrorMessage, providersInstancesList, usageReport } from "../lib/ipc";
import {
  computeUsageKpis,
  formatContextFill,
  formatTokenCount,
  formatUsageCost,
} from "../lib/usage";
import type { InstanceInfo, UsageReport } from "../lib/types";

export const Route = createFileRoute("/usage")({ component: UsagePage });

type Tab = "runs" | "threads" | "providers";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "runs", label: "Runs" },
  { id: "threads", label: "Threads" },
  { id: "providers", label: "Providers" },
];

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-(--radius-md) border border-border-subtle bg-surface p-3">
      <p className="text-[10px] tracking-wider text-text-tertiary uppercase">{label}</p>
      <p className="mt-1 text-lg text-text-primary">{value}</p>
      {hint && <p className="text-xs text-text-tertiary">{hint}</p>}
    </div>
  );
}

export function UsagePage() {
  const router = useRouter();
  const [report, setReport] = useState<UsageReport | null>(null);
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("runs");
  const [instanceId, setInstanceId] = useState<string>("");

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [next, list] = await Promise.all([usageReport(), providersInstancesList()]);
      setReport(next);
      setInstances(list);
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const kpis = useMemo(
    () =>
      report
        ? computeUsageKpis(report, instanceId || null)
        : computeUsageKpis({ totalRuns: 0, runs: [], byThread: [], byInstance: [] }),
    [report, instanceId],
  );
  const runs = useMemo(
    () => (report?.runs ?? []).filter((run) => !instanceId || run.instanceId === instanceId),
    [report, instanceId],
  );
  const threads = useMemo(() => {
    const grouped = new Map<string, { threadId: string; threadTitle: string; runs: typeof runs }>();
    for (const run of runs) {
      const entry = grouped.get(run.threadId) ?? {
        threadId: run.threadId,
        threadTitle: run.threadTitle,
        runs: [],
      };
      entry.runs.push(run);
      grouped.set(run.threadId, entry);
    }
    return [...grouped.values()]
      .map((entry) => {
        const latest = [...entry.runs].sort(
          (a, b) => b.startedAt - a.startedAt || b.runIdx - a.runIdx,
        )[0];
        const peak = entry.runs.reduce<number | null>(
          (best, run) => (run.used != null && (best == null || run.used > best) ? run.used : best),
          null,
        );
        return {
          threadId: entry.threadId,
          threadTitle: entry.threadTitle,
          runsWithUsage: entry.runs.length,
          latestUsed: latest.used ?? null,
          latestSize: latest.size ?? null,
          peakUsed: peak,
        };
      })
      .sort((a, b) => b.runsWithUsage - a.runsWithUsage);
  }, [runs]);
  const byInstance = useMemo(
    () => (report?.byInstance ?? []).filter((row) => !instanceId || row.instanceId === instanceId),
    [report, instanceId],
  );
  const nameOf = (id: string) => instances.find((i) => i.id === id)?.displayName ?? id;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-8 py-8">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-medium text-text-primary">Usage</h1>
            <p className="mt-1 text-xs text-text-tertiary">
              Context fill is the agent's last snapshot at run end, not a token total. Cost is the
              latest value the agent reported; values are never summed here.
            </p>
          </div>
          <select
            aria-label="Filter by provider"
            value={instanceId}
            onChange={(e) => setInstanceId(e.target.value)}
            className="h-8 rounded-(--radius-sm) border border-border-subtle bg-(--input) px-2 text-xs text-text-secondary"
          >
            <option value="">All providers</option>
            {instances.map((instance) => (
              <option key={instance.id} value={instance.id}>
                {instance.displayName}
              </option>
            ))}
          </select>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="flex h-8 items-center gap-1.5 rounded-(--radius-sm) border border-border-subtle px-2.5 text-xs text-text-secondary transition hover:bg-hover disabled:opacity-40"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>

        {error && (
          <div
            role="alert"
            className="mt-4 rounded-(--radius-md) border border-danger/40 p-3 text-sm text-danger"
          >
            {error}
            <button onClick={() => void load()} className="ml-2 underline">
              Retry
            </button>
          </div>
        )}

        {!error && report && runs.length === 0 && (
          <div className="mt-10 flex flex-col items-center gap-1 rounded-(--radius-lg) border border-dashed border-border-subtle px-8 py-14 text-center">
            <p className="text-sm text-text-secondary">
              {instanceId ? "No usage for this provider" : "No usage data yet"}
            </p>
            <p className="max-w-md text-xs text-text-tertiary">
              Agents report usage through ACP `usage_update`. Runs that never sent one leave no row
              {report.totalRuns > 0 ? ` (${report.totalRuns} runs so far)` : ""}.
            </p>
          </div>
        )}

        {!error && report && runs.length > 0 && (
          <>
            <div className="mt-5 grid grid-cols-2 gap-2 lg:grid-cols-4">
              <Kpi label="Runs with usage" value={`${kpis.runsWithUsage} / ${kpis.totalRuns}`} />
              <Kpi
                label="Median context (run end)"
                value={formatTokenCount(kpis.medianContextUsed)}
              />
              <Kpi
                label="Peak context (run end)"
                value={formatContextFill(kpis.peakContextUsed, kpis.peakContextSize).text}
              />
              <Kpi
                label="Latest reported cost"
                value={formatUsageCost(kpis.latestCost)}
                hint="not summed"
              />
            </div>

            <div className="mt-5 flex gap-1" role="tablist" aria-label="Usage slices">
              {TABS.map((item) => (
                <button
                  key={item.id}
                  role="tab"
                  aria-selected={tab === item.id}
                  onClick={() => setTab(item.id)}
                  className={`rounded-(--radius-sm) px-2.5 py-1 text-xs transition ${
                    tab === item.id
                      ? "bg-active text-text-primary"
                      : "text-text-tertiary hover:bg-hover hover:text-text-secondary"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>

            <div className="mt-2 overflow-hidden rounded-(--radius-md) border border-border-subtle">
              {tab === "runs" && (
                <table className="w-full text-left text-sm">
                  <thead className="bg-surface text-[10px] tracking-wider text-text-tertiary uppercase">
                    <tr>
                      <th className="px-3 py-2">Thread</th>
                      <th className="px-3 py-2">Provider</th>
                      <th className="px-3 py-2">Context</th>
                      <th className="px-3 py-2">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((run) => (
                      <tr
                        key={run.runId}
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            void router.navigate({
                              to: "/thread/$threadId",
                              params: { threadId: run.threadId },
                            });
                          }
                        }}
                        className="cursor-pointer border-t border-border-subtle hover:bg-hover"
                        onClick={() =>
                          void router.navigate({
                            to: "/thread/$threadId",
                            params: { threadId: run.threadId },
                          })
                        }
                      >
                        <td className="max-w-[260px] truncate px-3 py-2 text-text-secondary">
                          {run.threadTitle}
                        </td>
                        <td className="px-3 py-2 text-xs text-text-tertiary">
                          {nameOf(run.instanceId)}
                        </td>
                        <td className="px-3 py-2 text-text-secondary">
                          {formatContextFill(run.used, run.size).text}
                        </td>
                        <td className="px-3 py-2 text-text-tertiary">
                          {formatUsageCost(run.cost)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {tab === "threads" && (
                <table className="w-full text-left text-sm">
                  <thead className="bg-surface text-[10px] tracking-wider text-text-tertiary uppercase">
                    <tr>
                      <th className="px-3 py-2">Thread</th>
                      <th className="px-3 py-2">Runs</th>
                      <th className="px-3 py-2">Latest context</th>
                      <th className="px-3 py-2">Peak</th>
                    </tr>
                  </thead>
                  <tbody>
                    {threads.map((thread) => (
                      <tr
                        key={thread.threadId}
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            void router.navigate({
                              to: "/thread/$threadId",
                              params: { threadId: thread.threadId },
                            });
                          }
                        }}
                        className="cursor-pointer border-t border-border-subtle hover:bg-hover"
                        onClick={() =>
                          void router.navigate({
                            to: "/thread/$threadId",
                            params: { threadId: thread.threadId },
                          })
                        }
                      >
                        <td className="max-w-[280px] truncate px-3 py-2 text-text-secondary">
                          {thread.threadTitle}
                        </td>
                        <td className="px-3 py-2 text-text-tertiary">{thread.runsWithUsage}</td>
                        <td className="px-3 py-2 text-text-secondary">
                          {formatContextFill(thread.latestUsed, thread.latestSize).text}
                        </td>
                        <td className="px-3 py-2 text-text-tertiary">
                          {formatTokenCount(thread.peakUsed)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {tab === "providers" && (
                <table className="w-full text-left text-sm">
                  <thead className="bg-surface text-[10px] tracking-wider text-text-tertiary uppercase">
                    <tr>
                      <th className="px-3 py-2">Provider</th>
                      <th className="px-3 py-2">Runs</th>
                      <th className="px-3 py-2">Median context</th>
                      <th className="px-3 py-2">Latest cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byInstance.map((row) => (
                      <tr key={row.instanceId} className="border-t border-border-subtle">
                        <td className="px-3 py-2 text-text-secondary">{nameOf(row.instanceId)}</td>
                        <td className="px-3 py-2 text-text-tertiary">{row.runsWithUsage}</td>
                        <td className="px-3 py-2 text-text-secondary">
                          {formatTokenCount(row.medianUsed)}
                        </td>
                        <td className="px-3 py-2 text-text-tertiary">
                          {formatUsageCost(row.latestCost)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
