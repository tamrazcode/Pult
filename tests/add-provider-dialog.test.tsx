import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type * as IpcModule from "../src/lib/ipc";

const { providersInstancesList, providersInstancesSave, providersPreflight, providersInstall } =
  vi.hoisted(() => ({
    providersInstancesList: vi.fn(async () => []),
    providersInstancesSave: vi.fn(async () => undefined),
    providersPreflight: vi.fn(),
    providersInstall: vi.fn(async () => "installed"),
  }));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    providersInstancesList,
    providersInstancesSave,
    providersPreflight,
    providersInstall,
  };
});

import { AddProviderDialog } from "../src/components/settings/AddProviderDialog";
import { useUiStore } from "../src/stores/ui";
import type { DetectedAgent } from "../src/lib/types";

function detected(id: string, displayName: string, command = id): DetectedAgent {
  return {
    id,
    displayName,
    command,
    suggestedInstanceId: id,
    suggestedCommand: null,
    notes: "",
  };
}

describe("AddProviderDialog", () => {
  const onClose = vi.fn();
  const onAdded = vi.fn();

  beforeEach(() => {
    onClose.mockReset();
    onAdded.mockReset();
    providersInstancesList.mockReset().mockResolvedValue([]);
    providersInstancesSave.mockReset().mockResolvedValue(undefined);
    providersInstall.mockReset().mockResolvedValue("installed");
    providersPreflight.mockReset().mockResolvedValue({
      instanceId: "grok",
      agentName: "Grok",
      agentVersion: "1.0.0",
      loadSession: true,
      promptImage: false,
      authRequired: false,
      authHint: null,
      configOptions: [],
      authMethods: [],
    });
    vi.spyOn(useUiStore.getState(), "loadInstances").mockResolvedValue(undefined);
  });

  it("walks provider → identity → config and saves the ACP command", async () => {
    render(
      <AddProviderDialog
        detected={[detected("grok", "Grok")]}
        instances={[]}
        onClose={onClose}
        onAdded={onAdded}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Grok/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByDisplayValue("Grok")).toBeInTheDocument();
    expect(screen.getByDisplayValue("grok")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByDisplayValue("grok")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add instance" }));

    await waitFor(() =>
      expect(providersInstancesSave).toHaveBeenCalledWith([
        expect.objectContaining({
          id: "grok",
          displayName: "Grok",
          command: "grok",
          args: ["agent", "stdio"],
        }),
      ]),
    );
    expect(onAdded).toHaveBeenCalledWith("grok");
    expect(onClose).toHaveBeenCalled();
  });

  it("prefills the default Codex selection before any card click", () => {
    render(<AddProviderDialog detected={[]} instances={[]} onClose={onClose} onAdded={onAdded} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByDisplayValue("Codex")).toBeInTheDocument();
    expect(screen.getByDisplayValue("codex")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByDisplayValue("npx")).toBeInTheDocument();
    const textareas = screen.getAllByRole("textbox") as HTMLTextAreaElement[];
    expect(textareas[1]?.value).toBe("-y\n@agentclientprotocol/codex-acp");
  });

  it("saves an API key into the instance environment", async () => {
    render(<AddProviderDialog detected={[]} instances={[]} onClose={onClose} onAdded={onAdded} />);
    fireEvent.click(screen.getByRole("button", { name: /Claude/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.change(screen.getByPlaceholderText("ANTHROPIC_API_KEY"), {
      target: { value: "sk-ant-test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install & connect" }));

    await waitFor(() =>
      expect(providersInstancesSave).toHaveBeenCalledWith([
        expect.objectContaining({
          id: "claude-code",
          env: { ANTHROPIC_API_KEY: "sk-ant-test" },
        }),
      ]),
    );
  });

  it("does not save when the CLI installer fails", async () => {
    providersInstall.mockRejectedValueOnce(new Error("npm failed"));
    render(<AddProviderDialog detected={[]} instances={[]} onClose={onClose} onAdded={onAdded} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Install & connect" }));

    expect(await screen.findByText(/Install failed/)).toBeInTheDocument();
    expect(providersInstancesSave).not.toHaveBeenCalled();
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("rolls back an instance whose connection probe fails", async () => {
    providersPreflight.mockRejectedValueOnce(new Error("binary not found"));
    render(<AddProviderDialog detected={[]} instances={[]} onClose={onClose} onAdded={onAdded} />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Install & connect" }));

    expect(await screen.findByText(/Connection failed/)).toBeInTheDocument();
    expect(providersInstancesSave).toHaveBeenCalledTimes(2);
    expect((providersInstancesSave.mock.calls[1] as unknown[] | undefined)?.[0]).toEqual([]);
    expect(onAdded).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("rejects an invalid or taken instance id before config", () => {
    render(
      <AddProviderDialog
        detected={[]}
        instances={[
          {
            id: "grok",
            displayName: "Grok",
            enabled: true,
            driver: "acp",
            command: "grok",
            args: [],
            env: {},
            status: "stopped",
            promptImage: false,
            loadSession: true,
            modes: [],
            configOptions: [],
            authMethods: [],
          },
        ]}
        onClose={onClose}
        onAdded={onAdded}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const id = screen.getByDisplayValue("codex");
    fireEvent.change(id, { target: { value: "1 bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/Use letters, digits/)).toBeInTheDocument();
  });

  it("lets Pi advance through the wizard and saves driver='pi_rpc'", async () => {
    render(
      <AddProviderDialog
        detected={[detected("pi", "Pi")]}
        instances={[]}
        onClose={onClose}
        onAdded={onAdded}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Pi/ }));
    expect(screen.queryByText(/needs a dedicated Pult adapter/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByDisplayValue("Pi")).toBeInTheDocument();
    expect(screen.getByDisplayValue("pi")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByDisplayValue("pi")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add instance" }));

    await waitFor(() =>
      expect(providersInstancesSave).toHaveBeenCalledWith([
        expect.objectContaining({
          id: "pi",
          displayName: "Pi",
          driver: "pi_rpc",
          command: "pi",
          args: [],
        }),
      ]),
    );
    expect(onAdded).toHaveBeenCalledWith("pi");
    expect(onClose).toHaveBeenCalled();
  });

  it("disables Add instance for a missing manual CLI until a custom command is entered", () => {
    render(<AddProviderDialog detected={[]} instances={[]} onClose={onClose} onAdded={onAdded} />);
    fireEvent.click(screen.getByRole("button", { name: /Grok/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByText(/has no automatic installer/)).toBeInTheDocument();
    const add = screen.getByRole("button", { name: "Add instance" });
    expect(add).toBeDisabled();

    fireEvent.change(screen.getByDisplayValue("grok"), {
      target: { value: "C:\\tools\\grok.exe" },
    });
    expect(screen.getByRole("button", { name: "Add instance" })).toBeEnabled();

    fireEvent.change(screen.getByDisplayValue("C:\\tools\\grok.exe"), {
      target: { value: "grok" },
    });
    expect(screen.getByRole("button", { name: "Add instance" })).toBeDisabled();
  });

  it("recognizes detected Gemini and Cursor instead of offering an installer", () => {
    render(
      <AddProviderDialog
        detected={[
          detected("gemini-cli", "Gemini CLI", "gemini"),
          detected("cursor", "Cursor", "cursor-agent"),
        ]}
        instances={[]}
        onClose={onClose}
        onAdded={onAdded}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Gemini/ }));
    expect(screen.getAllByText("Installed")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/Detected on PATH/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByRole("button", { name: "Add instance" })).toBeEnabled();
  });

  it("installs OpenCode into Pult's npm folder when it is missing", async () => {
    render(<AddProviderDialog detected={[]} instances={[]} onClose={onClose} onAdded={onAdded} />);
    fireEvent.click(screen.getByRole("button", { name: /OpenCode/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByText(/opencode-ai/)).toBeInTheDocument();
    expect(screen.getByText(/no admin rights/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Install & connect" }));

    await waitFor(() => expect(providersInstall).toHaveBeenCalledWith("opencode"));
    await waitFor(() =>
      expect(providersInstancesSave).toHaveBeenCalledWith([
        expect.objectContaining({ id: "opencode", command: "opencode", args: ["acp"] }),
      ]),
    );
    expect(onAdded).toHaveBeenCalledWith("opencode");
  });

  it("offers the Gemini CLI installer", () => {
    render(<AddProviderDialog detected={[]} instances={[]} onClose={onClose} onAdded={onAdded} />);
    fireEvent.click(screen.getByRole("button", { name: /Gemini/ }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByDisplayValue("gemini")).toBeInTheDocument();
    expect(screen.getByText(/@google\/gemini-cli/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Install & connect" })).toBeInTheDocument();
  });
});
