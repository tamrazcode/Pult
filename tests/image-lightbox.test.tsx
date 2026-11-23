import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImageLightbox } from "../src/components/ui/ImageLightbox";

describe("ImageLightbox", () => {
  it("moves focus to Close button on mount, traps Tab/Shift+Tab inside dialog, and restores focus on Escape close", async () => {
    const user = userEvent.setup();
    const onCloseSpy = vi.fn();

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            Open preview
          </button>
          <button type="button">Outside action</button>
          {open && (
            <ImageLightbox
              src="https://example.com/diagram.png"
              alt="Diagram"
              onClose={() => {
                onCloseSpy();
                setOpen(false);
              }}
            />
          )}
        </div>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open preview" });
    await user.click(trigger);

    const closeBtn = screen.getByRole("button", { name: "Close image preview" });
    expect(closeBtn).toHaveFocus();

    await user.tab();
    expect(closeBtn).toHaveFocus();

    await user.tab({ shift: true });
    expect(closeBtn).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onCloseSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Image preview" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("restores focus to previously focused element on unmount", () => {
    const onClose = vi.fn();
    const { getByRole } = render(<button type="button">Launcher</button>);
    const launcher = getByRole("button", { name: "Launcher" });
    launcher.focus();
    expect(launcher).toHaveFocus();

    const { unmount } = render(
      <ImageLightbox src="https://example.com/img.png" alt="Img" onClose={onClose} />,
    );
    expect(screen.getByRole("button", { name: "Close image preview" })).toHaveFocus();

    unmount();
    expect(launcher).toHaveFocus();
  });
});
