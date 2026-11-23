import { beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { CommandPalette, useGlobalHotkeys } from "../src/components/ui/CommandPalette";
import { DEFAULT_BINDINGS, formatBindingParts } from "../src/lib/hotkeys";
import { useSettingsStore } from "../src/stores/settings";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/chat" } }),
  createFileRoute: () => (options: unknown) => ({ options }),
  useRouter: () => ({ navigate: vi.fn() }),
}));

import { Route as KeybindingsRoute } from "../src/routes/settings.keybindings";

const KeybindingsSettings = KeybindingsRoute.options.component!;

function HotkeyHarness() {
  useGlobalHotkeys(vi.fn());
  return null;
}

/** Opens the palette from a real trigger button so focus restoration is observable. */
function PaletteHarness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open commands
      </button>
      <CommandPalette
        open={open}
        onClose={() => {
          setOpen(false);
          onClose();
        }}
      />
    </>
  );
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
      formatBindingParts("Mod+Alt+B").join("+"),
    );
    expect(screen.getByRole("button", { name: "Rebind Show files panel" })).toHaveTextContent(
      formatBindingParts("Mod+Alt+F").join("+"),
    );

    fireEvent.keyDown(window, { key: "b", ctrlKey: true, altKey: true });
    expect(useUiStore.getState().rightPanelOpen).toBe(true);
    expect(useUiStore.getState().rightPanelTab).toBe("browser");

    fireEvent.keyDown(window, { key: "f", ctrlKey: true, altKey: true });
    expect(useUiStore.getState().rightPanelOpen).toBe(true);
    expect(useUiStore.getState().rightPanelTab).toBe("files");
  });

  it("Escape restores focus to the still-connected trigger without scrolling", () => {
    const onClose = vi.fn();
    render(<PaletteHarness onClose={onClose} />);

    const trigger = screen.getByRole("button", { name: "Open commands" });
    trigger.focus();
    const focusSpy = vi.spyOn(trigger, "focus");

    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(trigger);
  });

  it("does not pull focus back to the trigger after a command runs", () => {
    useUiStore.setState({ sidebarOpen: true });
    const onClose = vi.fn();
    render(<PaletteHarness onClose={onClose} />);

    const trigger = screen.getByRole("button", { name: "Open commands" });
    trigger.focus();
    const focusSpy = vi.spyOn(trigger, "focus");

    fireEvent.click(trigger);
    const input = screen.getByRole("textbox", { name: "Search commands" });
    input.focus();
    fireEvent.change(input, { target: { value: "toggle sidebar" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useUiStore.getState().sidebarOpen).toBe(false);
    expect(focusSpy).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(trigger);
  });
});
