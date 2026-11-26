import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { FileDropZone } from "../src/components/chat/FileDropZone";
import { ATTACHMENT_DROP_EVENT } from "../src/lib/attachmentDrop";

describe("FileDropZone", () => {
  it("shows the ghost for file drags and hands the files over on drop", () => {
    const received: File[] = [];
    const onDrop = (event: Event) => received.push(...(event as CustomEvent<File[]>).detail);
    window.addEventListener(ATTACHMENT_DROP_EVENT, onDrop);
    const { container } = render(
      <FileDropZone className="relative h-40">
        <div>content</div>
      </FileDropZone>,
    );
    const zone = container.querySelector("[data-file-drop-zone]");
    expect(zone).not.toBeNull();
    const file = new File(["x"], "note.md", { type: "text/markdown" });

    // A text drag is not a file drop.
    fireEvent.dragEnter(zone!, { dataTransfer: { types: ["text/plain"] } });
    expect(screen.queryByText("Drop files to attach")).toBeNull();

    fireEvent.dragEnter(zone!, { dataTransfer: { types: ["Files"] } });
    expect(screen.getByText("Drop files to attach")).toBeVisible();

    fireEvent.drop(zone!, { dataTransfer: { types: ["Files"], files: [file] } });
    expect(received).toHaveLength(1);
    expect(received[0]?.name).toBe("note.md");
    expect(screen.queryByText("Drop files to attach")).toBeNull();

    window.removeEventListener(ATTACHMENT_DROP_EVENT, onDrop);
  });

  it("hides the ghost when the drag leaves the zone", () => {
    const { container } = render(
      <FileDropZone>
        <div>content</div>
      </FileDropZone>,
    );
    const zone = container.querySelector("[data-file-drop-zone]");

    fireEvent.dragEnter(zone!, { dataTransfer: { types: ["Files"] } });
    expect(screen.getByText("Drop files to attach")).toBeVisible();

    fireEvent.dragLeave(zone!, { dataTransfer: { types: ["Files"] } });
    expect(screen.queryByText("Drop files to attach")).toBeNull();
  });
});
