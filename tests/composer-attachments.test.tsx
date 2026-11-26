import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as IpcModule from "../src/lib/ipc";
import type { InstanceInfo } from "../src/lib/types";
import { emitAttachmentDrop } from "../src/lib/attachmentDrop";

const {
  navigate,
  runsDispatch,
  runsCancel,
  runsRespondPermission,
  runsQueueRemove,
  threadsCreate,
  workspaceFiles,
  providersInstancesList,
  settingsGet,
  settingsSet,
} = vi.hoisted(() => ({
  navigate: vi.fn(async () => undefined),
  runsDispatch: vi.fn(),
  runsCancel: vi.fn(),
  runsRespondPermission: vi.fn(),
  runsQueueRemove: vi.fn(),
  threadsCreate: vi.fn(),
  workspaceFiles: vi.fn(),
  providersInstancesList: vi.fn(),
  settingsGet: vi.fn(),
  settingsSet: vi.fn(),
}));

vi.mock("../src/lib/tauri", () => ({
  isTauri: () => true,
}));

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (s: { location: { pathname: string } }) => unknown }) =>
    select({ location: { pathname: "/chat" } }),
  useRouter: () => ({ navigate }),
}));

vi.mock("../src/lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof IpcModule>();
  return {
    ...actual,
    runsDispatch,
    runsCancel,
    runsRespondPermission,
    runsQueueRemove,
    threadsCreate,
    workspaceFiles,
    providersInstancesList,
    settingsGet,
    settingsSet,
    onThreadUpdate: vi.fn(async () => () => {}),
    onAgentProcess: vi.fn(async () => () => {}),
  };
});

import { Composer } from "../src/components/chat/Composer";
import { useDraftsStore } from "../src/stores/drafts";
import { useProjectsStore } from "../src/stores/projects";
import { useRunsStore } from "../src/stores/runs";
import { useSettingsStore } from "../src/stores/settings";
import { useThreadsStore } from "../src/stores/threads";
import { useUiStore } from "../src/stores/ui";

function makeInstance(overrides: Partial<InstanceInfo> = {}): InstanceInfo {
  return {
    id: "mock",
    displayName: "Mock Agent",
    enabled: true,
    driver: "mock",
    command: "node",
    args: [],
    env: {},
    status: "running",
    promptImage: true,
    loadSession: true,
    modes: [],
    configOptions: [],
    authMethods: [],
    ...overrides,
  };
}

function getAttachControls(container: HTMLElement) {
  const label = container.querySelector<HTMLLabelElement>('label[aria-label="Attach files"]');
  if (!label) {
    throw new Error('Expected interactive label[aria-label="Attach files"] inside composer');
  }
  const input = label.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) {
    throw new Error('Expected input[type="file"] inside label[aria-label="Attach files"]');
  }
  return { label, input };
}

function makePngFile(name = "shot.png"): File {
  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);
  return new File([pngBytes], name, { type: "image/png" });
}

