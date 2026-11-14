import { useEffect, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Check, ChevronDown, Layers, Settings2, ShieldCheck } from "lucide-react";
import { runsSetMode, runsSetPermissionMode } from "../../lib/ipc";
import { isTauri } from "../../lib/tauri";
import type { InstanceInfo, SessionMode } from "../../lib/types";
import { activeRunForThread, useRunsStore } from "../../stores/runs";
import { PERMISSION_MODE_LABELS, useSettingsStore } from "../../stores/settings";
import type { PermissionMode } from "../../stores/settings";
import { useUiStore } from "../../stores/ui";

const MODES: PermissionMode[] = ["supervised", "auto_edit", "auto", "full_access"];

const STATUS_DOT_CLASSES: Record<InstanceInfo["status"], string> = {
  stopped: "bg-text-tertiary",
  starting: "bg-text-tertiary",
  running: "bg-success",
  crashed: "bg-danger",
  needs_auth: "bg-warning",
};

/**
 * Controls that parameterize the NEXT message (§6.1 composer control bar):
 * which agent runs it, in which session mode, with how much freedom. They
 * live beside the composer — not in the header — because that is where the
 * decision happens: write → pick who/how → send.
 */

/** Short provider origin for the picker's right badge (T3-style rows). */
function providerLabel(inst: { driver: string; command: string; args: string[] }): string {
  if (inst.driver === "mock") return "built-in";
  const pkg = inst.args.find((a) => a.includes("@") || a.includes("/") || a.includes(".mjs"));
  if (pkg) return pkg.split("/").pop() ?? pkg;
  return inst.command.replace(/\.(exe|cmd|bat)$/i, "");
}

