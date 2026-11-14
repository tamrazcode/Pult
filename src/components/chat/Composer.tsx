import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useRouter } from "@tanstack/react-router";
import { ArrowUp, MoreHorizontal, Paperclip, Square, X } from "lucide-react";
import { Button } from "../ui/button";
import {
  AgentModePicker,
  AgentPicker,
  ConfigOptionPickers,
  ModePill,
  ModelPill,
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
import { useUiStore } from "../../stores/ui";
import type { CommandInfo, ConfigOptionValue, ImageInput } from "../../lib/types";

const MAX_HEIGHT = 10 * 24; // 10 rows at the 24px effective line step

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
): Record<string, ConfigOptionValue> | null {
  const config = threadId ? desired[threadId] : desired[""];
  return config && Object.keys(config).length > 0 ? config : null;
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
          <section>
            <p className="mb-1.5 text-[10px] font-semibold tracking-wider text-text-tertiary uppercase">
              Reasoning
            </p>
            <div className="flex flex-wrap gap-1.5">
              <ConfigOptionPickers threadId={threadId} excludeIds={["model"]} />
            </div>
          </section>
          <section>
            <p className="mb-1.5 text-[10px] font-semibold tracking-wider text-text-tertiary uppercase">
              Session mode
            </p>
            <AgentModePicker threadId={threadId} />
          </section>
          <section>
            <p className="mb-1.5 text-[10px] font-semibold tracking-wider text-text-tertiary uppercase">
              Permission
            </p>
            <ModePill threadId={threadId} />
          </section>
          <section>
            <p className="mb-1.5 text-[10px] font-semibold tracking-wider text-text-tertiary uppercase">
              Agent
            </p>
            <AgentPicker threadId={threadId} />
          </section>
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
  const activeElicitation = useRunsStore((s) => s.activeElicitation);
  const commands = useRunsStore((s) => (threadId ? s.commandsByThread[threadId] : undefined));
  const queue = useRunsStore((s) => (threadId ? s.queueByThread[threadId] : undefined));
  const runs = useRunsStore((s) => (threadId ? s.runsByThread[threadId] : undefined));
  const activeRun = activeRunForThread(runs);

  // Reopening a thread restores the provider it last used; a stale send error
  // from another thread must not leak into this composer.
  useEffect(() => {
    setError(null);
    if (!threadId) return;
    const remembered = useUiStore.getState().instanceByThread[threadId];
    if (
      remembered &&
      remembered !== useUiStore.getState().selectedInstanceId &&
      instances.some((instance) => instance.id === remembered)
    ) {
      useUiStore.getState().setSelectedInstanceId(remembered);
    }
  }, [threadId, instances]);
  const pendingApproval = useRunsStore((s) =>
    activeRun ? s.viewsByRun[activeRun.id]?.pendingApproval : undefined,
  );
  const awaitingDecision = pendingApproval !== undefined;
  const runIdForApproval = pendingApproval !== undefined ? (activeRun?.id ?? null) : null;
  const runActive =
    activeRun !== undefined && (activeRun.status === "running" || activeRun.status === "queued");

  // Image attach is capability-gated: only agents that declared
  // promptCapabilities.image show the chip affordance.
  const imageCapable = instances.find((i) => i.id === selectedInstanceId)?.promptImage === true;

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
          const pendingConfig = configForSend(useRunsStore.getState().desiredConfigByThread);
          const { workspace, worktree } = useUiStore.getState().newThreadOptions;
          const selectedProjectId = useProjectsStore.getState().selectedProjectId;
          const project = useProjectsStore
            .getState()
            .projects.find((candidate) => candidate.id === selectedProjectId);
          const explicitWorkspace = workspace.trim();
          const targetWorkspace = explicitWorkspace || project?.rootPath || undefined;
          // An explicit folder outside the project is standalone; only the
          // project's own folder (or no override) keeps the project link.
          const targetProject =
            explicitWorkspace && explicitWorkspace !== project?.rootPath ? null : project;
          // An explicit folder is the user's override; otherwise the project's
          // worktree strategy decides.
          const targetWorktree =
            explicitWorkspace && explicitWorkspace !== project?.rootPath
              ? worktree
              : worktree || project?.worktreeStrategy === "worktree";
          const thread = await useThreadsStore
            .getState()
            .createThread(targetProject?.id ?? null, text.slice(0, 40), {
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
          if (!targetProject && project) useProjectsStore.getState().selectProject(null);
          await router.navigate({ to: "/thread/$threadId", params: { threadId: thread.id } });
          await dispatchRun(thread.id, text, images, pendingMode, pendingConfig);
          // The pending picks now belong to this thread; never to the next one.
          if (pendingMode) useRunsStore.getState().setDesiredMode("", "");
          if (pendingConfig) useRunsStore.getState().clearDesiredConfig("");
        } else {
          // Queue-aware: the backend queues while a run is active and
          // auto-dispatches when it finishes.
          const desired = useRunsStore.getState().desiredModeByThread;
          const config = configForSend(useRunsStore.getState().desiredConfigByThread, threadId);
          await dispatchRun(threadId, text, images, modeForSend(desired, threadId), config);
        }
        resetDraft();
      } catch (err) {
        console.error("send failed", err);
        setError(ipcErrorMessage(err));
      } finally {
        setBusy(false);
      }
    })();
  }, [value, chips, busy, awaitingDecision, threadId, resetDraft, router, dispatchRun]);

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
      if (target && target.tagName === "TEXTAREA" && !(target as HTMLTextAreaElement).readOnly) {
        return;
      }
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
      // Plain Enter sends (standard chat UX); Shift+Enter is the newline.
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="shrink-0 px-6 pb-5">
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
              className="flex items-start gap-2 rounded-(--radius-md) border border-border-subtle bg-surface px-3 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <p className="text-xs text-text-tertiary">
                  Queued — sends when the current turn ends
                </p>
                <p className="truncate text-sm text-text-secondary">{item.text}</p>
              </div>
              <button
                onClick={() =>
                  runsQueueRemove(threadId, item.id).catch((err) =>
                    console.error("runs_queue_remove failed", err),
                  )
                }
                aria-label="Remove queued message"
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
              >
                <X size={12} />
              </button>
            </div>
          ))}
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
            <p className="px-3 py-1 text-[10px] tracking-wider text-text-tertiary uppercase">
              Files
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
          className="block max-h-60 min-h-[52px] w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none"
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
              title="This agent does not accept images"
              className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) text-text-tertiary/40"
            >
              <Paperclip size={15} />
            </span>
          )}
          <ComposerStatusLine threadId={threadId} awaitingDecision={awaitingDecision} />
          <div className="flex-1" />
          <ModelPill threadId={threadId} />
          <ComposerOverflowMenu threadId={threadId} />
          {activeRun?.status === "running" && !value.trim() && chips.length === 0 ? (
            <button
              type="button"
              onClick={handleStop}
              aria-label="Stop run"
              title="Stop run"
              className="flex h-8 w-8 items-center justify-center rounded-full bg-danger text-white transition hover:brightness-110"
            >
              <Square size={11} />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSend}
              aria-label="Send message"
              title="Send message"
              disabled={(!value.trim() && chips.length === 0) || awaitingDecision || busy}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-accent-fg transition hover:brightness-110 disabled:opacity-40"
            >
              <ArrowUp size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Identity of where the next run lands (§6.1 status line): the thread's
 * workspace and its git branch. Decisions that need attention surface here
 * too ("Decision needed") because it sits on the send path.
 */
function ComposerStatusLine({
  threadId,
  awaitingDecision,
}: {
  threadId?: string;
  awaitingDecision: boolean;
}) {
  const threadWorkspace = useThreadsStore((s) =>
    threadId ? (s.threads.find((t) => t.id === threadId)?.workspace ?? null) : null,
  );
  const newThreadWorkspace = useUiStore((s) =>
    threadId ? null : s.newThreadOptions.workspace || null,
  );
  const projectRoot = useProjectsStore((s) =>
    threadId
      ? null
      : (s.projects.find((project) => project.id === s.selectedProjectId)?.rootPath ?? null),
  );
  const branch = useGitStore((s) =>
    threadId ? (s.byThread[threadId]?.status?.branch ?? null) : null,
  );
  const refresh = useGitStore((s) => s.refresh);
  useEffect(() => {
    if (threadId) void refresh(threadId);
  }, [threadId, refresh]);

  if (awaitingDecision) {
    return <span className="truncate text-xs text-warning">Decision needed — see above</span>;
  }
  const raw = threadWorkspace ?? newThreadWorkspace ?? projectRoot;
  if (!raw) {
    return <span className="truncate text-xs text-text-tertiary">No workspace selected</span>;
  }
  const path = raw.replace(/^\\\\\?\\/, "").replace(/^C:\\Users\\[^\\]+/i, "~");
  return (
    <span title={raw} className="min-w-0 truncate font-mono text-xs text-text-tertiary tnum">
      {path}
      {branch ? ` · ${branch}` : ""}
    </span>
  );
}
