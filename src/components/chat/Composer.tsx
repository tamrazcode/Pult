import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useRouter } from "@tanstack/react-router";
import { ArrowUp, ListPlus, MoreHorizontal, Paperclip, Square, X } from "lucide-react";
import { Button } from "../ui/button";
import {
  AgentModePicker,
  ConfigOptionPickers,
  ModePill,
  ProviderModelPicker,
  configValueValid,
} from "./ComposerControls";
import {
  ipcErrorMessage,
  runsCancel,
  runsDispatch,
  runsQueueRemove,
  runsRespondPermission,
  workspaceFiles,
} from "../../lib/ipc";
import { isTauri } from "../../lib/tauri";
import { useGitStore } from "../../stores/git";
import { useProjectsStore } from "../../stores/projects";
import { activeRunForThread, useRunsStore } from "../../stores/runs";
import { useThreadsStore } from "../../stores/threads";
import { useSettingsStore } from "../../stores/settings";
import { useUiStore } from "../../stores/ui";
import type {
  CommandInfo,
  ConfigOptionValue,
  ImageInput,
  SessionConfigOption,
} from "../../lib/types";

const MAX_HEIGHT = 10 * 28; // 10 rows at the 28px effective line step

/** Pult-local slash commands (never sent to the agent). */
const BUILT_IN_COMMANDS: CommandInfo[] = [
  { name: "commit", description: "Commit this thread's changes — /commit <message>" },
];

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

interface ImageChip {
  /** Base64 payload (no data URL prefix). */
  data: string;
  mimeType: string;
  /** Full data URL for the thumbnail. */
  preview: string;
}

function chipFromDataUrl(dataUrl: string): ImageChip | null {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], data: match[2], preview: dataUrl };
}

function fileToChip(file: File): Promise<ImageChip | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === "string" ? chipFromDataUrl(reader.result) : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** One overflow menu for every secondary control; one permission control inside. */
function ComposerOverflowMenu({ threadId }: { threadId?: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const modes =
    useUiStore(
      (s) => s.instances.find((instance) => instance.id === s.selectedInstanceId)?.modes,
    ) ?? [];
  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // A nested picker owns this Escape; close it first, then the menu.
      if (dialogRef.current?.querySelector("[data-composer-submenu]")) return;
      event.preventDefault();
      setOpen(false);
    };
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label="Composer options"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Composer options"
        onClick={() => setOpen((current) => !current)}
        className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
      >
        <MoreHorizontal size={15} />
      </button>
      {open && (
        <div
          ref={dialogRef}
          role="dialog"
          aria-label="Composer options"
          data-escape-layer
          className="absolute right-0 bottom-full z-50 mb-2 w-72 space-y-3 rounded-(--radius-md) border border-border-strong bg-surface-raised p-3 shadow-(--shadow-composer)"
        >
          {modes.length > 0 && (
            <section>
              <p className="mb-1.5 text-xs font-semibold tracking-wider text-text-tertiary uppercase">
                Session mode
              </p>
              <AgentModePicker threadId={threadId} />
            </section>
          )}
          <ConfigOptionPickers threadId={threadId} heading="Options" excludeModelAndReasoning />
        </div>
      )}
    </div>
  );
}

