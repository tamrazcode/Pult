import { describe, expect, it } from "vitest";
import type { UsageReport } from "../src/lib/types";
import {
  computeUsageKpis,
  formatContextFill,
  formatTokenCount,
  formatUsageCost,
  medianNumber,
} from "../src/lib/usage";

const report: UsageReport = {
  totalRuns: 4,
  runs: [
    {
      runId: "r3",
      threadId: "th1",
      threadTitle: "One",
      runIdx: 0,
      status: "finished",
      instanceId: "mock",
      startedAt: 300,
      usageTs: 30,
      used: 50_000,
      size: 200_000,
      cost: null,
    },
    {
      runId: "r2",
      threadId: "th1",
      threadTitle: "One",
      runIdx: 1,
      status: "finished",
      instanceId: "mock",
      startedAt: 200,
      usageTs: 20,
      used: 20_000,
      size: 200_000,
      cost: { amount: 0.12, currency: "USD" },
    },
    {
      runId: "r1",
      threadId: "th2",
      threadTitle: "Two",
      runIdx: 0,
      status: "finished",
      instanceId: "codex",
      startedAt: 100,
      usageTs: 10,
      used: 10_000,
      size: 100_000,
      cost: { amount: 0.05, currency: "USD" },
    },
  ],
  byThread: [],
  byInstance: [],
};

describe("usage helpers", () => {
  it("medians ignore empty and non-finite values", () => {
    expect(medianNumber([])).toBeNull();
    expect(medianNumber([10, 30, 20])).toBe(20);
    expect(medianNumber([10, 20, 30, 40])).toBe(25);
    expect(medianNumber([10, Number.NaN, Number.POSITIVE_INFINITY, 30])).toBe(20);
  });

  it("formats token counts and context fill without dividing by zero", () => {
    expect(formatTokenCount(null)).toBe("—");
    expect(formatTokenCount(850)).toBe("850");
    expect(formatTokenCount(12_340)).toBe("12.3k");
    expect(formatTokenCount(200_000)).toBe("200k");
    expect(formatContextFill(50_000, 200_000)).toEqual({
      text: "50.0k / 200k (25%)",
      pct: 25,
    });
    expect(formatContextFill(5, 0).pct).toBeNull();
  });

  it("formats costs, including sub-cent and non-USD currencies", () => {
    expect(formatUsageCost({ amount: 0.01, currency: "USD" })).toBe("$0.01");
    expect(formatUsageCost({ amount: 0.004, currency: "USD" })).toBe("$0.004");
    expect(formatUsageCost({ amount: 12, currency: "credits" })).toBe("12 credits");
    expect(formatUsageCost(null)).toBe("—");
  });

  it("computes KPIs without summing gauges or costs", () => {
    const kpis = computeUsageKpis(report);
    expect(kpis.runsWithUsage).toBe(3);
    expect(kpis.totalRuns).toBe(4);
    expect(kpis.threadCount).toBe(2);
    expect(kpis.medianContextUsed).toBe(20_000);
    expect(kpis.peakContextUsed).toBe(50_000);
    expect(kpis.peakContextPct).toBe(25);
    expect(kpis.latestCost).toEqual({ amount: 0.12, currency: "USD" });
    expect(kpis.runsWithCost).toBe(2);

    const codex = computeUsageKpis(report, "codex");
    expect(codex.runsWithUsage).toBe(1);
    expect(codex.peakContextUsed).toBe(10_000);
    expect(codex.latestCost?.amount).toBe(0.05);

    const empty = computeUsageKpis({ totalRuns: 0, runs: [], byThread: [], byInstance: [] });
    expect(empty.runsWithUsage).toBe(0);
    expect(empty.medianContextUsed).toBeNull();
    expect(empty.latestCost).toBeNull();
  });
});
