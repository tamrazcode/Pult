import type { AuthMethod } from "./types";

/** Terminal methods run the CLI directly; they must never go to `authenticate`. */
export function isTerminalAuthMethod(method: AuthMethod): boolean {
  return method.type === "terminal";
}

/** No type (schema default) or explicit `agent` means the RPC flow. */
export function isAgentAuthMethod(method: AuthMethod): boolean {
  return !method.type || method.type === "agent";
}

/** Partitions advertised methods into what the UI can actually do. */
export function splitAuthMethods(methods: AuthMethod[]): {
  agent: AuthMethod[];
  terminal: AuthMethod[];
} {
  return {
    agent: methods.filter((m) => isAgentAuthMethod(m) && Boolean(m.id)),
    terminal: methods.filter((m) => isTerminalAuthMethod(m) && Boolean(m.id)),
  };
}

function quote(value: string): string {
  return /[\s"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

/**
 * Copyable terminal-auth invocation: base launch + method args + env overrides
 * (method env wins, neither input is mutated).
 */
export function buildTerminalAuthCommand(
  launch: { command: string; args: string[]; env?: Record<string, string> },
  method: AuthMethod,
): string {
  const env = { ...(launch.env ?? {}), ...(method.env ?? {}) };
  const envPrefix = Object.entries(env)
    .map(([key, value]) => `${key}=${quote(value)}`)
    .join(" ");
  const argv = [launch.command, ...launch.args, ...(method.args ?? [])].map(quote).join(" ");
  return envPrefix ? `${envPrefix} ${argv}` : argv;
}
