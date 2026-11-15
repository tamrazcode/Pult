import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as IpcModule from "../src/lib/ipc";
import type { InstanceInfo, PreflightReport } from "../src/lib/types";

const { providersPreflight } = vi.hoisted(() => ({
  providersPreflight: vi.fn<(instanceId: string) => Promise<PreflightReport>>(),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    providersPreflight,
  };
});

import { preflightInstances, readCachedChecks } from "../src/lib/providerChecks";

const CACHE_KEY = "pult.providerChecks.v1";

function makeInstance(id: string, enabled = true): InstanceInfo {
  return {
    id,
    displayName: id,
    enabled,
    driver: "mock",
    command: "node",
    args: [],
    env: {},
    status: "stopped",
    promptImage: false,
    loadSession: false,
    modes: [],
    configOptions: [],
    authMethods: [],
  };
}

function makeReport(instanceId: string, overrides: Partial<PreflightReport> = {}): PreflightReport {
  return {
    instanceId,
    agentName: instanceId,
    agentVersion: "1.0.0",
    loadSession: true,
    promptImage: true,
    authRequired: false,
    authHint: null,
    configOptions: [],
    authMethods: [],
    ...overrides,
  };
}

describe("providerChecks", () => {
  beforeEach(() => {
    window.localStorage.clear();
    providersPreflight.mockReset();
  });

  it("skips disabled instances", async () => {
    providersPreflight.mockImplementation(async (id) => makeReport(id));

    const results = await preflightInstances([
      makeInstance("enabled-1", true),
      makeInstance("disabled-1", false),
      makeInstance("enabled-2", true),
    ]);

    expect(providersPreflight).toHaveBeenCalledTimes(2);
    expect(providersPreflight).toHaveBeenCalledWith("enabled-1");
    expect(providersPreflight).toHaveBeenCalledWith("enabled-2");
    expect(providersPreflight).not.toHaveBeenCalledWith("disabled-1");
    expect(Object.keys(results)).toEqual(["enabled-1", "enabled-2"]);
  });

  it("bounds in-flight probes by the concurrency option", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const resolvers: Array<() => void> = [];

    providersPreflight.mockImplementation(
      (id) =>
        new Promise<PreflightReport>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          resolvers.push(() => {
            inFlight -= 1;
            resolve(makeReport(id));
          });
        }),
    );

    const promise = preflightInstances(
      [makeInstance("a"), makeInstance("b"), makeInstance("c"), makeInstance("d")],
      { concurrency: 2 },
    );

    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    expect(maxInFlight).toBe(2);

    resolvers.shift()!();
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    expect(maxInFlight).toBe(2);

    resolvers.shift()!();
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    expect(maxInFlight).toBe(2);

    while (resolvers.length > 0) resolvers.shift()!();
    await promise;
    expect(maxInFlight).toBe(2);
  });

  it("persists results under pult.providerChecks.v1 and readCachedChecks returns them", async () => {
    const report = makeReport("claude", { agentName: "Claude Code" });
    providersPreflight.mockResolvedValueOnce(report);

    await preflightInstances([makeInstance("claude")]);

    const raw = window.localStorage.getItem(CACHE_KEY);
    expect(raw).not.toBeNull();
    const cached = readCachedChecks();
    expect(cached.claude?.report).toEqual(report);
    expect(typeof cached.claude?.at).toBe("number");
  });

  it("records lastError and lastAttemptAt while retaining prior cached report on probe failure, then clears lastError on success", async () => {
    const previousReport = makeReport("codex", { agentName: "Codex Previous" });
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ codex: { report: previousReport, at: 12345 } }),
    );

    const beforeFail = Date.now();
    providersPreflight.mockRejectedValueOnce(new Error("spawn failed"));

    const failedResults = await preflightInstances([makeInstance("codex")]);

    expect(failedResults.codex?.report).toEqual(previousReport);
    expect(failedResults.codex?.at).toBe(12345);
    expect(failedResults.codex?.lastError).toBe("spawn failed");
    expect(failedResults.codex?.lastAttemptAt).toBeGreaterThanOrEqual(beforeFail);
    expect(readCachedChecks().codex).toEqual(failedResults.codex);

    const freshReport = makeReport("codex", { agentName: "Codex Recovered" });
    providersPreflight.mockResolvedValueOnce(freshReport);

    const recoveredResults = await preflightInstances([makeInstance("codex")]);

    expect(recoveredResults.codex?.report).toEqual(freshReport);
    expect(recoveredResults.codex?.at).toBeGreaterThanOrEqual(beforeFail);
    expect(recoveredResults.codex?.lastError).toBeNull();
    expect(readCachedChecks().codex).toEqual(recoveredResults.codex);
  });
});
