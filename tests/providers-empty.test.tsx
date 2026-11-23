import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";
import type { InstanceInfo, PreflightReport } from "../src/lib/types";

const {
  tauriState,
  providersConfigStatus,
  providersInstancesList,
  providersDetectInstalled,
  providersPreflight,
} = vi.hoisted(() => ({
  tauriState: { enabled: false },
  providersConfigStatus: vi.fn<() => Promise<string | null>>(async () => null),
  providersInstancesList: vi.fn<() => Promise<InstanceInfo[]>>(async () => []),
  providersDetectInstalled: vi.fn(async () => []),
  providersPreflight: vi.fn<(id: string) => Promise<PreflightReport>>(),
}));

vi.mock("../src/lib/tauri", () => ({
  isTauri: () => tauriState.enabled,
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    providersConfigStatus,
    providersInstancesList,
    providersDetectInstalled,
    providersPreflight,
    onAgentCaps: vi.fn(async () => () => {}),
    onAgentProcess: vi.fn(async () => () => {}),
  };
});

import { Route } from "../src/routes/settings.providers";

const ProvidersSettings = Route.options.component!;

function makeInstance(id: string, displayName: string): InstanceInfo {
  return {
    id,
    displayName,
    enabled: false,
    driver: "acp",
    command: id,
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

describe("ProvidersSettings empty state", () => {
  beforeEach(() => {
    tauriState.enabled = false;
    providersConfigStatus.mockReset().mockResolvedValue(null);
    providersInstancesList.mockReset().mockResolvedValue([]);
    providersDetectInstalled.mockReset().mockResolvedValue([]);
    providersPreflight.mockReset();
    window.localStorage.clear();
  });

  it("shows a first-run empty state and an add action outside Tauri", () => {
    render(<ProvidersSettings />);
    const emptyHeading = screen.getByText("No providers yet");
    expect(emptyHeading).toBeInTheDocument();
    const detailPane = emptyHeading.closest(".overflow-y-auto");
    expect(detailPane).not.toBeNull();
    expect(detailPane).not.toHaveClass("hidden");
    expect(detailPane).toHaveClass("block");
    expect(screen.getAllByRole("button", { name: /add provider/i }).length).toBeGreaterThan(0);
  });

  it("keeps the detail empty state unhidden in compact layout when zero instances are configured", async () => {
    tauriState.enabled = true;
    providersInstancesList.mockResolvedValue([]);

    render(<ProvidersSettings />);

    const emptyHeading = await screen.findByText("No providers yet");
    const detailPane = emptyHeading.closest(".overflow-y-auto");
    expect(detailPane).not.toBeNull();
    expect(detailPane).not.toHaveClass("hidden");
    expect(detailPane).toHaveClass("block");
  });

  it("surfaces config.toml parse errors and renders Back to providers control at 1040px width after selecting a provider", async () => {
    tauriState.enabled = true;
    providersConfigStatus.mockResolvedValue("invalid TOML at line 3");
    providersInstancesList.mockResolvedValue([
      makeInstance("claude", "Claude Code"),
      makeInstance("codex", "Codex"),
    ]);

    render(
      <div style={{ width: 1040 }}>
        <ProvidersSettings />
      </div>,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/invalid TOML at line 3/);

    const providerBtn = await screen.findByRole("button", { name: /Claude Code/i });
    const backBtn = screen.getByRole("button", { name: /back to providers/i });
    expect(backBtn).toBeInTheDocument();
    const detailPane = backBtn.parentElement;
    expect(detailPane).toHaveClass("hidden");

    fireEvent.click(providerBtn);
    expect(detailPane).not.toHaveClass("hidden");
    expect(detailPane).toHaveClass("block");

    fireEvent.click(backBtn);
    expect(detailPane).toHaveClass("hidden");
  });
});