export function Composer({ threadId }: { threadId?: string }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [chips, setChips] = useState<ImageChip[]>([]);
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

  // A Branch action hands the message text over once; consume it here.
  useEffect(() => {
    if (!composerPrefill) return;
    setValue(composerPrefill);
    useUiStore.getState().setComposerPrefill(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [composerPrefill]);

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
  const runIdForApproval = pendingApproval !== undefined ? (activeRun?.id ?? null) : null;
  const runActive =
    activeRun !== undefined && (activeRun.status === "running" || activeRun.status === "queued");

  const selectedInstance = instances.find((i) => i.id === selectedInstanceId);
  // Image attach is capability-gated: only agents that declared
  // promptCapabilities.image show the chip affordance.
  const imageCapable = selectedInstance?.promptImage === true;

  // Slash menu: active while the draft is a "/command…" query. Agent commands
  // merge with pult's built-ins (/commit).
  const slashQuery = value.startsWith("/") && !value.includes("\n") ? value.slice(1) : null;
  const slashMatches = useMemo<CommandInfo[]>(() => {
    if (slashQuery === null) return [];
    const q = slashQuery.toLowerCase();
    const all = [...BUILT_IN_COMMANDS, ...(commands ?? [])];
    return all.filter((c) => c.name.toLowerCase().startsWith(q));
  }, [slashQuery, commands]);
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
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, []);

  const dispatchRun = useCallback(
    async (
      targetThreadId: string,
      text: string,
      images: ImageInput[],
      mode: string | null,
      config: Record<string, ConfigOptionValue> | null,
    ) => {
      if (!selectedInstanceId) {
        throw new Error("No agent instance selected - pick one in the header");
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
      // A queued outcome is confirmed by the "queue:update" event.
    },
    [selectedInstanceId],
  );

  const resetDraft = useCallback(() => {
    setValue("");
    setChips([]);
    setMention(null);
    setMentionFiles([]);
    requestAnimationFrame(autosize);
  }, [autosize]);

  const pickSlash = useCallback((command: CommandInfo) => {
    setValue(formatSlashInsertion(command));
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

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
    [mention, value, autosize],
  );

  const handleSend = useCallback(() => {
    const text = value.trim();
    if ((!text && chips.length === 0) || busy || awaitingDecision) return;
    if (!isTauri()) {
      // Plain-browser dev: no backend; keep the M0 input-clearing behavior.
      resetDraft();
      return;
    }
    // Pult-local /commit: stages everything and commits from the composer.
    if (text.startsWith("/commit")) {
      const message = text.slice("/commit".length).trim();
      if (!threadId) {
        setError("/commit works inside a thread");
        return;
      }
      if (!message) {
        setError("Usage: /commit <message>");
        return;
      }
      setBusy(true);
      setError(null);
      void (async () => {
        const git = useGitStore.getState();
        git.setCommitMessage(threadId, message);
        const ok = await git.commit(threadId);
        if (!ok) setError("Commit failed — details in the diff panel");
        setBusy(false);
      })();
      resetDraft();
      return;
    }
    setBusy(true);
    setError(null);
    const images: ImageInput[] = chips.map(({ data, mimeType }) => ({ data, mimeType }));
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
            .createThread(project?.id ?? null, text.slice(0, 40), {
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
          useRunsStore.getState().setPendingUser(thread.id, text, images);
          await router.navigate({ to: "/thread/$threadId", params: { threadId: thread.id } });
          try {
            await dispatchRun(thread.id, text, images, pendingMode, pendingConfig);
          } catch (err) {
            useRunsStore.getState().clearPendingUser(thread.id);
            useUiStore
              .getState()
              .setGlobalError({ kind: "protocol", message: ipcErrorMessage(err) });
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
          useRunsStore.getState().setPendingUser(threadId, text, images);
          try {
            await dispatchRun(threadId, text, images, modeForSend(desired, threadId), config);
          } catch (err) {
            useRunsStore.getState().clearPendingUser(threadId);
            throw err;
          }
        }
        resetDraft();
      } catch (err) {
        console.error("send failed", err);
        setError(ipcErrorMessage(err));
      } finally {
        setBusy(false);
      }
    })();
  }, [
    value,
    chips,
    busy,
    awaitingDecision,
    threadId,
    resetDraft,
    router,
    dispatchRun,
    selectedInstance,
    selectedInstanceId,
  ]);

  const handleStop = useCallback(() => {
    if (!activeRun || activeRun.status !== "running") return;
    runsCancel(activeRun.id).catch((err) => console.error("runs_cancel failed", err));
  }, [activeRun]);

  // Esc stops the run (§6.1), unless an overlay or a pending decision owns
  // the key first; the slash menu and dialogs call preventDefault themselves.
  useEffect(() => {
    const onKey = (e: WindowEventMap["keydown"]) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const target = e.target;
      const inOverlay =
        (target instanceof HTMLElement &&
          target.closest('[role="dialog"], [role="listbox"]') !== null) ||
        document.querySelector("[data-escape-layer]") !== null;
      const overlayOpen =
        paletteOpen ||
        activeElicitation !== null ||
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
    activeElicitation,
    awaitingDecision,
    slashOpen,
    mentionOpen,
    handleStop,
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
      if (useUiStore.getState().paletteOpen || useRunsStore.getState().activeElicitation) return;
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
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (!imageCapable) return;
      const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
      if (files.length === 0) return;
      e.preventDefault();
      const imported = await Promise.all(files.slice(0, 4).map(fileToChip));
      setChips((prev) => [...prev, ...imported.filter((c): c is ImageChip => c !== null)]);
    },
    [imageCapable],
  );

  const handleAttach = useCallback(async (files: FileList | null) => {
    if (!files) return;
    const images = Array.from(files).filter((f) => f.type.startsWith("image/"));
    const imported = await Promise.all(images.slice(0, 4).map(fileToChip));
    setChips((prev) => [...prev, ...imported.filter((c): c is ImageChip => c !== null)]);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
    if (e.key === "Enter" && !e.shiftKey) {
      const shouldSend = sendKey === "enter" ? !e.metaKey && !e.ctrlKey : e.metaKey || e.ctrlKey;
      if (!shouldSend) return;
      // Enter sends (default); Shift+Enter is always a newline.
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="shrink-0 px-3 pb-5 sm:px-6">
      {pendingApproval && (
        <div className="mx-auto mb-2 flex max-w-3xl items-center gap-2 rounded-(--radius-md) border border-warning bg-warning/10 px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate text-xs text-warning">
            Decision needed: {pendingApproval.title}
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
        <div className="mx-auto mb-2 flex max-w-3xl flex-col gap-1">
          {queue.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-2 rounded-(--radius-md) border border-border-subtle bg-surface px-3 py-1.5"
            >
              <span aria-hidden className="text-text-tertiary">
                ⠿
              </span>
              <p className="min-w-0 flex-1 truncate text-sm text-text-secondary">{item.text}</p>
              <button
                type="button"
                aria-label="Edit queued message"
                onClick={() => {
                  runsQueueRemove(threadId, item.id).catch((err) =>
                    console.error("runs_queue_remove failed", err),
                  );
                  setValue(item.text);
                  textareaRef.current?.focus();
                }}
                className="flex h-6 items-center gap-1 rounded-(--radius-sm) border border-border-subtle px-1.5 text-xs text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
              >
                <ArrowUp size={11} /> Edit
              </button>
              <button
                onClick={() =>
                  runsQueueRemove(threadId, item.id).catch((err) =>
                    console.error("runs_queue_remove failed", err),
                  )
                }
                aria-label="Remove queued message"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <p className="px-1 text-xs text-text-tertiary">Keep typing to queue another message</p>
        </div>
      )}
      <div className="relative mx-auto w-full max-w-3xl rounded-(--radius-lg) border border-border-strong bg-(--composer-tint) shadow-(--shadow-composer) backdrop-blur-(--composer-blur) backdrop-saturate-[1.08]">
        {runActive && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-4 top-0 h-px overflow-hidden motion-reduce:hidden"
          >
            <div className="h-full w-1/4 rounded-full bg-accent/70 composer-hairline" />
          </div>
        )}
        {mentionOpen && (
          <div
            className="absolute bottom-full left-0 mb-2 max-h-56 w-full overflow-y-auto rounded-(--radius-md) border border-border-strong bg-surface-raised py-1 shadow-(--shadow-composer)"
            role="listbox"
            aria-label="Workspace files"
          >
            <p className="px-3 py-1 text-xs tracking-wider text-text-tertiary uppercase">Files</p>
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
            aria-label="Agent commands"
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
          <div className="flex flex-wrap gap-2 px-4 pt-3">
            {chips.map((chip, i) => (
              <div
                key={`${chip.preview.slice(-16)}-${i}`}
                className="group relative h-14 w-14 overflow-hidden rounded-(--radius-md) border border-border-subtle"
              >
                <img src={chip.preview} alt="Attached" className="h-full w-full object-cover" />
                <button
                  onClick={() => setChips((prev) => prev.filter((_, j) => j !== i))}
                  aria-label="Remove image"
                  className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white opacity-0 transition group-hover:opacity-100"
                >
                  <X size={10} />
                </button>
              </div>
            ))}
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
          readOnly={awaitingDecision}
          rows={1}
          spellCheck={false}
          placeholder={
            awaitingDecision
              ? "Decision needed — respond to the approval above"
              : "Ask anything. @ files, / commands"
          }
          className="block max-h-[280px] min-h-[52px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
        />
        <div className="flex items-center gap-1.5 px-2.5 pt-1 pb-2">
          {imageCapable ? (
            <label
              title="Attach images"
              aria-label="Attach images"
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
            >
              <Paperclip size={15} />
              <input
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => {
                  void handleAttach(e.target.files);
                  e.target.value = "";
                }}
              />
            </label>
          ) : (
            <span
              role="img"
              aria-label="Images are not supported by this agent"
              title="This agent does not accept images"
              className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) text-text-tertiary/40"
            >
              <Paperclip size={15} />
            </span>
          )}
          <ModePill threadId={threadId} />
          <div className="flex-1" />
          <ProviderModelPicker threadId={threadId} />
          <ComposerOverflowMenu threadId={threadId} />
          {runActive ? (
            value.trim() || chips.length > 0 ? (
              <button
                type="button"
                onClick={handleSend}
                aria-label="Queue message"
                title="Queue message"
                disabled={awaitingDecision || busy}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-accent-fg transition hover:brightness-110 disabled:bg-active disabled:text-text-tertiary disabled:opacity-100"
              >
                <ListPlus size={15} />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleStop}
                aria-label="Stop run"
                title="Stop run"
                className="flex h-8 w-8 items-center justify-center rounded-full bg-danger text-white transition hover:brightness-110"
              >
                <Square size={11} />
              </button>
            )
          ) : (
            <button
              type="button"
              onClick={handleSend}
              aria-label="Send message"
              title="Send message"
              disabled={(!value.trim() && chips.length === 0) || awaitingDecision || busy}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-accent-fg transition hover:brightness-110 disabled:bg-active disabled:text-text-tertiary disabled:opacity-100"
            >
              <ArrowUp size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
