import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

vi.mock("../src/components/terminal/TerminalPanel", () => ({
  TerminalPanel: ({ threadId }: { threadId: string | null }) => (
    <div data-testid="terminal-panel">{threadId ?? "none"}</div>
  ),
}));

import { BottomTerminalDrawer } from "../src/components/terminal/BottomTerminalDrawer";
import { STATIC_COMMANDS } from "../src/lib/commands";
import { useUiStore } from "../src/stores/ui";

describe("bottom terminal", () => {
  beforeEach(() => {
    useUiStore.setState({ bottomTerminalOpen: false });
  });

  it("toggles and explicitly sets the drawer state", () => {
    expect(useUiStore.getState().bottomTerminalOpen).toBe(false);

    useUiStore.getState().toggleBottomTerminal();
    expect(useUiStore.getState().bottomTerminalOpen).toBe(true);

    useUiStore.getState().toggleBottomTerminal();
    expect(useUiStore.getState().bottomTerminalOpen).toBe(false);

    useUiStore.getState().setBottomTerminalOpen(true);
    expect(useUiStore.getState().bottomTerminalOpen).toBe(true);
  });

  it("registers the view.bottomTerminal command on Mod+`", () => {
    const command = STATIC_COMMANDS.find((candidate) => candidate.id === "view.bottomTerminal");
    expect(command).toBeDefined();
    expect(command?.defaultBinding).toBe("Mod+`");
    expect(command?.titleKey).toBe("common.commands.toggleBottomTerminal");

    command!.run({ navigate: () => {} });
    expect(useUiStore.getState().bottomTerminalOpen).toBe(true);
  });

  it("renders nothing while closed", () => {
    const { container } = render(<BottomTerminalDrawer threadId="t1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the terminal body and closes from the header", () => {
    useUiStore.setState({ bottomTerminalOpen: true });
    render(<BottomTerminalDrawer threadId="t1" />);

    expect(screen.getByText("Bottom terminal")).toBeTruthy();
    expect(screen.getByTestId("terminal-panel")).toHaveTextContent("t1");

    fireEvent.click(screen.getByRole("button", { name: "Hide bottom terminal" }));
    expect(useUiStore.getState().bottomTerminalOpen).toBe(false);
  });
});
