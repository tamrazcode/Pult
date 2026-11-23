import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useRouter } from "@tanstack/react-router";
import {
  ArrowUp,
  Check,
  CornerUpRight,
  FileText,
  GripVertical,
  ListPlus,
  Paperclip,
  Pencil,
  X,
} from "lucide-react";
import { Button } from "../ui/button";
import { ModePill, ProviderModelPicker, configValueValid } from "./ComposerControls";
import { ContextRing } from "./ContextRing";
import {
  runsCancel,
  runsDispatch,
  runsQueueRemove,
  runsQueueReorder,
  runsQueueSteer,
  runsQueueUpdate,
  runsRespondPermission,
  workspaceFiles,
} from "../../lib/ipc";
import { isTauri } from "../../lib/tauri";
import {
  applyTextareaEdit,
  handleMarkdownBackspace,
  handleMarkdownNewline,
  handleMarkdownSpace,
} from "../../lib/composerMarkdown";
import { localizeIpcError, useT } from "../../lib/i18n";
import { useGitStore } from "../../stores/git";
import { useProjectsStore } from "../../stores/projects";
import { activeRunForThread, useRunsStore } from "../../stores/runs";
import { useThreadsStore } from "../../stores/threads";
import { useSettingsStore } from "../../stores/settings";
import { useDraftsStore } from "../../stores/drafts";
import type { FileChip, ImageChip } from "../../stores/drafts";
import { useUiStore } from "../../stores/ui";
import type {
  CommandInfo,
  ConfigOptionValue,
  ImageInput,
  SessionConfigOption,
} from "../../lib/types";

const MAX_HEIGHT = 10 * 28; // 10 rows at the 28px effective line step
const QUEUE_ROW_HEIGHT = 32;

/** What a picked slash command inserts: the leading "/" is part of the command. */
export function formatSlashInsertion(command: CommandInfo): string {
  return `/${command.name} `;
}

/**
 * Which mode travels with a send: a thread's own pick. The `/chat` slot is
 * only for a thread that is being created right now — never borrowed by an
 * existing thread.
 */
export function modeForSend(desired: Record<string, string>, threadId?: string): string | null {
  return (threadId ? desired[threadId] : desired[""]) || null;
}

/** Which config picks travel with a send; the `/chat` slot never leaks. */
export function configForSend(
  desired: Record<string, Record<string, ConfigOptionValue>>,
  threadId?: string,
  instanceOptions?: SessionConfigOption[],
): Record<string, ConfigOptionValue> | null {
  const config = threadId ? desired[threadId] : desired[""];
  if (!config) return null;
  if (!instanceOptions) return config;
  const valid: Record<string, ConfigOptionValue> = {};
  for (const [id, value] of Object.entries(config)) {
    const option = instanceOptions.find((candidate) => candidate.id === id);
    if (option && configValueValid(option, value)) valid[id] = value;
  }
  return Object.keys(valid).length > 0 ? valid : null;
}

/** Esc cancels the run only when nothing above (overlay, decision) owns the key. */
export function shouldCancelOnEscape(ctx: { runActive: boolean; overlayOpen: boolean }): boolean {
  return ctx.runActive && !ctx.overlayOpen;
}

/**
 * The `@token` being typed at the caret, for file mentions. A token must start
 * after whitespace/bracket, so `foo@bar.com` never opens the menu.
 */
export function extractMentionQuery(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|[\s([{])@([^\s@]*)$/.exec(before);
  if (!match) return null;
  return { start: caret - match[2].length - 1, query: match[2] };
}

const MAX_ATTACHMENTS = 4;
const EMPTY_IMAGES: ImageChip[] = [];
const EMPTY_FILES: FileChip[] = [];
const MAX_ATTACHMENT_TEXT = 200_000;
const MAX_ATTACHMENT_BYTES = 5_000_000;

function chipFromDataUrl(name: string, size: number, dataUrl: string): ImageChip | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return {
    mimeType: match[1],
    data: match[2],
    preview: dataUrl,
    name,
    size,
    token: attachmentToken(name, size),
  };
}

function fileToChip(file: File): Promise<ImageChip | null> {
  // Keep the prompt payload under the IPC cap; larger images stall the WebView.
  if (file.size > 1_500_000) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(
        typeof reader.result === "string"
          ? chipFromDataUrl(file.name || "image.png", file.size, reader.result)
          : null,
      );
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function readFileText(file: File): Promise<string> {
  if (typeof file.text === "function") return file.text();
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => resolve("");
    reader.readAsText(file);
  });
}

async function fileToTextChip(file: File): Promise<FileChip | null> {
  if (file.size > MAX_ATTACHMENT_BYTES) return null;
  const raw = await readFileText(file);
  if (raw.length === 0 || raw.includes("\0")) return null;
  return {
    name: file.name,
    text: raw.slice(0, MAX_ATTACHMENT_TEXT),
    truncated: raw.length > MAX_ATTACHMENT_TEXT,
    size: file.size,
    token: attachmentToken(file.name, file.size),
  };
}

