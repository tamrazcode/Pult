import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DetectedAgent, PreflightReport } from "../src/lib/types";

const {
  providersAuthenticate,
  providersInstancesList,
  providersInstancesSave,
  providersPreflight,
} = vi.hoisted(() => ({
  providersAuthenticate: vi.fn(),
  providersInstancesList: vi.fn(),
  providersInstancesSave: vi.fn(),
  providersPreflight: vi.fn(),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    providersAuthenticate,
    providersInstancesList,
    providersInstancesSave,
    providersPreflight,
  };
});

import { ConnectRow } from "../src/components/settings/AgentConnect";
import { SignInActions } from "../src/components/settings/SignInActions";
import { shouldShowSignIn, statusLine } from "../src/routes/settings.providers";
import type { InstanceInfo } from "../src/lib/types";

const agent: DetectedAgent = {
  id: "mock-detect",
  displayName: "Mock CLI",
  command: "node",
  suggestedInstanceId: "mock",
  suggestedCommand: ["node", "agent.mjs"],
  notes: "detected mock",
};

function report(overrides: Partial<PreflightReport> = {}): PreflightReport {
  return {
    instanceId: "mock",
    agentName: "Mock",
    agentVersion: "0.1.0",
    loadSession: true,
    promptImage: false,
    authRequired: false,
    authHint: null,
    configOptions: [],
    authMethods: [],
    ...overrides,
  };
}

describe("provider sign-in", () => {
  beforeEach(() => {
    providersInstancesList.mockReset().mockResolvedValue([]);
    providersInstancesSave.mockReset().mockResolvedValue(undefined);
    providersPreflight.mockReset();
    providersAuthenticate.mockReset();
  });

  it("agent-managed sign-in goes from Needs sign-in to Connected", async () => {
    providersPreflight.mockResolvedValue(
      report({
        authRequired: true,
        authMethods: [{ id: "mock-token", name: "Mock sign-in" }],
      }),
    );
    providersAuthenticate.mockResolvedValue(report());
    render(<ConnectRow agent={agent} alreadyAdded={false} onAdded={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Needs sign-in")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Sign in: Mock sign-in/ }));
    await waitFor(() => expect(providersAuthenticate).toHaveBeenCalledWith("mock", "mock-token"));
    expect(await screen.findByText(/Connected · 0\.1\.0/)).toBeTruthy();
  });

  it("keeps Still needs sign-in when the follow-up probe stays locked", async () => {
    providersPreflight.mockResolvedValue(
      report({ authRequired: true, authMethods: [{ id: "mock-token", name: "Mock" }] }),
    );
    providersAuthenticate.mockResolvedValue(
      report({ authRequired: true, authHint: "token missing" }),
    );
    render(<ConnectRow agent={agent} alreadyAdded={false} onAdded={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    fireEvent.click(await screen.findByRole("button", { name: /Sign in: Mock/ }));
    expect(await screen.findByText("Still needs sign-in")).toBeTruthy();
    expect(screen.getAllByText("Still needs sign-in").length).toBeGreaterThan(0);
  });

  it("surfaces authenticate errors without claiming Connected", async () => {
    providersPreflight.mockResolvedValue(
      report({ authRequired: true, authMethods: [{ id: "mock-token", name: "Mock" }] }),
    );
    providersAuthenticate.mockRejectedValue(new Error("invalid credentials"));
    render(<ConnectRow agent={agent} alreadyAdded={false} onAdded={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    fireEvent.click(await screen.findByRole("button", { name: /Sign in: Mock/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid credentials");
    expect(screen.queryByText(/Connected/)).toBeNull();
  });

  it("a fresh report outranks the cached needs_auth status", () => {
    const info: InstanceInfo = {
      id: "mock",
      displayName: "Mock",
      enabled: true,
      driver: "mock",
      command: "node",
      args: [],
      env: {},
      status: "needs_auth",
      promptImage: false,
      loadSession: false,
      modes: [],
      configOptions: [],
      authMethods: [],
    };
    expect(shouldShowSignIn(info, undefined)).toBe(true);
    expect(shouldShowSignIn(info, report({ authRequired: false }))).toBe(false);
    expect(statusLine(info, report({ authRequired: false }), false).text).toMatch(/Connected/);
    expect(statusLine(info, undefined, false).text).toBe("Needs sign-in");
  });

  it("terminal method shows a copyable command and never calls authenticate", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const onSignIn = vi.fn();
    const onRecheck = vi.fn();
    render(
      <SignInActions
        launch={{ command: "codex", args: ["acp"], env: { BASE: "1" } }}
        authMethods={[
          {
            type: "terminal",
            id: "mock-term",
            name: "CLI login",
            args: ["--login"],
            env: { MOCK_LOGIN: "1" },
          },
        ]}
        signingIn={false}
        authAttempted={false}
        onSignIn={onSignIn}
        onRecheck={onRecheck}
      />,
    );

    expect(screen.queryByRole("button", { name: /Sign in/ })).toBeNull();
    expect(screen.getByText(/codex acp --login/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy command" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Re-check" }));
    expect(onRecheck).toHaveBeenCalled();
    expect(onSignIn).not.toHaveBeenCalled();
  });
});
