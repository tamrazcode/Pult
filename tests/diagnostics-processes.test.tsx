import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessesDiagnostics } from "../src/routes/settings.diagnostics";

const mocks = vi.hoisted(() => ({
  diagnosticsProcessTree: vi.fn(),
  diagnosticsKillProcess: vi.fn(),
  diagnosticsFrames: vi.fn(),
  mcpListServers: vi.fn(),
  mcpServerLogs: vi.fn(),
  mcpServerStats: vi.fn(),
  providersInstancesList: vi.fn(),
}));

vi.mock("../src/lib/ipc", () => mocks);
vi.mock("../src/lib/tauri", () => ({ isTauri: () => true }));

const tree = [
  {
    pid: 100,
    parentPid: null,
    name: "pult-core",
    role: "core",
    status: "running",
    killable: false,
    children: [
      {
        pid: 200,
        parentPid: 100,
        name: "claude",
        role: "agent",
        label: "Claude",
        threadId: "th-1",
        status: "running",
        cpuPercent: 1.2,
        memoryBytes: 64 * 1024 * 1024,
        killable: true,
        children: [],
      },
    ],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.diagnosticsProcessTree.mockResolvedValue(tree);
  mocks.diagnosticsKillProcess.mockResolvedValue(undefined);
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("diagnostics process tree", () => {
  it("shows only the Pult tree and collapses children", async () => {
    const user = userEvent.setup();
    render(<ProcessesDiagnostics />);
    expect(await screen.findByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("pid 200")).toBeInTheDocument();
    expect(screen.getByText("1.2%")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Collapse" }));
    expect(screen.queryByText("Claude")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Expand" }));
    expect(screen.getByText("Claude")).toBeInTheDocument();
  });

  it("kills only a killable registered child after confirmation", async () => {
    const user = userEvent.setup();
    render(<ProcessesDiagnostics />);
    await screen.findByText("Claude");
    await user.click(screen.getByRole("button", { name: "Kill" }));
    await waitFor(() => expect(mocks.diagnosticsKillProcess).toHaveBeenCalledWith(200));
    expect(window.confirm).toHaveBeenCalled();
  });
});