function attachmentToken(name: string, size: number): string {
  return `${name} ${formatAttachmentSize(size)}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Renders the caret-line text; attachment tokens become inline links. */
function highlightInlineTokens(
  text: string,
  tokens: Map<string, { name: string; size: string }>,
) {
  if (tokens.size === 0) return text;
  const pattern = new RegExp(`(${[...tokens.keys()].map(escapeRegExp).join("|")})`, "g");
  return text.split(pattern).map((part, index) => {
    const token = tokens.get(part);
    if (!token) return part;
    return (
      <span key={`${part}-${index}`} data-inline-chip className="rounded-[4px] text-accent">
        {token.name}
        <span className="text-text-tertiary"> {token.size}</span>
      </span>
    );
  });
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Text files travel inside the prompt; the agent sees a name and a fence. */
function withFileAttachments(text: string, files: FileChip[]): string {
  if (files.length === 0) return text;
  const blocks = files
    .map((file) => {
      const name = file.name.replace(/[\r\n`]/g, " ").trim() || "attachment";
      const longestRun = Math.max(0, ...(file.text.match(/`+/g) ?? []).map((run) => run.length));
      const fence = "`".repeat(Math.max(3, longestRun + 1));
      return `Attached file: ${name}${file.truncated ? " (truncated)" : ""}\n${fence}\n${file.text}\n${fence}`;
    })
    .join("\n\n");
  return [text, blocks].filter(Boolean).join("\n\n");
}

