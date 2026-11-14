import type { UsageCost, UsageReport } from "./types";

export interface UsageKpis {
  runsWithUsage: number;
  totalRuns: number;
  threadCount: number;
  medianContextUsed: number | null;
  peakContextUsed: number | null;
  peakContextSize: number | null;
  peakContextPct: number | null;
  latestCost: UsageCost | null;
  runsWithCost: number;
}

export function medianNumber(values: readonly number[]): number | null {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 === 1 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

export function formatTokenCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (value >= 100_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function formatContextFill(
  used: number | null | undefined,
  size: number | null | undefined,
): { text: string; pct: number | null } {
  if (used === null || used === undefined) return { text: "—", pct: null };
  if (size === null || size === undefined || size <= 0) {
    return { text: formatTokenCount(used), pct: null };
  }
  const pct = Math.round((used / size) * 100);
  return { text: `${formatTokenCount(used)} / ${formatTokenCount(size)} (${pct}%)`, pct };
}

export function formatUsageCost(cost: UsageCost | null | undefined): string {
  if (!cost || !Number.isFinite(cost.amount)) return "—";
  const currency = cost.currency ?? "USD";
  if (currency.toUpperCase() === "USD") {
    const digits = cost.amount > 0 && cost.amount < 0.01 ? 3 : 2;
    return `$${cost.amount.toFixed(digits)}`;
  }
  return `${cost.amount} ${currency}`;
}

/**
 * Honest KPIs: gauges (context fill) are never summed, and the cost shown is
 * the latest agent-reported value, not a total.
 */
export function computeUsageKpis(report: UsageReport, instanceId?: string | null): UsageKpis {
  const runs = report.runs.filter((run) => !instanceId || run.instanceId === instanceId);
  const used = runs.map((run) => run.used).filter((value): value is number => value != null);
  const peakRun = runs.reduce<(typeof runs)[number] | null>((best, run) => {
    if (run.used == null) return best;
    return !best || best.used == null || run.used > best.used ? run : best;
  }, null);
  const latestWithCost = runs.reduce<(typeof runs)[number] | null>((best, run) => {
    if (!run.cost) return best;
    return !best || run.startedAt > best.startedAt ? run : best;
  }, null);
  const threads = new Set(runs.map((run) => run.threadId));
  const peakPct =
    peakRun?.used != null && peakRun.size != null && peakRun.size > 0
      ? Math.round((peakRun.used / peakRun.size) * 100)
      : null;

  return {
    runsWithUsage: runs.length,
    totalRuns: report.totalRuns,
    threadCount: threads.size,
    medianContextUsed: medianNumber(used),
    peakContextUsed: peakRun?.used ?? null,
    peakContextSize: peakRun?.size ?? null,
    peakContextPct: peakPct,
    latestCost: latestWithCost?.cost ?? null,
    runsWithCost: runs.filter((run) => run.cost != null).length,
  };
}
