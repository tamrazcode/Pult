import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CommandPalette, useGlobalHotkeys } from "../src/components/ui/CommandPalette";
import { DEFAULT_BINDINGS, formatBinding } from "../src/lib/hotkeys";
import { useSettingsStore } from "../src/stores/settings";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  useRouter: () => ({ navigate: vi.fn() }),
}));

import { Route as KeybindingsRoute } from "../src/routes/settings.keybindings";

const KeybindingsSettings = KeybindingsRoute.options.component!;

function HotkeyHarness() {
  useGlobalHotkeys(vi.fn());
  return null;
}

describe("CommandPalette", () => {
  beforeEach(() => {
    useThreadsStore.setState({ threads: [], activeThreadId: null });
    useSettingsStore.setState({ keybindings: {} });
    useUiStore.setState({ rightPanelOpen: false, rightPanelTab: "none" });
  });

  it("groups each section once, dims the page, and traps Tab", () => {
    const onClose = vi.fn();
    const { container } = render(<CommandPalette open onClose={onClose} />);

    expect(screen.getAllByText("Actions")).toHaveLength(1);
    expect(container.querySelector(".bg-black\\/60")).not.toBeNull();

    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>("input, button:not([disabled])"),
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  it("opens browser on Mod+Alt+B and files on Mod+Alt+F, and lists both in DEFAULT_BINDINGS and BINDING_LABELS", () => {
    expect(DEFAULT_BINDINGS["view.panel.browser"]).toBe("Mod+Alt+B");
    expect(DEFAULT_BINDINGS["view.panel.files"]).toBe("Mod+Alt+F");

    render(
      <>
        <HotkeyHarness />
        <KeybindingsSettings />
      </>,
    );

    expect(screen.getByRole("button", { name: "Rebind Show browser panel" })).toHaveTextContent(
      formatBinding("Mod+Alt+B"),
    );
    expect(screen.getByRole("button", { name: "Rebind Show files panel" })).toHaveTextContent(
      formatBinding("Mod+Alt+F"),
    );

    fireEvent.keyDown(window, { key: "b", ctrlKey: true, altKey: true });
    expect(useUiStore.getState().rightPanelOpen).toBe(true);
    expect(useUiStore.getState().rightPanelTab).toBe("browser");

    fireEvent.keyDown(window, { key: "f", ctrlKey: true, altKey: true });
    expect(useUiStore.getState().rightPanelOpen).toBe(true);
    expect(useUiStore.getState().rightPanelTab).toBe("files");
  });
});