export function Composer({ threadId }: { threadId?: string }) {
  const t = useT();
  const draftKey = threadId ?? "new";
  const value = useDraftsStore((s) => s.byThread[draftKey] ?? "");
  const setValue = useCallback(
    (text: string) => useDraftsStore.getState().setDraft(draftKey, text),
    [draftKey],
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Chips live in the drafts store, not in component state: switching to
  // another chat or Settings and back must not drop unsent attachments.
  const chips = useDraftsStore((s) => s.attachments[draftKey]?.images ?? EMPTY_IMAGES);
  const fileChips = useDraftsStore((s) => s.attachments[draftKey]?.files ?? EMPTY_FILES);
  const setChips = useCallback(
    (next: ImageChip[] | ((prev: ImageChip[]) => ImageChip[])) => {
      const store = useDraftsStore.getState();
      const prev = store.attachments[draftKey]?.images ?? EMPTY_IMAGES;
      store.setAttachments(draftKey, {
        images: typeof next === "function" ? next(prev) : next,
      });
    },
    [draftKey],
  );
  const setFileChips = useCallback(
    (next: FileChip[] | ((prev: FileChip[]) => FileChip[])) => {
      const store = useDraftsStore.getState();
      const prev = store.attachments[draftKey]?.files ?? EMPTY_FILES;
      store.setAttachments(draftKey, { files: typeof next === "function" ? next(prev) : next });
    },
    [draftKey],
  );
  const mirrorRef = useRef<HTMLDivElement>(null);
  const inlineTokens = useMemo(() => {
    const tokens = new Map<string, { name: string; size: string }>();
    for (const chip of [...chips, ...fileChips]) {
      const cut = chip.token.lastIndexOf(" ");
      tokens.set(chip.token, {
        name: chip.token.slice(0, cut),
        size: chip.token.slice(cut + 1),
      });
    }
    return tokens;
  }, [chips, fileChips]);
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const queueDraftRef = useRef("");
  const [dragState, setDragState] = useState<{
    id: string;
    startY: number;
    offset: number;
    index: number;
  } | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionFiles, setMentionFiles] = useState<string[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();

  const selectedInstanceId = useUiStore((s) => s.selectedInstanceId);
  const instances = useUiStore((s) => s.instances);
  const paletteOpen = useUiStore((s) => s.paletteOpen);
  const composerPrefill = useUiStore((s) => s.composerPrefill);
  const activeElicitation = useRunsStore((s) => s.activeElicitation);
  const commands = useRunsStore((s) => (threadId ? s.commandsByThread[threadId] : undefined));
  const queue = useRunsStore((s) => (threadId ? s.queueByThread[threadId] : undefined));
  const runs = useRunsStore((s) => (threadId ? s.runsByThread[threadId] : undefined));
  const activeRun = activeRunForThread(runs);
  const sendKey = useSettingsStore((s) => s.sendKey);
  const glassOpacity = useSettingsStore((s) => s.glassOpacity);

  // A Branch action hands the message text over once; consume it here.
  useEffect(() => {
    if (!composerPrefill) return;
    setValue(composerPrefill);
    useUiStore.getState().setComposerPrefill(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [composerPrefill, setValue]);

  // Reopening a thread restores the provider it last used; a stale send error
  // from another thread must not leak into this composer.
  useEffect(() => {
    setError(null);
    if (!threadId) return;
    const lastRun = runs?.[runs.length - 1];
    const remembered =
      useUiStore.getState().instanceByThread[threadId] ?? lastRun?.instanceId ?? undefined;
    if (
      remembered &&
      remembered !== useUiStore.getState().selectedInstanceId &&
      instances.some((instance) => instance.id === remembered)
    ) {
      useUiStore.getState().setSelectedInstanceId(remembered);
    }
  }, [threadId, instances, runs]);
  const pendingApproval = useRunsStore((s) =>
    activeRun ? s.viewsByRun[activeRun.id]?.pendingApproval : undefined,
  );
  const awaitingDecision = pendingApproval !== undefined;
  const elicitationForActiveRun = activeElicitation?.runId === activeRun?.id;
  const runIdForApproval = pendingApproval !== undefined ? (activeRun?.id ?? null) : null;
  const runActive =
    activeRun !== undefined && (activeRun.status === "running" || activeRun.status === "queued");

  const selectedInstance = instances.find((i) => i.id === selectedInstanceId);
  const threadWorkspace = useThreadsStore((s) =>
    threadId ? s.threads.find((thread) => thread.id === threadId)?.workspace : undefined,
  );
  // Image attach is capability-gated: only agents that declared
  // promptCapabilities.image show the chip affordance.
  const imageCapable = selectedInstance?.promptImage === true;

  // Slash menu: active while the draft is a "/command…" query. Agent commands
  // merge with pult's built-ins (/commit).
  const slashQuery = value.startsWith("/") && !value.includes("\n") ? value.slice(1) : null;
  const slashMatches = useMemo<CommandInfo[]>(() => {
    if (slashQuery === null) return [];
    const q = slashQuery.toLowerCase();
    const all: CommandInfo[] = [
      { name: "commit", description: t("composer.commitCommand") },
      ...(commands ?? []),
    ];
    return all.filter((c) => c.name.toLowerCase().startsWith(q));
  }, [slashQuery, commands, t]);
  const slashOpen = slashMatches.length > 0 && threadId !== undefined;

  useEffect(() => {
    if (slashIndex >= slashMatches.length) setSlashIndex(0);
  }, [slashMatches.length, slashIndex]);

  // File mentions: debounce the workspace walk while the `@token` changes.
  useEffect(() => {
    if (!mention || !threadId) {
      setMentionFiles([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      workspaceFiles({ threadId, query: mention.query })
        .then((files) => {
          if (cancelled) return;
          setMentionFiles(files);
          setMentionIndex(0);
        })
        .catch(() => {
          if (!cancelled) setMentionFiles([]);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [mention, threadId]);
  const mentionOpen = mention !== null && mentionFiles.length > 0;

  const autosize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const measured = el.scrollHeight;
    const fallback =
      value.length > 0 ? (useDraftsStore.getState().heightByThread[draftKey] ?? 52) : 52;
    const nextHeight = Math.min(Math.max(measured > 0 ? measured : fallback, 52), MAX_HEIGHT);
    el.style.height = `${nextHeight}px`;
    useDraftsStore.getState().setDraftHeight(draftKey, nextHeight);
  }, [draftKey, value.length]);

  // Restore the draft's height before the first paint; a large draft must not
  // come back as a one-line textarea until the next keystroke.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const stored = useDraftsStore.getState().heightByThread[draftKey];
    if (stored && value.length > 0) {
      el.style.height = `${Math.min(Math.max(stored, 52), MAX_HEIGHT)}px`;
    }
    autosize();
  }, [autosize, draftKey, value]);

  useEffect(() => {
    const onResize = () => autosize();
    window.addEventListener("resize", onResize);
    void document.fonts?.ready?.then(() => autosize()).catch(() => undefined);
    return () => window.removeEventListener("resize", onResize);
  }, [autosize]);

  const insertTokens = useCallback(
    (tokens: string[]) => {
      if (tokens.length === 0) return;
      const current = useDraftsStore.getState().byThread[draftKey] ?? "";
      const el = textareaRef.current;
      const start = el?.selectionStart ?? current.length;
      const end = el?.selectionEnd ?? current.length;
      const before = current.slice(0, start);
      const prefix = before.length > 0 && !/\s/.test(before[before.length - 1]!) ? " " : "";
      const insertion = `${prefix}${tokens.join(" ")} `;
      setValue(current.slice(0, start) + insertion + current.slice(end));
      requestAnimationFrame(() => {
        const caret = start + insertion.length;
        textareaRef.current?.setSelectionRange(caret, caret);
        textareaRef.current?.focus();
        autosize();
      });
    },
    [autosize, draftKey, setValue],
  );

  const removeAttachmentToken = useCallback(
    (token: string) => {
      const current = useDraftsStore.getState().byThread[draftKey] ?? "";
      setValue(current.replace(token, "").replace(/[ \t]{2,}/g, " ").trimEnd());
    },
    [draftKey, setValue],
  );

  const attachFiles = useCallback(
    async (picked: FileList | File[] | null) => {
      if (!picked) return;
      const list = Array.from(picked);
      if (list.length === 0) return;

      const room = MAX_ATTACHMENTS - chips.length - fileChips.length;
      if (room <= 0) {
        setError(t("composer.attachments.limit", { count: MAX_ATTACHMENTS }));
        return;
      }
      if (list.length > room) setError(t("composer.attachments.limit", { count: MAX_ATTACHMENTS }));
      const accepted = list.slice(0, room);
      const images = accepted.filter((file) => file.type.startsWith("image/"));
      const docs = accepted.filter((file) => !file.type.startsWith("image/"));

      if (images.length > 0 && !imageCapable) {
        setError(t("composer.noImagesAttach"));
      }
      const importedImages = imageCapable
        ? (await Promise.all(images.map(fileToChip))).filter(
            (chip): chip is ImageChip => chip !== null,
          )
        : [];
      const importedDocs = (await Promise.all(docs.map(fileToTextChip))).filter(
        (chip): chip is FileChip => chip !== null,
      );
      if (docs.length > 0 && importedDocs.length === 0) {
        setError(t("composer.onlyTextFiles"));
      }
      if (importedImages.length > 0) setChips((prev) => [...prev, ...importedImages]);
      if (importedDocs.length > 0) setFileChips((prev) => [...prev, ...importedDocs]);
      insertTokens([...importedImages, ...importedDocs].map((chip) => chip.token));
    },
    [chips.length, fileChips.length, imageCapable, insertTokens, setChips, setFileChips, t],
  );

  const dispatchRun = useCallback(
    async (
      targetThreadId: string,
      text: string,
      images: ImageInput[],
      mode: string | null,
      config: Record<string, ConfigOptionValue> | null,
    ) => {
      if (!selectedInstanceId) {
        throw new Error(t("composer.noAgent"));
      }
      useUiStore.getState().rememberInstance(targetThreadId, selectedInstanceId);
      // The picks for this send are persisted by the backend and applied to
      // the run's session.
      const outcome = await runsDispatch(
        targetThreadId,
        text,
        selectedInstanceId,
        images,
        mode,
        config,
      );
      if (outcome.run) useRunsStore.getState().registerRun(outcome.run);
      else if (outcome.queued) useRunsStore.getState().clearPendingUser(targetThreadId);
      if (mode) useRunsStore.getState().setDesiredMode(targetThreadId, mode);
      if (config) {
        for (const [id, value] of Object.entries(config)) {
          useRunsStore.getState().setDesiredConfig(targetThreadId, id, value);
        }
      }
      return outcome;
    },
    [selectedInstanceId, t],
  );

  const resetDraft = useCallback(() => {
    setValue("");
    useDraftsStore.getState().clearAttachments(draftKey);
    setMention(null);
    setMentionFiles([]);
    requestAnimationFrame(autosize);
  }, [autosize, draftKey, setValue]);

  const pickSlash = useCallback(
    (command: CommandInfo) => {
      setValue(formatSlashInsertion(command));
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [setValue],
  );

  const pickMention = useCallback(
    (path: string) => {
      const el = textareaRef.current;
      const caret = el?.selectionStart ?? value.length;
      if (!mention || caret < mention.start) return;
      const insert = `@${path} `;
      const next = `${value.slice(0, mention.start)}${insert}${value.slice(caret)}`;
      setValue(next);
      setMention(null);
      setMentionFiles([]);
      const pos = mention.start + insert.length;
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(pos, pos);
        autosize();
      });
    },
    [mention, value, autosize, setValue],
  );

  const handleSend = useCallback(() => {
    const text = value.trim();
    if ((!text && chips.length === 0 && fileChips.length === 0) || busy || awaitingDecision) return;
    if (chips.length > 0 && !imageCapable) {
      setError(t("composer.noImages"));
      return;
    }
    if (!isTauri()) {
      // Plain-browser dev: no backend; keep the M0 input-clearing behavior.
      resetDraft();
      return;
    }
    // Pult-local /commit: stages everything and commits from the composer.
    if (text.startsWith("/commit")) {
      const message = text.slice("/commit".length).trim();
      if (!threadId) {
        setError(t("composer.commitInThread"));
        return;
      }
      if (!message) {
        setError(t("composer.commitUsage"));
        return;
      }
      setBusy(true);
      setError(null);
      void (async () => {
        const git = useGitStore.getState();
        git.setCommitMessage(threadId, message);
        const ok = await git.commit(threadId);
        if (!ok) setError(t("composer.commitFailed"));
        setBusy(false);
      })();
      resetDraft();
      return;
    }
    setBusy(true);
    setError(null);
    const images: ImageInput[] = chips.map(({ data, mimeType }) => ({ data, mimeType }));
    const attachedNames = [...chips, ...fileChips].map((attachment) => attachment.name).join(", ");
    const attachedFallback = attachedNames
      ? t("composer.attached", { files: attachedNames })
      : "";
    // Image-only sends still need a non-empty title and queue label.
    const promptText = withFileAttachments(text, fileChips) || attachedFallback;
    const pendingText = text || attachedFallback;
    void (async () => {
      try {
        if (!threadId) {
          // First send from the empty /chat route: create the thread with the
          // new-thread options (workspace / worktree), then navigate into it.
          const desired = useRunsStore.getState().desiredModeByThread;
          const pendingMode = modeForSend(desired);
          const pendingConfig = configForSend(
            useRunsStore.getState().desiredConfigByThread,
            undefined,
            selectedInstance?.configOptions,
          );
          const selectedProjectId = useProjectsStore.getState().selectedProjectId;
          const project = useProjectsStore
            .getState()
            .projects.find((candidate) => candidate.id === selectedProjectId);
          // New threads inherit their project's folder and worktree strategy;
          // the old folder/worktree strip is gone.
          const targetWorkspace = project?.rootPath || undefined;
          const targetWorktree = project?.worktreeStrategy === "worktree";
          const thread = await useThreadsStore
            .getState()
            .createThread(project?.id ?? null, pendingText.slice(0, 40), {
              workspace: targetWorkspace,
              worktree: targetWorktree,
            });
          // The picks made on /chat now belong to this thread: remember the
          // provider and persist mode/config for its next turn too.
          if (selectedInstanceId) {
            useUiStore.getState().rememberInstance(thread.id, selectedInstanceId);
          }
          if (pendingMode) useRunsStore.getState().setDesiredMode(thread.id, pendingMode);
          if (pendingConfig) {
            for (const [configId, configValue] of Object.entries(pendingConfig)) {
              useRunsStore.getState().setDesiredConfig(thread.id, configId, configValue);
            }
          }
          // Show the bubble immediately, then navigate and dispatch; a failure
          // clears it and surfaces in the global banner (the composer unmounts).
          useRunsStore.getState().setPendingUser(thread.id, pendingText, images);
          await router.navigate({ to: "/thread/$threadId", params: { threadId: thread.id } });
          try {
            await dispatchRun(thread.id, promptText, images, pendingMode, pendingConfig);
          } catch (err) {
            useRunsStore.getState().clearPendingUser(thread.id);
            useUiStore
              .getState()
              .setGlobalError({ kind: "protocol", message: localizeIpcError(err) });
          } finally {
            if (pendingMode) useRunsStore.getState().setDesiredMode("", "");
            if (pendingConfig) useRunsStore.getState().clearDesiredConfig("");
          }
        } else {
          // Queue-aware: the backend queues while a run is active and
          // auto-dispatches when it finishes.
          const desired = useRunsStore.getState().desiredModeByThread;
          const config = configForSend(
            useRunsStore.getState().desiredConfigByThread,
            threadId,
            selectedInstance?.configOptions,
          );
          useRunsStore.getState().setPendingUser(threadId, pendingText, images);
          try {
            await dispatchRun(threadId, promptText, images, modeForSend(desired, threadId), config);
          } catch (err) {
            useRunsStore.getState().clearPendingUser(threadId);
            throw err;
          }
        }
        resetDraft();
      } catch (err) {
        console.error("send failed", err);
        setError(localizeIpcError(err));
      } finally {
        setBusy(false);
      }
    })();
  }, [
    value,
    chips,
    fileChips,
    busy,
    awaitingDecision,
    threadId,
    resetDraft,
    router,
    dispatchRun,
    selectedInstance,
    selectedInstanceId,
    imageCapable,
    t,
  ]);

  const saveQueueEdit = useCallback(() => {
    if (!threadId || !editingQueueId) return;
    const text = value.trim();
    if (!text) return;
    setBusy(true);
    void runsQueueUpdate(threadId, editingQueueId, text)
      .then(() => {
        setEditingQueueId(null);
        setValue(queueDraftRef.current);
        queueDraftRef.current = "";
        requestAnimationFrame(autosize);
      })
      .catch((err) => setError(localizeIpcError(err)))
      .finally(() => setBusy(false));
  }, [threadId, editingQueueId, value, autosize, setValue]);

  const startQueueEdit = useCallback(
    (item: { id: string; text: string }) => {
      queueDraftRef.current = value;
      setEditingQueueId(item.id);
      setValue(item.text);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        autosize();
      });
    },
    [value, autosize, setValue],
  );

  const cancelQueueEdit = useCallback(() => {
    setEditingQueueId(null);
    setValue(queueDraftRef.current);
    queueDraftRef.current = "";
    requestAnimationFrame(autosize);
  }, [autosize, setValue]);

  const moveQueueItem = useCallback(
    (from: number, to: number) => {
      if (!threadId || !queue || from === to) return;
      const ids = queue.map((item) => item.id);
      if (from < 0 || to < 0 || from >= ids.length || to >= ids.length) return;
      ids.splice(to, 0, ...ids.splice(from, 1));
      void runsQueueReorder(threadId, ids).catch((err) => setError(localizeIpcError(err)));
    },
    [threadId, queue],
  );

  const handlePrimary = useCallback(() => {
    if (editingQueueId) saveQueueEdit();
    else handleSend();
  }, [editingQueueId, saveQueueEdit, handleSend]);

  const cancelling = useRunsStore((s) =>
    activeRun ? s.cancellingByRun[activeRun.id] === true : false,
  );

  const handleStop = useCallback(() => {
    if (!activeRun || activeRun.status !== "running") return;
    // The first press asks the agent to cancel; once that is in flight the
    // same button escalates to killing a wedged process.
    runsCancel(activeRun.id, cancelling).catch((err) => console.error("runs_cancel failed", err));
  }, [activeRun, cancelling]);

  // Esc stops the run (§6.1), unless an overlay or a pending decision owns
  // the key first; the slash menu and dialogs call preventDefault themselves.
  useEffect(() => {
    const onKey = (e: WindowEventMap["keydown"]) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (editingQueueId) {
        e.preventDefault();
        cancelQueueEdit();
        return;
      }
      const target = e.target;
      const inOverlay =
        (target instanceof HTMLElement &&
          target.closest('[role="dialog"], [role="listbox"]') !== null) ||
        document.querySelector("[data-escape-layer]") !== null;
      const overlayOpen =
        paletteOpen ||
        elicitationForActiveRun ||
        awaitingDecision ||
        slashOpen ||
        mentionOpen ||
        inOverlay;
      if (!shouldCancelOnEscape({ runActive, overlayOpen })) return;
      e.preventDefault();
      handleStop();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    runActive,
    paletteOpen,
    elicitationForActiveRun,
    awaitingDecision,
    slashOpen,
    mentionOpen,
    handleStop,
    editingQueueId,
    cancelQueueEdit,
  ]);

  // Keyboard answers while a decision is pending (§6.1): A allow once,
  // S allow always, D decline. The textarea is read-only while pending,
  // so plain letters are safe to bind globally.
  useEffect(() => {
    if (!pendingApproval || !runIdForApproval) return;
    const onKey = (e: WindowEventMap["keydown"]) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "SELECT" || target.isContentEditable) return;
        if (tag === "TEXTAREA" && !(target as HTMLTextAreaElement).readOnly) return;
      }
      if (useUiStore.getState().paletteOpen) return;
      const elicitation = useRunsStore.getState().activeElicitation;
      if (elicitation?.runId === runIdForApproval) return;
      const options = pendingApproval.options;
      const pick = (match: (kind: string) => boolean) =>
        options.find((o) => match(o.kind))?.optionId;
      const key = e.key.toLowerCase();
      let optionId: string | undefined;
      if (key === "a") optionId = pick((k) => k === "allow_once");
      if (key === "s")
        optionId = pick((k) => k === "allow_always") ?? pick((k) => k === "allow_once");
      if (key === "d") optionId = pick((k) => k.startsWith("reject"));
      if (optionId === undefined) return;
      e.preventDefault();
      runsRespondPermission(runIdForApproval, pendingApproval.requestId, optionId).catch((err) =>
        console.error("runs_respond_permission failed", err),
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pendingApproval, runIdForApproval]);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(e.clipboardData.files);
      if (files.length === 0) return;
      e.preventDefault();
      void attachFiles(files);
    },
    [attachFiles],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    const textarea = e.currentTarget;
    if (!mentionOpen && !slashOpen && !awaitingDecision) {
      if (e.key === " " && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const edit = handleMarkdownSpace(
          textarea.value,
          textarea.selectionStart,
          textarea.selectionEnd,
        );
        if (edit) {
          e.preventDefault();
          applyTextareaEdit(textarea, edit, setValue);
          requestAnimationFrame(autosize);
          return;
        }
      }
      if (e.key === "Backspace" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const edit = handleMarkdownBackspace(
          textarea.value,
          textarea.selectionStart,
          textarea.selectionEnd,
        );
        if (edit) {
          e.preventDefault();
          applyTextareaEdit(textarea, edit, setValue);
          requestAnimationFrame(autosize);
          return;
        }
      }
    }
    if (mentionOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => (i + 1) % mentionFiles.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => (i - 1 + mentionFiles.length) % mentionFiles.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        pickMention(mentionFiles[mentionIndex] ?? mentionFiles[0]);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        pickMention(mentionFiles[mentionIndex] ?? mentionFiles[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        setMentionFiles([]);
        return;
      }
    }
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        pickSlash(slashMatches[slashIndex] ?? slashMatches[0]);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        pickSlash(slashMatches[slashIndex] ?? slashMatches[0]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setValue("");
        return;
      }
    }
    if (e.key === "Enter") {
      const shouldSend =
        !e.shiftKey &&
        (sendKey === "enter" ? !e.metaKey && !e.ctrlKey : e.metaKey || e.ctrlKey);
      if (shouldSend) {
        e.preventDefault();
        handlePrimary();
        return;
      }
      if (!mentionOpen && !slashOpen && !awaitingDecision) {
        const edit = handleMarkdownNewline(
          textarea.value,
          textarea.selectionStart,
          textarea.selectionEnd,
        );
        if (edit) {
          e.preventDefault();
          applyTextareaEdit(textarea, edit, setValue);
          requestAnimationFrame(autosize);
        }
      }
    }
  };

  const compactContext = () => {
    if (!isTauri() || !threadId) return;
    const store = useUiStore.getState();
    const instanceId = store.instanceByThread[threadId] ?? store.selectedInstanceId;
    if (!instanceId) return;
    void (async () => {
      try {
        const outcome = await runsDispatch(threadId, "/compact", instanceId, []);
        if (outcome.run) useRunsStore.getState().registerRun(outcome.run);
      } catch (err) {
        store.setGlobalError({ kind: "protocol", message: localizeIpcError(err) });
      }
    })();
  };

  return (
    <div className="shrink-0 px-6 pb-5">
      {pendingApproval && (
        <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 rounded-(--radius-md) border border-warning bg-warning/10 px-3 py-1.5">
          <span className="min-w-0 flex-1 text-xs text-warning">
            <span className="block truncate">
              {t("chat.decisionNeeded", { title: pendingApproval.title })}
            </span>
            <span className="block truncate text-text-tertiary">
              {selectedInstance?.displayName ?? selectedInstanceId ?? t("chat.agent")}
              {threadWorkspace ? ` · ${threadWorkspace}` : ""}
            </span>
          </span>
          {pendingApproval.options
            .filter(
              (o) =>
                o.kind === "allow_once" || o.kind === "allow_always" || o.kind.startsWith("reject"),
            )
            .map((option) => {
              const hint =
                option.kind === "allow_once"
                  ? "A"
                  : option.kind === "allow_always"
                    ? "S"
                    : option.kind === "reject_once"
                      ? "D"
                      : "";
              const variant = option.kind.startsWith("reject")
                ? "danger_outline"
                : option.kind === "allow_once"
                  ? "primary"
                  : "secondary";
              return (
                <Button
                  key={option.optionId}
                  size="sm"
                  variant={variant}
                  onClick={() =>
                    runsRespondPermission(
                      runIdForApproval ?? "",
                      pendingApproval.requestId,
                      option.optionId,
                    ).catch((err) => console.error("runs_respond_permission failed", err))
                  }
                >
                  {option.name}{" "}
                  {hint && (
                    <span aria-hidden className="ml-1 text-xs opacity-70">
                      {hint}
                    </span>
                  )}
                </Button>
              );
            })}
        </div>
      )}
      {queue && queue.length > 0 && threadId && (
        <div className="relative z-0 mx-auto -mb-3 w-full max-w-3xl px-3">
          <div
            className="flex flex-col overflow-hidden rounded-t-[18px] border border-b-0 border-border-strong pt-1 pb-4 backdrop-blur-(--composer-blur) backdrop-saturate-[1.08]"
            style={{
              backgroundColor: `color-mix(in srgb, var(--composer-tint) ${glassOpacity}%, transparent)`,
              boxShadow: "var(--shadow-composer)",
            }}
          >
            {queue.map((item, index) => {
              const dragging = dragState?.id === item.id;
              return (
                <div
                  key={item.id}
                  onPointerDown={(event) => {
                    if (editingQueueId !== null) return;
                    const target = event.target as HTMLElement;
                    if (target.closest("button, input, select, textarea, a")) return;
                    event.preventDefault();
                    event.currentTarget.setPointerCapture?.(event.pointerId);
                    setDragState({ id: item.id, startY: event.clientY, offset: 0, index });
                  }}
                  onPointerMove={(event) => {
                    if (!dragging) return;
                    setDragState((current) =>
                      current && current.id === item.id
                        ? { ...current, offset: event.clientY - current.startY }
                        : current,
                    );
                  }}
                  onPointerUp={() => {
                    if (!dragging || !dragState) return;
                    const to = Math.max(
                      0,
                      Math.min(
                        queue.length - 1,
                        index + Math.round(dragState.offset / QUEUE_ROW_HEIGHT),
                      ),
                    );
                    moveQueueItem(index, to);
                    setDragState(null);
                  }}
                  onPointerCancel={() => setDragState(null)}
                  className={`relative flex touch-none items-center gap-2 px-2 py-1.5 select-none transition-transform duration-150 ease-out ${
                    dragging
                      ? "z-10 rounded-(--radius-sm) bg-surface-raised/90 shadow-(--shadow-composer)"
                      : ""
                  } ${editingQueueId === item.id ? "bg-warning/5" : ""}`}
                  style={dragging ? { transform: `translateY(${dragState.offset}px)` } : undefined}
                >
                  <button
                    type="button"
                    aria-label={t("composer.queue.reorderAria")}
                    title={t("composer.queue.dragTitle")}
                    className="flex h-5 w-4 cursor-grab touch-none items-center justify-center text-text-tertiary active:cursor-grabbing"
                  >
                    <GripVertical size={13} />
                  </button>
                  <p className="min-w-0 flex-1 truncate text-sm text-text-secondary">{item.text}</p>
                  <button
                    type="button"
                    aria-label={t("composer.queue.steerAria")}
                    title={t("composer.queue.steerTitle")}
                    onClick={() =>
                      runsQueueSteer(threadId, item.id).catch((err) =>
                        setError(localizeIpcError(err)),
                      )
                    }
                    className="flex h-6 items-center gap-1 rounded-(--radius-sm) border border-border-subtle px-1.5 text-xs text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
                  >
                    <CornerUpRight size={11} /> {t("composer.queue.steerButton")}
                  </button>
                  <button
                    type="button"
                    aria-label={t("composer.queue.editAria")}
                    onClick={() => startQueueEdit(item)}
                    className="flex h-6 items-center gap-1 rounded-(--radius-sm) border border-border-subtle px-1.5 text-xs text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
                  >
                    <Pencil size={11} /> {t("composer.queue.edit")}
                  </button>
                  <button
                    type="button"
                    aria-label={t("composer.queue.removeAria")}
                    onClick={() =>
                      runsQueueRemove(threadId, item.id).catch((err) =>
                        console.error("runs_queue_remove failed", err),
                      )
                    }
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="relative z-10 mx-auto w-full max-w-3xl">
        <div
          className="relative rounded-(--radius-lg) border border-border-strong backdrop-blur-(--composer-blur) backdrop-saturate-[1.08]"
          style={{
            backgroundColor: `color-mix(in srgb, var(--composer-tint) ${glassOpacity}%, transparent)`,
            boxShadow: "var(--shadow-composer-lift), var(--shadow-composer-volume)",
          }}
        >
          {mentionOpen && (
            <div
              className="absolute bottom-full left-0 mb-2 max-h-56 w-full overflow-y-auto rounded-(--radius-md) border border-border-strong bg-surface-raised py-1 shadow-(--shadow-composer)"
              role="listbox"
              aria-label={t("composer.workspaceFiles")}
            >
              <p className="px-3 py-1 text-xs tracking-wider text-text-tertiary uppercase">
                {t("composer.mention.files")}
              </p>
              {mentionFiles.map((path, i) => (
                <button
                  key={path}
                  role="option"
                  aria-selected={i === mentionIndex}
                  onClick={() => pickMention(path)}
                  onMouseEnter={() => setMentionIndex(i)}
                  className={`flex w-full items-center px-3 py-1 text-left font-mono text-xs ${
                    i === mentionIndex ? "bg-hover text-text-primary" : "text-text-secondary"
                  }`}
                >
                  <span className="truncate">{path}</span>
                </button>
              ))}
            </div>
          )}
          {slashOpen && threadId && !mentionOpen && (
            <div
              className="absolute bottom-full left-0 mb-2 w-full overflow-hidden rounded-(--radius-md) border border-border-strong bg-surface-raised shadow-(--shadow-composer)"
              role="listbox"
              aria-label={t("composer.agentCommands")}
            >
              {slashMatches.map((command, i) => (
                <button
                  key={command.name}
                  role="option"
                  aria-selected={i === slashIndex}
                  onClick={() => pickSlash(command)}
                  onMouseEnter={() => setSlashIndex(i)}
                  className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left ${
                    i === slashIndex ? "bg-hover" : ""
                  }`}
                >
                  <span className="font-mono text-sm text-accent">/{command.name}</span>
                  <span className="truncate text-xs text-text-tertiary">{command.description}</span>
                </button>
              ))}
            </div>
          )}
          {error && (
            <div
              className="border-b border-border-subtle px-4 py-1.5 text-xs text-danger"
              role="alert"
            >
              {error}
            </div>
          )}
          {chips.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-4 pt-3">
              {chips.map((chip, i) => (
                <span
                  key={`${chip.preview.slice(-16)}-${i}`}
                  data-image-chip
                  className="group flex max-w-[260px] items-center gap-1.5 rounded-(--radius-sm) bg-surface-raised py-1 pl-1.5 pr-1 text-xs"
                >
                  <img
                    src={chip.preview}
                    alt={t("chat.attached")}
                    onClick={() =>
                      useUiStore.getState().openImagePreview(chip.preview, chip.name)
                    }
                    className="h-[18px] w-[18px] shrink-0 cursor-zoom-in rounded-[3px] object-cover"
                  />
                  <span className="min-w-0 truncate text-accent">{chip.name}</span>
                  <span className="shrink-0 text-text-tertiary">
                    {formatAttachmentSize(chip.size)}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      removeAttachmentToken(chip.token);
                      setChips((prev) => prev.filter((_, index) => index !== i));
                    }}
                    aria-label={t("composer.removeImage")}
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {fileChips.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-4 pt-3">
              {fileChips.map((file, i) => (
                <span
                  key={`${file.name}-${i}`}
                  data-file-chip
                  className="flex max-w-[260px] items-center gap-1.5 rounded-(--radius-sm) bg-surface-raised py-1 pl-1.5 pr-1 text-xs"
                >
                  <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[3px] bg-surface">
                    <FileText size={12} className="text-text-tertiary" />
                  </span>
                  <span className="min-w-0 truncate text-accent">{file.name}</span>
                  <span className="shrink-0 text-text-tertiary">
                    {file.truncated
                      ? t("composer.truncated")
                      : formatAttachmentSize(file.size)}
                  </span>
                  <button
                    type="button"
                    aria-label={t("composer.removeAttachment", { name: file.name })}
                    onClick={() => {
                      removeAttachmentToken(file.token);
                      setFileChips((prev) => prev.filter((_, index) => index !== i));
                    }}
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}
          {editingQueueId && (
            <div className="flex items-center gap-2 px-4 pt-2 text-xs text-warning">
              <Pencil size={11} className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t("composer.queue.editing")}</span>
              <button
                type="button"
                aria-label={t("composer.queue.cancel")}
                onClick={cancelQueueEdit}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
              >
                <X size={11} />
              </button>
            </div>
          )}
          <div className="relative">
            {inlineTokens.size > 0 && (
              <div
                ref={mirrorRef}
                aria-hidden
                className="pointer-events-none absolute inset-0 overflow-hidden px-4 pt-3 pb-1.5 text-sm break-words whitespace-pre-wrap text-text-primary"
              >
                {highlightInlineTokens(value, inlineTokens)}
                {"\u200b"}
              </div>
            )}
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => {
                const next = e.target.value;
                setValue(next);
                setMention(extractMentionQuery(next, e.target.selectionStart ?? next.length));
                autosize();
              }}
              onKeyDown={onKeyDown}
              onPaste={(e) => void handlePaste(e)}
              onScroll={(e) => {
                if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
              }}
              readOnly={awaitingDecision}
              rows={1}
              spellCheck={false}
              placeholder={
                awaitingDecision ? t("composer.decisionPlaceholder") : t("composer.placeholder")
              }
              className={`relative z-10 block max-h-[280px] min-h-[52px] w-full resize-none break-words bg-transparent px-4 pt-3 pb-1.5 text-sm placeholder:text-text-tertiary focus:outline-none ${
                inlineTokens.size > 0 ? "text-transparent caret-text-primary" : "text-text-primary"
              }`}
            />
          </div>
          <div className="flex items-center gap-1.5 px-3 pt-1.5 pb-2.5">
            <label
              title={t("composer.attach")}
              aria-label={t("composer.attach")}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
            >
              <Paperclip size={15} />
              <input
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  void attachFiles(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
            <ModePill threadId={threadId} />
            <div className="flex-1" />
            {threadId && <ContextRing threadId={threadId} onCompact={compactContext} />}
            <ProviderModelPicker threadId={threadId} />
            {editingQueueId ? (
              <button
                type="button"
                onClick={handlePrimary}
                aria-label={t("composer.queue.save")}
                title={t("composer.queue.save")}
                disabled={!value.trim() || busy}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-accent bg-gradient-to-b from-white/35 via-white/10 to-black/15 text-accent-fg transition hover:brightness-110 disabled:bg-none disabled:bg-active disabled:text-text-tertiary disabled:opacity-100"
              >
                <Check size={15} />
              </button>
            ) : runActive ? (
              value.trim() || chips.length > 0 || fileChips.length > 0 ? (
                <button
                  type="button"
                  onClick={handleSend}
                  aria-label={t("composer.queue")}
                  title={t("composer.queue")}
                  disabled={awaitingDecision || busy}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-accent bg-gradient-to-b from-white/35 via-white/10 to-black/15 text-accent-fg transition hover:brightness-110 disabled:bg-none disabled:bg-active disabled:text-text-tertiary disabled:opacity-100"
                >
                  <ListPlus size={15} className="translate-x-[1px]" />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleStop}
                  aria-label={cancelling ? t("composer.forceStop") : t("composer.stop")}
                  title={cancelling ? t("composer.forceStop") : t("composer.stop")}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-danger bg-gradient-to-b from-white/35 via-white/10 to-black/15 text-white transition hover:brightness-110"
                >
                  <span aria-hidden className="h-2.5 w-2.5 rounded-[2px] bg-white" />
                </button>
              )
            ) : (
              <button
                type="button"
                onClick={handleSend}
                aria-label={t("composer.send")}
                title={t("composer.send")}
                disabled={
                  (!value.trim() && chips.length === 0 && fileChips.length === 0) ||
                  awaitingDecision ||
                  busy
                }
                className="flex h-8 w-8 items-center justify-center rounded-full bg-accent bg-gradient-to-b from-white/35 via-white/10 to-black/15 text-accent-fg transition hover:brightness-110 disabled:bg-none disabled:bg-active disabled:text-text-tertiary disabled:opacity-100"
              >
                <ArrowUp size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
