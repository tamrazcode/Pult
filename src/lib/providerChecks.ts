import { ipcErrorMessage, providersPreflight } from "./ipc";
import type { InstanceInfo, PreflightReport } from "./types";

const CACHE_KEY = "pult.providerChecks.v1";

export interface CachedCheck {
  report: PreflightReport;
  at: number;
  /** When the last probe ran, successful or not. */
  lastAttemptAt?: number;
  /** Failure of the last probe; a stale `report` is still the last good one. */
  lastError?: string | null;
}

/** Last connection report per instance, persisted so startup shows it instantly. */
export function readCachedChecks(): Record<string, CachedCheck> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, CachedCheck>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeCachedChecks(checks: Record<string, CachedCheck>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(checks));
  } catch {
    // Private mode/quota: the in-memory result still drives this session.
  }
}

/**
 * Checks every enabled provider with bounded parallelism (default 3). A slow
 * or hung agent cannot delay the others past its own timeout.
 */
export async function preflightInstances(
  instances: InstanceInfo[],
  options: { concurrency?: number; timeoutMs?: number } = {},
): Promise<Record<string, CachedCheck>> {
  const { concurrency = 3, timeoutMs = 20_000 } = options;
  const targets = instances.filter((instance) => instance.enabled);
  const results = readCachedChecks();
  let cursor = 0;

  const runOne = async (instance: InstanceInfo) => {
    try {
      const report = await Promise.race([
        providersPreflight(instance.id),
        new Promise<never>((_, reject) =>
          window.setTimeout(() => reject(new Error("preflight timed out")), timeoutMs),
        ),
      ]);
      const now = Date.now();
      results[instance.id] = { report, at: now, lastAttemptAt: now, lastError: null };
    } catch (err) {
      // Keep the last good report; a failed probe must not erase a known state
      // — but it must be distinguishable from a fresh Connected.
      const previous = results[instance.id];
      if (previous) {
        results[instance.id] = {
          ...previous,
          lastAttemptAt: Date.now(),
          lastError: ipcErrorMessage(err),
        };
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    while (cursor < targets.length) {
      const instance = targets[cursor];
      cursor += 1;
      await runOne(instance);
    }
  });
  await Promise.all(workers);
  writeCachedChecks(results);
  return results;
}
