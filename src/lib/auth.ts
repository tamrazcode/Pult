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

export type AuthShell = "powershell" | "posix";

/** The terminal the user is most likely to paste into on this OS. */
export function detectDefaultAuthShell(): AuthShell {
  if (typeof navigator === "undefined") return "posix";
  const platform = navigator.platform ?? "";
  return /win/i.test(platform) ? "powershell" : "posix";
}

function quote(value: string): string {
  return value === "" || /[\s"']/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function powershellQuote(value: string): string {
  return `"${value.replace(/`/g, "``").replace(/"/g, '`"')}"`;
}

/**
 * Copyable terminal-auth invocation: base launch + method args + env overrides
 * (method env wins, neither input is mutated). Power shell needs `$env:`
 * assignments and `&` for the call operator; POSIX shells use `KEY=value cmd`.
 */
export function buildTerminalAuthCommand(
  launch: { command: string; args: string[]; env?: Record<string, string> },
  method: AuthMethod,
  shell: AuthShell = detectDefaultAuthShell(),
): string {
  const env = { ...(launch.env ?? {}), ...(method.env ?? {}) };
  const argv = [launch.command, ...launch.args, ...(method.args ?? [])];
  if (shell === "powershell") {
    const assignments = Object.entries(env).map(
      ([key, value]) => `$env:${key}=${powershellQuote(value)}`,
    );
    const call = `& ${argv.map(powershellQuote).join(" ")}`;
    return assignments.length > 0 ? `${assignments.join("; ")}; ${call}` : call;
  }
  const envPrefix = Object.entries(env)
    .map(([key, value]) => `${key}=${quote(value)}`)
    .join(" ");
  const call = argv.map(quote).join(" ");
  return envPrefix ? `${envPrefix} ${call}` : call;
}
