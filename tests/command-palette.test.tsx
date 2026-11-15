import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { CommandPalette } from "../src/components/ui/CommandPalette";
import { useSettingsStore } from "../src/stores/settings";
import { useThreadsStore } from "../src/stores/threads";

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: vi.fn() }),
}));

describe("CommandPalette", () => {
  beforeEach(() => {
    useThreadsStore.setState({ threads: [], activeThreadId: null });
    useSettingsStore.setState({ keybindings: {} });
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
});