export function AgentPicker() {
  const instances = useUiStore((s) => s.instances);
  const selectedInstanceId = useUiStore((s) => s.selectedInstanceId);
  const setSelectedInstanceId = useUiStore((s) => s.setSelectedInstanceId);
  const [open, setOpen] = useState(false);
  const router = useRouter();

  useEffect(() => {
    if (isTauri()) void useUiStore.getState().loadInstances();
  }, []);

  // Escape closes the popup — without it the invisible backdrop blocks the
  // whole UI until the user clicks somewhere random.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const selected = instances.find((i) => i.id === selectedInstanceId) ?? null;

  return (
    <div className="relative">
      <button
        title="Pick an agent instance"
        onClick={() => setOpen((o) => !o)}
        className="flex min-w-0 items-center gap-1.5 rounded-(--radius-sm) border border-border-subtle bg-surface px-2 py-0.5 text-xs text-text-secondary transition hover:bg-hover"
      >
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${selected ? STATUS_DOT_CLASSES[selected.status] : "bg-text-tertiary"}`}
        />
        <span className="max-w-[160px] truncate">
          {selected ? selected.displayName : "No agent selected"}
        </span>
        <ChevronDown size={12} className="shrink-0 text-text-tertiary" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" data-escape-layer onClick={() => setOpen(false)} />
          <div className="absolute bottom-full right-0 z-50 mb-1 w-72 rounded-(--radius-md) border border-border-strong bg-surface-raised py-1 shadow-(--shadow-composer)">
            {instances.length === 0 ? (
              <p className="px-3 py-2 text-xs text-text-tertiary">No agent instances detected</p>
            ) : (
              instances
                .filter((inst) => inst.enabled)
                .map((inst) => (
                  <button
                    key={inst.id}
                    onClick={() => {
                      setSelectedInstanceId(inst.id);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-text-secondary transition hover:bg-hover"
                  >
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT_CLASSES[inst.status]}`}
                    />
                    <span className="min-w-0 flex-1 truncate">{inst.displayName}</span>
                    {/* provider origin sits right (T3-style model picker) */}
                    <span className="shrink-0 rounded-full bg-active px-1.5 text-[10px] text-text-tertiary">
                      {providerLabel(inst)}
                    </span>
                    {inst.id === selectedInstanceId && (
                      <Check size={12} className="shrink-0 text-accent" />
                    )}
                  </button>
                ))
            )}
            <div className="border-t border-border-subtle">
              <button
                onClick={() => {
                  setOpen(false);
                  void router.navigate({ to: "/settings/providers" });
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
              >
                <Settings2 size={12} /> Manage agents…
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** The agent's session modes (§5.4) — hidden until an agent advertises some. */
export function AgentModePicker({ threadId }: { threadId?: string }) {
  const instances = useUiStore((s) => s.instances);
  const selectedInstanceId = useUiStore((s) => s.selectedInstanceId);
  const [open, setOpen] = useState(false);
  // Escape closes the popup — without it the invisible backdrop blocks the
  // whole UI until the user clicks somewhere random.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const modes = instances.find((i) => i.id === selectedInstanceId)?.modes ?? [];
  const runs = useRunsStore((s) => (threadId ? s.runsByThread[threadId] : undefined));
  const views = useRunsStore((s) => s.viewsByRun);
  const desiredModeId = useRunsStore((s) =>
    threadId ? s.desiredModeByThread[threadId] : s.desiredModeByThread[""],
  );
  const activeRun = activeRunForThread(runs);
  const liveModeId = activeRun ? views[activeRun.id]?.modeId : undefined;
  const currentModeId = liveModeId ?? desiredModeId;
  if (modes.length === 0) return null;

  const current: SessionMode | undefined = modes.find((m) => m.id === currentModeId) ?? modes[0];

  const pick = (mode: SessionMode) => {
    setOpen(false);
    // Remember the pick even with no live run: connection-per-run means the
    // agent only exists during a turn.
    useRunsStore.getState().setDesiredMode(threadId ?? "", mode.id);
    if (threadId && isTauri()) {
      runsSetMode(threadId, mode.id).catch((err) => console.error("runs_set_mode failed", err));
    }
  };

  return (
    <div className="relative">
      <button
        title="Session mode — how this agent approaches the work"
        onClick={() => setOpen((o) => !o)}
        className="flex min-w-0 items-center gap-1.5 rounded-(--radius-sm) border border-border-subtle bg-surface px-2 py-0.5 text-xs text-text-secondary transition hover:bg-hover"
      >
        <Layers size={12} className="shrink-0 text-text-tertiary" />
        <span className="max-w-[120px] truncate">{current?.name ?? current?.id ?? "mode"}</span>
        <ChevronDown size={12} className="shrink-0 text-text-tertiary" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full right-0 z-50 mb-1 w-56 rounded-(--radius-md) border border-border-strong bg-surface-raised py-1 shadow-(--shadow-composer)">
            <p className="px-3 py-1.5 text-xs text-text-tertiary">Agent session modes</p>
            {modes.map((mode) => (
              <button
                key={mode.id}
                onClick={() => pick(mode)}
                className="flex w-full items-start gap-2 px-3 py-1.5 text-left text-sm text-text-secondary transition hover:bg-hover"
                title={mode.description ?? undefined}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{mode.name}</span>
                  {mode.description && (
                    <span className="block truncate text-xs text-text-tertiary">
                      {mode.description}
                    </span>
                  )}
                </span>
                {mode.id === current?.id && (
                  <Check size={12} className="ml-auto shrink-0 text-accent" />
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function ModePill({ threadId }: { threadId?: string }) {
  const permissionMode = useSettingsStore((s) => s.permissionMode);
  const setPermissionMode = useSettingsStore((s) => s.setPermissionMode);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const pick = (mode: PermissionMode) => {
    setPermissionMode(mode);
    setOpen(false);
    if (threadId && isTauri()) {
      runsSetPermissionMode(threadId, mode).catch((err) =>
        console.error("runs_set_permission_mode failed", err),
      );
    }
  };

  return (
    <div className="relative">
      <button
        title="Permission mode — how freely this agent may act"
        aria-label="Permission mode"
        onClick={() => setOpen((o) => !o)}
        className="flex min-w-0 items-center gap-1.5 rounded-(--radius-sm) border border-border-subtle bg-surface px-2 py-0.5 text-xs text-text-secondary transition hover:bg-hover"
      >
        <ShieldCheck size={12} className="shrink-0 text-text-tertiary" />
        <span className="max-w-[140px] truncate">{PERMISSION_MODE_LABELS[permissionMode]}</span>
        <ChevronDown size={12} className="shrink-0 text-text-tertiary" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" data-escape-layer onClick={() => setOpen(false)} />
          <div className="absolute bottom-full right-0 z-50 mb-1 w-56 rounded-(--radius-md) border border-border-strong bg-surface-raised py-1 shadow-(--shadow-composer)">
            <p className="px-3 py-1.5 text-xs text-text-tertiary">How freely agents may act here</p>
            {MODES.map((mode) => (
              <button
                key={mode}
                onClick={() => pick(mode)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-text-secondary transition hover:bg-hover"
              >
                <span className="truncate">{PERMISSION_MODE_LABELS[mode]}</span>
                {mode === permissionMode && (
                  <Check size={12} className="ml-auto shrink-0 text-accent" />
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
