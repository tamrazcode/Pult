import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useRouter } from "@tanstack/react-router";
import { ArrowUp, Plus, Square, X } from "lucide-react";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { AgentModePicker, AgentPicker, ModePill } from "./ComposerControls";
import {
  ipcErrorMessage,
  runsCancel,
  runsDispatch,
  runsQueueRemove,
  runsRespondPermission,
} from "../../lib/ipc";
import { isTauri } from "../../lib/tauri";
import { useGitStore } from "../../stores/git";
import { activeRunForThread, useRunsStore } from "../../stores/runs";
import { useThreadsStore } from "../../stores/threads";
import { useUiStore } from "../../stores/ui";
import type { CommandInfo, ImageInput } from "../../lib/types";

const MAX_HEIGHT = 10 * 24; // 10 rows at the 24px effective line step

/** Pult-local slash commands (never sent to the agent). */
const BUILT_IN_COMMANDS: CommandInfo[] = [
  { name: "commit", description: "Commit this thread's changes — /commit <message>" },
];

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

export function Composer({ threadId }: { threadId?: string }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [chips, setChips] = useState<ImageChip[]>([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const router = useRouter();

  const selectedInstanceId = useUiStore((s) => s.selectedInstanceId);
  const instances = useUiStore((s) => s.instances);
  const commands = useRunsStore((s) => (threadId ? s.commandsByThread[threadId] : undefined));
  const queue = useRunsStore((s) => (threadId ? s.queueByThread[threadId] : undefined));
  const runs = useRunsStore((s) => (threadId ? s.runsByThread[threadId] : undefined));
  const activeRun = activeRunForThread(runs);
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
  const slashOpen = slashMatches.length > 0;

  useEffect(() => {
    if (slashIndex >= slashMatches.length) setSlashIndex(0);
  }, [slashMatches.length, slashIndex]);

  const autosize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, []);

  const dispatchRun = useCallback(
    async (targetThreadId: string, text: string, images: ImageInput[]) => {
      if (!selectedInstanceId) {
        throw new Error("No agent instance selected — pick one in the header");
      }
      const outcome = await runsDispatch(targetThreadId, text, selectedInstanceId, images);
      if (outcome.run) useRunsStore.getState().registerRun(outcome.run);
      // A queued outcome is confirmed by the "queue:update" event.
    },
    [selectedInstanceId],
  );

  const resetDraft = useCallback(() => {
    setValue("");
    setChips([]);
    requestAnimationFrame(autosize);
  }, [autosize]);

  const pickSlash = useCallback((command: CommandInfo) => {
    setValue(`${command.name} `);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, []);

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
          const { workspace, worktree } = useUiStore.getState().newThreadOptions;
          const thread = await useThreadsStore.getState().createThread(null, text.slice(0, 40), {
            workspace: workspace.trim() || undefined,
            worktree,
          });
          await router.navigate({ to: "/thread/$threadId", params: { threadId: thread.id } });
          await dispatchRun(thread.id, text, images);
        } else {
          // Queue-aware: the backend queues while a run is active and
          // auto-dispatches when it finishes.
          await dispatchRun(threadId, text, images);
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
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
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
          {(() => {
            const once = pendingApproval.options.find((o) => o.kind === "allow_once");
            const reject = pendingApproval.options.find((o) => o.kind.startsWith("reject"));
            return (
              <>
                {once && (
                  <Button
                    size="sm"
                    variant="primary"
                    onClick={() =>
                      runsRespondPermission(
                        runIdForApproval ?? "",
                        pendingApproval.requestId,
                        once.optionId,
                      ).catch((err) => console.error("runs_respond_permission failed", err))
                    }
                  >
                    {once.name} <span className="ml-1 text-xs opacity-70">A</span>
                  </Button>
                )}
                {reject && (
                  <Button
                    size="sm"
                    variant="danger_outline"
                    onClick={() =>
                      runsRespondPermission(
                        runIdForApproval ?? "",
                        pendingApproval.requestId,
                        reject.optionId,
                      ).catch((err) => console.error("runs_respond_permission failed", err))
                    }
                  >
                    {reject.name} <span className="ml-1 text-xs opacity-70">D</span>
                  </Button>
                )}
              </>
            );
          })()}
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
      <div className="relative rounded-2xl border border-border-strong bg-(--composer-tint) shadow-(--shadow-composer) backdrop-blur-(--composer-blur) backdrop-saturate-[1.08]">
        {runActive && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-4 top-0 h-px overflow-hidden motion-reduce:hidden"
          >
            <div className="h-full w-1/4 rounded-full bg-accent/70 composer-hairline" />
          </div>
        )}
        {slashOpen && threadId && (
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
            setValue(e.target.value);
            autosize();
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => void handlePaste(e)}
          rows={1}
          spellCheck={false}
          placeholder={
            awaitingDecision
              ? "Decision needed — respond to the approval above"
              : "Ask anything. @ files, / commands"
          }
          className="block max-h-60 w-full resize-none bg-transparent px-4 pt-3.5 text-base text-text-primary placeholder:text-text-tertiary focus:outline-none"
        />
        <div className="flex items-center gap-1.5 px-3 pb-2.5 pt-1">
          {imageCapable ? (
            <label
              title="Attach images"
              aria-label="Attach images"
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
            >
              <Plus size={16} />
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
              <Plus size={16} />
            </span>
          )}
          <ComposerStatusLine threadId={threadId} awaitingDecision={awaitingDecision} />
          <div className="flex-1" />
          {/* Controls that parameterize the next message (§6.1 control bar),
              ordered like the reference apps: reasoning ▸ agents ▸ access. */}
          <AgentModePicker threadId={threadId} />
          <AgentPicker />
          <ModePill threadId={threadId} />
          <Kbd>Enter</Kbd>
          {activeRun?.status === "running" && (
            <Button
              variant="secondary"
              size="sm"
              onClick={handleStop}
              aria-label="Stop run"
              title="Stop run"
            >
              <Square size={11} />
            </Button>
          )}
          <Button
            variant="primary"
            size="sm"
            onClick={handleSend}
            aria-label="Send message"
            disabled={(!value.trim() && chips.length === 0) || awaitingDecision || busy}
          >
            <ArrowUp size={14} />
          </Button>
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
  const raw = threadWorkspace ?? newThreadWorkspace;
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
