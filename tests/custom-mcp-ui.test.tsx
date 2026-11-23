import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpServerModal } from "../src/components/settings/McpServerModal";
import { McpImportExportModal } from "../src/components/settings/McpImportExportModal";
import type { McpServer } from "../src/lib/types";

const mocks = vi.hoisted(() => ({
  mcpUpdateServer: vi.fn(),
  mcpCreateServer: vi.fn(),
  mcpTestConnection: vi.fn(),
  mcpImportJson: vi.fn(),
  mcpExportJson: vi.fn(),
}));

interface CapturedTransport {
  kind: string;
  command?: string;
  env?: Record<string, string>;
  secretEnv?: { key: string; value?: string }[];
}

interface CapturedInput {
  name: string;
  transport: CapturedTransport;
}

vi.mock("../src/lib/ipc", () => mocks);

const server: McpServer = {
  id: "mcp-1",
  name: "Files",
  enabled: true,
  transport: {
    kind: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem"],
    env: { LOG_LEVEL: "debug" },
    secretEnvKeys: [{ key: "API_TOKEN", hasValue: true, masked: "••••3456" }],
  },
  scope: "global",
  projectId: null,
  threadId: null,
  providerIds: [],
  allowTools: [],
  denyTools: [],
  timeoutMs: 30_000,
  allowLocalhost: true,
  status: "connected",
  lastLatencyMs: 12,
  toolsCount: 1,
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mcpUpdateServer.mockResolvedValue(server);
  mocks.mcpCreateServer.mockResolvedValue(server);
  mocks.mcpTestConnection.mockResolvedValue({
    ok: true,
    protocolVersion: "2025-06-18",
    tools: [],
    latencyMs: 4,
  });
  mocks.mcpImportJson.mockResolvedValue([{ name: "filesystem", status: "imported" }]);
  mocks.mcpExportJson.mockResolvedValue('{"mcpServers":{"filesystem":{"command":"npx"}}}');
});

describe("custom MCP UI", () => {
  it("edits without exposing or overwriting an unchanged secret", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(
      <McpServerModal
        open
        server={server}
        projects={[]}
        threads={[]}
        instances={[]}
        onClose={() => {}}
        onSaved={onSaved}
      />,
    );
    expect(screen.getByDisplayValue("Files")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("••••3456")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("super-secret")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.mcpUpdateServer).toHaveBeenCalled());
    const [id, input] = mocks.mcpUpdateServer.mock.calls[0] as [string, CapturedInput];
    expect(id).toBe("mcp-1");
    expect(input.transport.secretEnv).toEqual([{ key: "API_TOKEN", value: undefined }]);
    expect(input.transport.env).toEqual({ LOG_LEVEL: "debug" });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("creates a stdio server from the Add modal", async () => {
    const user = userEvent.setup();
    render(
      <McpServerModal
        open
        server={null}
        projects={[]}
        threads={[]}
        instances={[]}
        onClose={() => {}}
        onSaved={() => {}}
      />,
    );
    await user.type(screen.getByPlaceholderText("filesystem"), "Filesystem");
    await user.type(screen.getByPlaceholderText("npx"), "npx");
    await user.click(screen.getByRole("button", { name: "Add server" }));
    await waitFor(() => expect(mocks.mcpCreateServer).toHaveBeenCalled());
    const [input] = mocks.mcpCreateServer.mock.calls[0] as [CapturedInput];
    expect(input.name).toBe("Filesystem");
    expect(input.transport).toMatchObject({ kind: "stdio", command: "npx" });
  });

  it("imports and exports the mcpServers document", async () => {
    const user = userEvent.setup();
    const onImported = vi.fn();
    render(<McpImportExportModal open serverIds={[]} onClose={() => {}} onImported={onImported} />);
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: '{"mcpServers":{}}' } });
    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(mocks.mcpImportJson).toHaveBeenCalledWith('{"mcpServers":{}}'));
    expect(await screen.findByText("imported")).toBeInTheDocument();
    expect(onImported).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(mocks.mcpExportJson).toHaveBeenCalled());
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toContain("mcpServers"));
  });
});
