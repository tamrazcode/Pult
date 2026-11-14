import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ContextMenu, type ContextMenuItem } from "../src/components/ui/ContextMenu";

describe("ContextMenu", () => {
  const originalInnerWidth = window.innerWidth;
  const originalInnerHeight = window.innerHeight;

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", { value: 800, configurable: true, writable: true });
    Object.defineProperty(window, "innerHeight", {
      value: 600,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(window, "innerWidth", {
      value: originalInnerWidth,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "innerHeight", {
      value: originalInnerHeight,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  it("renders items, shortcuts, separators, disabled state, and data-escape-layer", () => {
    const onSelect = vi.fn();
    const onDisabled = vi.fn();
    const onClose = vi.fn();
    const items: Array<ContextMenuItem | "separator"> = [
      { id: "copy", label: "Copy path", shortcut: "⌘C", onSelect },
      "separator",
      { id: "settings", label: "Project settings", disabled: true, onSelect: onDisabled },
    ];

    render(<ContextMenu x={100} y={120} items={items} onClose={onClose} />);

    const menu = screen.getByRole("menu");
    expect(menu).toBeVisible();
    expect(
      menu.hasAttribute("data-escape-layer") ||
        menu.closest("[data-escape-layer]") !== null ||
        menu.querySelector("[data-escape-layer]") !== null,
    ).toBe(true);

    expect(screen.getByRole("menuitem", { name: /Copy path/ })).toBeVisible();
    expect(screen.getByText("⌘C")).toBeVisible();
    expect(screen.getByRole("separator")).toBeInTheDocument();

    const disabledItem = screen.getByRole("menuitem", { name: "Project settings" });
    expect(disabledItem).toBeDisabled();
    fireEvent.click(disabledItem);
    expect(onDisabled).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("menuitem", { name: /Copy path/ }));
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("clamps x and y inside viewport bounds", () => {
    Object.defineProperty(window, "innerWidth", { value: 400, configurable: true, writable: true });
    Object.defineProperty(window, "innerHeight", {
      value: 300,
      configurable: true,
      writable: true,
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 160,
      height: 120,
      top: 0,
      left: 0,
      right: 160,
      bottom: 120,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const items: Array<ContextMenuItem | "separator"> = [
      { id: "one", label: "One", onSelect: vi.fn() },
    ];

    const { rerender } = render(<ContextMenu x={500} y={400} items={items} onClose={vi.fn()} />);
    const menu = screen.getByRole("menu");
    const clampedRightLeft = parseFloat(menu.style.left);
    const clampedBottomTop = parseFloat(menu.style.top);
    expect(clampedRightLeft).toBeGreaterThanOrEqual(0);
    expect(clampedRightLeft).toBeLessThan(400);
    expect(clampedBottomTop).toBeGreaterThanOrEqual(0);
    expect(clampedBottomTop).toBeLessThan(300);

    rerender(<ContextMenu x={-30} y={-20} items={items} onClose={vi.fn()} />);
    expect(parseFloat(menu.style.left)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(menu.style.top)).toBeGreaterThanOrEqual(0);
  });

  it("closes on outside click and container scroll", () => {
    const onClose = vi.fn();
    const items: Array<ContextMenuItem | "separator"> = [
      { id: "one", label: "One", onSelect: vi.fn() },
    ];

    const { rerender } = render(
      <div data-testid="scroll-container">
        <button type="button">Outside</button>
        <ContextMenu x={40} y={40} items={items} onClose={onClose} />
      </div>,
    );

    fireEvent.mouseDown(screen.getByRole("button", { name: "Outside" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    rerender(
      <div data-testid="scroll-container">
        <button type="button">Outside</button>
        <ContextMenu x={40} y={40} items={items} onClose={onClose} />
      </div>,
    );

    fireEvent.scroll(screen.getByTestId("scroll-container"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <ContextMenu
        x={40}
        y={40}
        items={[{ id: "one", label: "One", onSelect: vi.fn() }]}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("moves focus with ArrowDown/ArrowUp (skipping separators and disabled items) and selects with Enter", () => {
    const onFirst = vi.fn();
    const onSecond = vi.fn();
    const onClose = vi.fn();
    const items: Array<ContextMenuItem | "separator"> = [
      { id: "first", label: "First", onSelect: onFirst },
      "separator",
      { id: "disabled", label: "Disabled", disabled: true, onSelect: vi.fn() },
      { id: "second", label: "Second", onSelect: onSecond },
    ];

    render(<ContextMenu x={40} y={40} items={items} onClose={onClose} />);

    const first = screen.getByRole("menuitem", { name: "First" });
    const second = screen.getByRole("menuitem", { name: "Second" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);

    fireEvent.keyDown(second, { key: "ArrowUp" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);

    fireEvent.keyDown(second, { key: "Enter" });
    expect(onSecond).toHaveBeenCalledOnce();
    expect(onFirst).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows confirmation text on first click/Enter for confirmLabel items and calls onSelect only on second", () => {
    const onDelete = vi.fn();
    const onClose = vi.fn();
    const items: Array<ContextMenuItem | "separator"> = [
      {
        id: "delete",
        label: "Delete",
        danger: true,
        confirmLabel: "Confirm delete",
        onSelect: onDelete,
      },
    ];

    const { unmount } = render(<ContextMenu x={40} y={40} items={items} onClose={onClose} />);

    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    const confirmItem = screen.getByRole("menuitem", { name: /Confirm delete/i });
    expect(confirmItem).toBeVisible();

    fireEvent.click(confirmItem);
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();

    unmount();
    onDelete.mockClear();
    onClose.mockClear();

    render(<ContextMenu x={40} y={40} items={items} onClose={onClose} />);
    const deleteItem = screen.getByRole("menuitem", { name: "Delete" });
    fireEvent.keyDown(deleteItem, { key: "Enter" });
    expect(onDelete).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    const confirmed = screen.getByRole("menuitem", { name: /Confirm delete/i });
    fireEvent.keyDown(confirmed, { key: "Enter" });
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