describe("composer attachments", () => {
  beforeEach(() => {
    navigate.mockReset().mockResolvedValue(undefined);
    runsDispatch.mockReset().mockResolvedValue({ run: null, queued: false, queueId: null });
    runsCancel.mockReset().mockResolvedValue(undefined);
    runsRespondPermission.mockReset().mockResolvedValue(undefined);
    runsQueueRemove.mockReset().mockResolvedValue(undefined);
    threadsCreate.mockReset().mockResolvedValue({
      id: "new-th",
      projectId: null,
      title: "New thread",
      status: "draft",
      pinned: false,
      createdAt: 1,
      updatedAt: 1,
    });
    workspaceFiles.mockReset().mockResolvedValue([]);
    providersInstancesList
      .mockReset()
      .mockImplementation(async () => useUiStore.getState().instances);
    settingsGet.mockReset().mockResolvedValue(null);
    settingsSet.mockReset().mockResolvedValue(undefined);

    useRunsStore.setState({
      runsByThread: {},
      viewsByRun: {},
      appliedEvents: {},
      commandsByThread: {},
      queueByThread: {},
      desiredModeByThread: {},
      desiredConfigByThread: {},
      activeElicitation: null,
    });
    useUiStore.setState({
      selectedInstanceId: null,
      instanceByThread: {},
      paletteOpen: false,
      composerPrefill: null,
      instances: [],
    });
    useSettingsStore.setState({
      permissionMode: "supervised",
      sendKey: "enter",
    });
    useThreadsStore.setState({ threads: [], activeThreadId: null });
    useProjectsStore.setState({ projects: [], selectedProjectId: null });
    useDraftsStore.setState({ byThread: {}, attachments: {} });
  });

  it("renders an interactive Attach files label with unrestricted file input when no provider is selected", () => {
    const { container } = render(<Composer threadId="th" />);
    const { input } = getAttachControls(container);

    expect(input.disabled).toBe(false);
    expect(input.getAttribute("accept")).not.toBe("image/*");
  });

  it("renders an interactive Attach files label with unrestricted file input when promptImage is false", () => {
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [makeInstance({ promptImage: false })],
    });

    const { container } = render(<Composer threadId="th" />);
    const { input } = getAttachControls(container);

    expect(input.disabled).toBe(false);
    expect(input.getAttribute("accept")).not.toBe("image/*");
  });

  it("attaches a text file chip, includes its contents in runsDispatch, and clears the chip on send", async () => {
    const user = userEvent.setup();
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [makeInstance({ promptImage: true })],
    });

    const { container } = render(<Composer threadId="th" />);
    const { input } = getAttachControls(container);
    const noteFile = new File(["hello attachment"], "notes.md", { type: "text/markdown" });

    await user.upload(input, noteFile);

    await waitFor(() => {
      const chip = container.querySelector("[data-file-chip]");
      expect(chip).toBeTruthy();
      expect(chip).toHaveTextContent("notes.md");
    });

    await user.click(within(container).getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(runsDispatch).toHaveBeenCalledTimes(1));
    expect(runsDispatch.mock.calls[0]?.[1]).toContain("hello attachment");

    await waitFor(() => {
      expect(container.querySelector("[data-file-chip]")).toBeNull();
    });
  });

  it("inserts the attachment token at the caret and renders it inline with its size", async () => {
    const user = userEvent.setup();
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [makeInstance({ promptImage: true })],
    });

    const { container } = render(<Composer threadId="th" />);
    const { input } = getAttachControls(container);
    const textarea = container.querySelector("textarea")!;
    await user.type(textarea, "look ");
    const noteFile = new File(["x".repeat(2048)], "notes.md", { type: "text/markdown" });

    await user.upload(input, noteFile);

    await waitFor(() => {
      const chip = container.querySelector("[data-file-chip]");
      expect(chip).toHaveTextContent("notes.md");
      expect(chip).toHaveTextContent("2 KB");
      expect(container.querySelector("textarea")?.value).toBe("look notes.md 2 KB ");
      expect(container.querySelector("[data-inline-chip]")).toHaveTextContent("notes.md 2 KB");
    });
  });

  it("hands Backspace at the start of the text to the last attachment", async () => {
    const user = userEvent.setup();
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [makeInstance({ promptImage: true })],
    });

    const { container } = render(<Composer threadId="th" />);
    const { input } = getAttachControls(container);
    await user.upload(input, new File(["keep"], "keep.md", { type: "text/markdown" }));
    await waitFor(() =>
      expect(container.querySelector("[data-file-chip]")).toHaveTextContent("keep.md"),
    );

    const textarea = container.querySelector("textarea")!;
    textarea.focus();
    textarea.setSelectionRange(0, 0);
    fireEvent.keyDown(textarea, { key: "Backspace" });

    await waitFor(() => expect(container.querySelector("[data-file-chip]")).toBeNull());
    expect(textarea.value).not.toContain("keep.md");
  });

  it("keeps unsent attachments when navigating to another thread and back", async () => {
    const user = userEvent.setup();
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [makeInstance({ promptImage: true })],
    });

    const { container, rerender, unmount } = render(<Composer threadId="th-a" />);
    const { input } = getAttachControls(container);
    await user.upload(input, new File(["keep me"], "keep.md", { type: "text/markdown" }));

    await waitFor(() => {
      expect(container.querySelector("[data-file-chip]")).toHaveTextContent("keep.md");
    });

    rerender(<Composer threadId="th-b" />);
    await waitFor(() => expect(container.querySelector("[data-file-chip]")).toBeNull());

    rerender(<Composer threadId="th-a" />);
    await waitFor(() => {
      expect(container.querySelector("[data-file-chip]")).toHaveTextContent("keep.md");
    });

    unmount();
    const remounted = render(<Composer threadId="th-a" />);
    await waitFor(() => {
      expect(remounted.container.querySelector("[data-file-chip]")).toHaveTextContent("keep.md");
    });
  });

  it("attaches a PNG image chip when promptImage is true and sends it as an ImageInput", async () => {
    const user = userEvent.setup();
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [makeInstance({ promptImage: true })],
    });

    const { container } = render(<Composer threadId="th" />);
    const { input } = getAttachControls(container);

    await user.upload(input, makePngFile("diagram.png"));

    await waitFor(() => {
      const imageChip = container.querySelector("[data-image-chip], img[src^='data:image/png']");
      expect(imageChip).toBeTruthy();
    });

    await user.click(within(container).getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(runsDispatch).toHaveBeenCalledTimes(1));
    expect(runsDispatch.mock.calls[0]?.[1]).toContain("diagram.png");
    const images = runsDispatch.mock.calls[0]?.[3];
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ mimeType: "image/png" });
    expect(typeof images[0]?.data).toBe("string");
    expect(images[0].data.length).toBeGreaterThan(0);
  });

  it("shows an alert and skips the image chip for PNG when promptImage is false, while still allowing text files", async () => {
    const user = userEvent.setup();
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [makeInstance({ promptImage: false })],
    });

    const { container } = render(<Composer threadId="th" />);
    const { input } = getAttachControls(container);

    await user.upload(input, makePngFile("blocked.png"));

    await waitFor(() => {
      const alert = within(container).getByRole("alert");
      expect(alert).toBeVisible();
      expect(alert.textContent?.toLowerCase()).toContain("does not accept images");
    });
    expect(container.querySelector("[data-image-chip], img[src^='data:']")).toBeNull();

    const textFile = new File(["still works"], "readme.txt", { type: "text/plain" });
    await user.upload(input, textFile);

    await waitFor(() => {
      const fileChip = container.querySelector("[data-file-chip]");
      expect(fileChip).toBeTruthy();
      expect(fileChip).toHaveTextContent("readme.txt");
    });
  });

  it("caps attachments at 20 chips or shows an error when more than 20 files are selected", async () => {
    const user = userEvent.setup();
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [makeInstance({ promptImage: true })],
    });

    const { container } = render(<Composer threadId="th" />);
    const { input } = getAttachControls(container);
    const files = Array.from(
      { length: 21 },
      (_, idx) => new File([`content-${idx}`], `file-${idx + 1}.txt`, { type: "text/plain" }),
    );

    await user.upload(input, files);

    await waitFor(() => {
      const chips = container.querySelectorAll(
        "[data-file-chip], [data-image-chip], img[src^='data:']",
      );
      const alert = within(container).queryByRole("alert");
      expect(chips.length).toBeLessThanOrEqual(20);
      expect(chips.length === 20 || alert !== null).toBe(true);
    });
  });

  it("keeps the attachment token out of a new thread's title", async () => {
    const user = userEvent.setup();
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [makeInstance({ promptImage: false })],
    });

    const { container } = render(<Composer />);
    const textarea = container.querySelector("textarea")!;
    await user.type(textarea, "Fix the login bug");
    const { input } = getAttachControls(container);
    await user.upload(input, new File(["hello"], "notes.md", { type: "text/markdown" }));

    await waitFor(() => expect(textarea.value).toContain("notes.md"));

    await user.click(within(container).getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(threadsCreate).toHaveBeenCalledTimes(1));
    // The token is a chip, not prose: it must not leak into the thread title.
    expect(threadsCreate.mock.calls[0]?.[1]).toBe("Fix the login bug");
  });

  it("truncates oversized text files with a visible marker without crashing", async () => {
    const user = userEvent.setup();
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [makeInstance({ promptImage: false })],
    });

    const { container } = render(<Composer threadId="th" />);
    const { input } = getAttachControls(container);
    const hugeBody = "A".repeat(600_000);
    const hugeFile = new File([hugeBody], "huge.log", { type: "text/plain" });

    await user.upload(input, hugeFile);

    await waitFor(() => {
      const chip = container.querySelector("[data-file-chip]");
      expect(chip).toBeTruthy();
      expect(chip).toHaveTextContent("huge.log");
    });

    await user.click(within(container).getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(runsDispatch).toHaveBeenCalledTimes(1));
    const dispatchedText = String(runsDispatch.mock.calls[0]?.[1] ?? "");
    expect(dispatchedText.length).toBeLessThan(hugeBody.length);
    const hasVisibleMarker =
      /truncat/i.test(container.textContent ?? "") || /truncat/i.test(dispatchedText);
    expect(hasVisibleMarker).toBe(true);
  });

  it("wraps text files containing backtick fences in a longer fence and sanitizes backticks in the filename", async () => {
    const user = userEvent.setup();
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [makeInstance({ promptImage: false })],
    });

    const { container } = render(<Composer threadId="th" />);
    const { input } = getAttachControls(container);
    const body = "before\n```\nfake close\n```\nafter";
    const trickyFile = new File([body], "a```b.md", { type: "text/markdown" });

    await user.upload(input, trickyFile);

    await waitFor(() => {
      const chip = container.querySelector("[data-file-chip]");
      expect(chip).toBeTruthy();
    });

    await user.click(within(container).getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(runsDispatch).toHaveBeenCalledTimes(1));
    const dispatchedText = String(runsDispatch.mock.calls[0]?.[1] ?? "");
    expect(dispatchedText).toContain("Attached file: a   b.md");
    expect(dispatchedText).not.toContain("Attached file: a```b.md");
    expect(dispatchedText).toMatch(/`{4,}\n[\s\S]*before\n```\nfake close\n```\nafter\n`{4,}/);
  });

  it("opens the file picker from the paperclip label", () => {
    const { container } = render(<Composer threadId="th" />);
    const { label, input } = getAttachControls(container);
    const open = vi.spyOn(input, "click");

    fireEvent.click(label);

    expect(open).toHaveBeenCalledTimes(1);
  });

  it("attaches a file dropped anywhere in the chat column", async () => {
    useUiStore.setState({
      selectedInstanceId: "mock",
      instances: [makeInstance({ promptImage: false })],
    });
    const { container } = render(<Composer threadId="th" />);
    const dropped = new File(["dropped attachment"], "dropped.md", { type: "text/markdown" });

    act(() => emitAttachmentDrop([dropped]));

    await waitFor(() => {
      expect(container.querySelector("[data-file-chip]")).toHaveTextContent("dropped.md");
    });
    const textbox = within(container).getByRole("textbox") as HTMLTextAreaElement;
    expect(textbox.value).toContain("dropped.md");
  });
});
