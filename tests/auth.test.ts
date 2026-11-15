import { describe, expect, it, vi } from "vitest";
import type { AuthMethod } from "../src/lib/types";

const invoke = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));
vi.mock("../src/lib/tauri", () => ({ isTauri: () => true }));

import {
  buildTerminalAuthCommand,
  isAgentAuthMethod,
  isTerminalAuthMethod,
  splitAuthMethods,
} from "../src/lib/auth";
import { providersAuthenticate } from "../src/lib/ipc";

describe("auth helpers", () => {
  it("splits agent (omitted or 'agent') and terminal methods, ignoring unknown types", () => {
    const methods: AuthMethod[] = [
      { id: "a", name: "Agent" },
      { type: "agent", id: "b", name: "Agent B" },
      { type: "terminal", id: "t", name: "Terminal" },
      { type: "carrier-pigeon", id: "x", name: "Unknown" },
      { id: "", name: "No id" },
    ];
    const split = splitAuthMethods(methods);
    expect(split.agent.map((m) => m.id)).toEqual(["a", "b"]);
    expect(split.terminal.map((m) => m.id)).toEqual(["t"]);
    expect(isTerminalAuthMethod(methods[2])).toBe(true);
    expect(isAgentAuthMethod(methods[0])).toBe(true);
    expect(isAgentAuthMethod(methods[2])).toBe(false);
  });

  it("builds a terminal command with appended args and quoting", () => {
    const command = buildTerminalAuthCommand(
      { command: "npx", args: ["-y", "@agent/x acp"] },
      { type: "terminal", id: "t", name: "Login", args: ["--login", "a b"] },
    );
    expect(command).toBe('npx -y "@agent/x acp" --login "a b"');
  });

  it("includes terminal env overrides without mutating the base launch", () => {
    const launch = { command: "codex", args: ["acp"], env: { BASE: "1" } };
    const command = buildTerminalAuthCommand(launch, {
      type: "terminal",
      id: "t",
      name: "Login",
      env: { MOCK_LOGIN: "1", BASE: "2" },
    });
    expect(command).toBe("BASE=2 MOCK_LOGIN=1 codex acp");
    expect(launch.env).toEqual({ BASE: "1" });
  });

  it("formats PowerShell env assignment and quoted path with spaces", () => {
    const command = buildTerminalAuthCommand(
      { command: "cmd", args: [], env: { KEY: "value" } },
      { type: "terminal", id: "t", name: "Login", args: ["arg with space"] },
      "powershell",
    );
    expect(command).toBe('$env:KEY="value"; & "cmd" "arg with space"');
    expect(command).not.toMatch(/\bKEY=value\b/);
  });

  it("formats POSIX env assignment on macOS/Linux", () => {
    const command = buildTerminalAuthCommand(
      { command: "cmd", args: ["arg"], env: { KEY: "value" } },
      { type: "terminal", id: "t", name: "Login" },
      "posix",
    );
    expect(command).toMatch(/^KEY=("value"|value) cmd arg$/);
    expect(command).not.toContain("$env:");
  });

  it("providersAuthenticate invokes providers_authenticate", async () => {
    invoke.mockReset().mockResolvedValue({ authRequired: false });
    await providersAuthenticate("mock", "mock-token");
    expect(invoke).toHaveBeenCalledWith("providers_authenticate", {
      instanceId: "mock",
      methodId: "mock-token",
    });
  });
});
