import type { Page } from "@playwright/test";

export interface TauriFixtures {
  instances?: unknown[];
  detected?: unknown[];
  mcpServers?: unknown[];
  processTree?: unknown[];
  projects?: unknown[];
  threads?: unknown[];
}

/**
 * Minimal Tauri IPC mock so the real React app can run in a plain browser.
 * Fixtures are mutable: a save command updates them, so reloads see the write.
 */
export async function installTauriMock(page: Page, fixtures: TauriFixtures = {}) {
  await page.addInitScript((data) => {
    const invokes: Array<{ cmd: string; args: unknown }> = [];
    (window as unknown as { __PULT_INVOKES__: typeof invokes }).__PULT_INVOKES__ =
      invokes;
    let nextCallback = 0;
    const callbacks = new Map<number, (...args: unknown[]) => void>();
    const preflight = (instanceId: string) => ({
      instanceId,
      agentName: "E2E agent",
      agentVersion: "1.0.0",
      loadSession: true,
      promptImage: true,
      authRequired: false,
      authHint: null,
      configOptions: [],
      authMethods: [],
    });
    const internals = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { windowLabel: "main", label: "main" },
      },
      transformCallback(callback: (...args: unknown[]) => void) {
        const id = ++nextCallback;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback(id: number) {
        callbacks.delete(id);
      },
      convertFileSrc(path: string) {
        return path;
      },
      invoke(cmd: string, args: Record<string, unknown> = {}) {
        invokes.push({ cmd, args });
        switch (cmd) {
          case "providers_instances_list":
            return Promise.resolve(data.instances ?? []);
          case "providers_detect_installed":
            return Promise.resolve(data.detected ?? []);
          case "providers_instances_save":
            data.instances = args.instances as unknown[];
            return Promise.resolve(null);
          case "providers_preflight":
            return Promise.resolve(preflight(String(args.instanceId ?? "")));
          case "providers_warmup":
          case "providers_authenticate":
            return Promise.resolve(null);
          case "settings_get":
            return Promise.resolve(
              args.key === "onboarding_completed" ? true : null,
            );
          case "settings_set":
            return Promise.resolve(null);
          case "projects_list":
            return Promise.resolve(data.projects ?? []);
          case "threads_list":
            return Promise.resolve(data.threads ?? []);
          case "mcp_list_servers":
            return Promise.resolve(data.mcpServers ?? []);
          case "mcp_test_connection":
          case "mcp_reconnect_server":
            return Promise.resolve({
              ok: true,
              serverInfo: { name: "mock-mcp", version: "1.0.0" },
              protocolVersion: "2025-06-18",
              tools: [
                {
                  name: "echo",
                  description: "Echo text",
                  inputSchema: { type: "object" },
                },
              ],
              latencyMs: 12,
              error: null,
            });
          case "mcp_server_logs":
            return Promise.resolve(["mock stderr line"]);
          case "mcp_server_stats":
            return Promise.resolve({
              callsTotal: 3,
              errorsTotal: 1,
              lastLatencyMs: 12,
            });
          case "diagnostics_process_tree":
            return Promise.resolve(data.processTree ?? []);
          case "diagnostics_kill_process":
            return Promise.resolve(null);
          case "plugin:event|listen":
            return Promise.resolve(1);
          case "plugin:event|unlisten":
            return Promise.resolve(null);
          case "app_version":
            return Promise.resolve("e2e");
          default:
            return Promise.resolve(null);
        }
      },
    };
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ =
      internals;
  }, fixtures);
}
