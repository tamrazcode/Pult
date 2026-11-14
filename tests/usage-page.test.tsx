import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UsageReport } from "../src/lib/types";

const { usageReport, providersInstancesList, navigate } = vi.hoisted(() => ({
  usageReport: vi.fn(),
  providersInstancesList: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, usageReport, providersInstancesList };
});
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, useRouter: () => ({ navigate }) };
});

import { UsagePage } from "../src/routes/usage";

const report: UsageReport = {
  totalRuns: 2,
  runs: [
    {
      runId: "r2",
      threadId: "th2",
      threadTitle: "Second",
      runIdx: 1,
      status: "finished",
      instanceId: "codex",
      startedAt: 200,
      usageTs: 20,
      used: 50_000,
      size: 200_000,
      cost: { amount: 0.12, currency: "USD" },
    },
    {
      runId: "r1",
      threadId: "th1",
      threadTitle: "First",
      runIdx: 0,
      status: "finished",
      instanceId: "mock",
      startedAt: 100,
      usageTs: 10,
      used: 10_000,
      size: 100_000,
      cost: { amount: 0.05, currency: "USD" },
    },
  ],
  byThread: [
    {
      threadId: "th1",
      threadTitle: "First",
      runsWithUsage: 1,
      latestRunId: "r1",
      latestInstanceId: "mock",
      latestStartedAt: 100,
      latestUsed: 10_000,
      latestSize: 100_000,
      peakUsed: 10_000,
      latestCost: { amount: 0.05, currency: "USD" },
    },
  ],
  byInstance: [
    {
      instanceId: "mock",
      runsWithUsage: 1,
      medianUsed: 10_000,
      peakUsed: 10_000,
      latestCost: { amount: 0.05, currency: "USD" },
      lastUsedAt: 10,
    },
  ],
};

describe("usage page", () => {
  beforeEach(() => {
    usageReport.mockReset().mockResolvedValue(report);
    providersInstancesList.mockReset().mockResolvedValue([
      {
        id: "mock",
        displayName: "Mock agent",
        enabled: true,
        driver: "mock",
        command: "node",
        args: [],
        env: {},
        status: "stopped",
        promptImage: false,
        loadSession: true,
        modes: [],
        configOptions: [],
        authMethods: [],
      },
      {
        id: "codex",
        displayName: "Codex",
        enabled: true,
        driver: "acp",
        command: "codex",
        args: [],
        env: {},
        status: "stopped",
        promptImage: false,
        loadSession: true,
        modes: [],
        configOptions: [],
        authMethods: [],
      },
    ]);
    navigate.mockReset().mockResolvedValue(undefined);
  });

  it("renders an honest empty state", async () => {
    usageReport.mockResolvedValue({ totalRuns: 4, runs: [], byThread: [], byInstance: [] });
    render(<UsagePage />);
    expect(await screen.findByText("No usage data yet")).toBeTruthy();
    expect(screen.getByText(/4 runs so far/)).toBeTruthy();
    expect(screen.queryByText(/summed/i)).toBeTruthy();
  });

  it("renders KPIs, tabs, filter and opens a thread without grand totals", async () => {
    render(<UsagePage />);
    expect(await screen.findByText("Peak context (run end)")).toBeTruthy();
    expect(screen.getByText("Latest reported cost")).toBeTruthy();
    expect(screen.getByText("not summed")).toBeTruthy();
    expect(screen.getAllByText("$0.12").length).toBeGreaterThan(0);
    expect(screen.queryByText("$0.17")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Providers" }));
    expect(await screen.findByText("Median context")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Threads" }));
    expect(await screen.findByText("Peak")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Runs" }));
    fireEvent.change(screen.getByLabelText("Filter by provider"), {
      target: { value: "codex" },
    });
    await waitFor(() => expect(screen.getByText("Second")).toBeTruthy());
    await waitFor(() => expect(screen.queryByText("First")).toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: "Threads" }));
    expect(await screen.findByText("Second")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("First")).toBeNull());
    fireEvent.click(screen.getByRole("tab", { name: "Runs" }));
    fireEvent.click(screen.getByText("Second"));
    expect(navigate).toHaveBeenCalledWith({
      to: "/thread/$threadId",
      params: { threadId: "th2" },
    });
  });

  it("shows a provider-scoped empty state when that provider has no usage", async () => {
    providersInstancesList.mockResolvedValue([
      {
        id: "mock",
        displayName: "Mock agent",
        enabled: true,
        driver: "mock",
        command: "node",
        args: [],
        env: {},
        status: "stopped",
        promptImage: false,
        loadSession: true,
        modes: [],
        configOptions: [],
        authMethods: [],
      },
      {
        id: "codex",
        displayName: "Codex",
        enabled: true,
        driver: "acp",
        command: "codex",
        args: [],
        env: {},
        status: "stopped",
        promptImage: false,
        loadSession: true,
        modes: [],
        configOptions: [],
        authMethods: [],
      },
    ]);
    usageReport.mockResolvedValue({
      ...report,
      runs: [report.runs[1]],
      byThread: [],
      byInstance: [],
    });
    render(<UsagePage />);
    await screen.findByText("Peak context (run end)");
    fireEvent.change(screen.getByLabelText("Filter by provider"), {
      target: { value: "codex" },
    });
    expect(await screen.findByText("No usage for this provider")).toBeTruthy();
  });

  it("surfaces IPC errors and retries", async () => {
    usageReport.mockRejectedValueOnce(new Error("store unavailable"));
    render(<UsagePage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("store unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(usageReport).toHaveBeenCalledTimes(2));
  });
});
