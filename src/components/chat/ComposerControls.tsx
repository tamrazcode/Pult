import { Fragment, useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { Check, ChevronDown, Layers, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { runsSetConfigOption, runsSetMode, runsSetPermissionMode } from "../../lib/ipc";
import { isTauri } from "../../lib/tauri";
import type {
  ConfigOptionValue,
  InstanceInfo,
  SessionConfigOption,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
  SessionConfigSelectOptions,
  SessionMode,
} from "../../lib/types";
import { activeRunForThread, useRunsStore } from "../../stores/runs";
import { PERMISSION_MODE_LABELS, useSettingsStore } from "../../stores/settings";
import type { PermissionMode } from "../../stores/settings";
import { useUiStore } from "../../stores/ui";
import { ProviderLogo } from "./ProviderLogo";

const MODES: PermissionMode[] = ["supervised", "auto_edit", "auto", "full_access"];

/**
 * The picker shows the remembered pick for the next run; a live run's own
 * mode only matters until the user chooses again or the run ends.
 */
export function pickerModeId(
  activeRun: { status: string } | undefined,
  liveModeId: string | undefined,
  desiredModeId: string | undefined,
): string | undefined {
  const live =
    activeRun && (activeRun.status === "running" || activeRun.status === "queued")
      ? liveModeId
      : undefined;
  return desiredModeId ?? live;
}

// ---- session config options (M10) ----

export function isGroupedSelectOptions(
  options: SessionConfigSelectOptions,
): options is SessionConfigSelectGroup[] {
  return options.length > 0 && "group" in options[0];
}

export function flattenSelectOptions(
  options: SessionConfigSelectOptions,
): SessionConfigSelectOption[] {
  return isGroupedSelectOptions(options) ? options.flatMap((group) => group.options) : options;
}

export function configValueValid(option: SessionConfigOption, value: ConfigOptionValue): boolean {
  if (option.type === "boolean") return typeof value === "boolean";
  if (typeof value !== "string") return false;
  return flattenSelectOptions(option.options).some((item) => item.value === value);
}

/** Remembered pick when valid, else the live run's value, else the default. */
export function pickerConfigValue(
  option: SessionConfigOption,
  activeRun: { status: string } | undefined,
  liveOptions: SessionConfigOption[] | undefined,
  desired: Record<string, ConfigOptionValue> | undefined,
): ConfigOptionValue {
  const desiredValue = desired?.[option.id];
  if (desiredValue !== undefined && configValueValid(option, desiredValue)) return desiredValue;
  const live =
    activeRun && (activeRun.status === "running" || activeRun.status === "queued")
      ? liveOptions?.find((item) => item.id === option.id)
      : undefined;
  return live?.currentValue ?? option.currentValue;
}

/** One source for the selected agent's live/cached config options. */
function useInstanceOptions(threadId?: string) {
  const instances = useUiStore((s) => s.instances);
  const selectedInstanceId = useUiStore((s) => s.selectedInstanceId);
  const runs = useRunsStore((s) => (threadId ? s.runsByThread[threadId] : undefined));
  const desired = useRunsStore((s) =>
    threadId ? s.desiredConfigByThread[threadId] : s.desiredConfigByThread[""],
  );
  const activeRun = activeRunForThread(runs);
  const activeRunId = activeRun?.id;
  const liveOptions = useRunsStore((s) =>
    activeRunId ? s.viewsByRun[activeRunId]?.configOptions : undefined,
  );
  const instance = instances.find((candidate) => candidate.id === selectedInstanceId);
  // A live session only owns this picker when the running agent is the selected one.
  const hasLiveRun = Boolean(
    activeRun && (activeRun.status === "running" || activeRun.status === "queued"),
  );
  // A live session only owns this picker when the running agent is the selected one.
  const liveOnSelected = hasLiveRun && activeRun?.instanceId === selectedInstanceId;
  const options = (liveOnSelected ? liveOptions : undefined) ?? instance?.configOptions ?? [];
  return {
    instances,
    instance,
    options,
    activeRun,
    liveOptions,
    hasLiveRun,
    liveOnSelected,
    desired,
    selectedInstanceId,
  };
}

const REASONING_OPTION_IDS = new Set([
  "thinking_level",
  "effort",
  "thought_level",
  "reasoning_effort",
  "reasoning",
]);

export function isModelOption(option: SessionConfigOption): boolean {
  return option.type === "select" && (option.id === "model" || option.category === "model");
}

export function isReasoningOption(option: SessionConfigOption): boolean {
  return (
    REASONING_OPTION_IDS.has(option.id) ||
    option.category === "thought_level" ||
    option.category === "reasoning"
  );
}

/**
 * Model / thought-level / toggle pills from the selected agent's session
 * config options. Picks persist per thread and apply to the next run.
 */
export function ConfigOptionPickers({
  threadId,
  excludeIds = [],
  excludeModelAndReasoning = false,
  heading,
}: {
  threadId?: string;
  excludeIds?: string[];
  excludeModelAndReasoning?: boolean;
  heading?: string;
}) {
  const { options: allOptions, activeRun, liveOptions, desired } = useInstanceOptions(threadId);
  const options = allOptions.filter(
    (option) =>
      !excludeIds.includes(option.id) &&
      option.id !== "mode" &&
      option.category !== "mode" &&
      !(excludeModelAndReasoning && (isModelOption(option) || isReasoningOption(option))),
  );
  if (options.length === 0) return null;

  const pick = (option: SessionConfigOption, value: ConfigOptionValue) => {
    useRunsStore.getState().setDesiredConfig(threadId ?? "", option.id, value);
    if (threadId && isTauri()) {
      runsSetConfigOption(threadId, option.id, value).catch((err) =>
        console.error("runs_set_config_option failed", err),
      );
    }
  };

  const pills = (
    <>
      {options.map((option) =>
        option.type === "boolean" ? (
          <BooleanOptionPill
            key={option.id}
            option={option}
            value={pickerConfigValue(option, activeRun, liveOptions, desired) === true}
            onPick={(value) => pick(option, value)}
          />
        ) : (
          <SelectOptionPill
            key={option.id}
            option={option}
            value={String(pickerConfigValue(option, activeRun, liveOptions, desired))}
            onPick={(value) => pick(option, value)}
          />
        ),
      )}
    </>
  );

  if (!heading) return pills;
  return (
    <section>
      <p className="mb-1.5 text-xs font-semibold tracking-wider text-text-tertiary uppercase">
        {heading}
      </p>
      <div className="flex flex-wrap gap-1.5">{pills}</div>
    </section>
  );
}

function SelectOptionPill({
  option,
  value,
  onPick,
}: {
  option: Extract<SessionConfigOption, { type: "select" }>;
  value: string;
  onPick: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const flat = flattenSelectOptions(option.options);
  const current = flat.find((item) => item.value === value);
  const row = (item: SessionConfigSelectOption) => (
    <button
      key={item.value}
      role="option"
      aria-selected={item.value === value}
      onClick={() => {
        onPick(item.value);
        setOpen(false);
      }}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-text-secondary transition hover:bg-hover"
    >
      <span className="min-w-0 flex-1 truncate">{item.name}</span>
      {item.value === value && <Check size={12} className="shrink-0 text-accent" />}
    </button>
  );

  return (
    <div className="relative">
      <button
        aria-label={`${option.name}: ${current?.name ?? value}`}
        title={option.description ?? option.name}
        onClick={() => setOpen((o) => !o)}
        className="flex min-w-0 items-center gap-1.5 rounded-(--radius-sm) border border-border-subtle bg-surface px-2 py-0.5 text-xs text-text-secondary transition hover:bg-hover"
      >
        <SlidersHorizontal size={12} className="shrink-0 text-text-tertiary" />
        <span className="max-w-[130px] truncate">
          {option.name} · {current?.name ?? value}
        </span>
        <ChevronDown size={12} className="shrink-0 text-text-tertiary" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" data-escape-layer onClick={() => setOpen(false)} />
          <div
            data-composer-submenu
            role="listbox"
            aria-label={option.name}
            className="absolute bottom-full right-0 z-50 mb-1 max-h-64 w-64 overflow-y-auto rounded-(--radius-md) border border-border-strong bg-surface-raised py-1 shadow-(--shadow-composer)"
          >
            {isGroupedSelectOptions(option.options)
              ? option.options.map((group) => (
                  <Fragment key={group.group}>
                    <p className="px-3 py-1 text-xs tracking-wider text-text-tertiary uppercase">
                      {group.name}
                    </p>
                    {group.options.map(row)}
                  </Fragment>
                ))
              : option.options.map(row)}
          </div>
        </>
      )}
    </div>
  );
}

function BooleanOptionPill({
  option,
  value,
  onPick,
}: {
  option: Extract<SessionConfigOption, { type: "boolean" }>;
  value: boolean;
  onPick: (value: boolean) => void;
}) {
  return (
    <button
      aria-label={option.name}
      aria-pressed={value}
      title={option.description ?? option.name}
      onClick={() => onPick(!value)}
      className={`flex items-center gap-1.5 rounded-(--radius-sm) border px-2 py-0.5 text-xs transition ${
        value
          ? "border-accent/40 bg-accent/10 text-text-primary"
          : "border-border-subtle bg-surface text-text-secondary hover:bg-hover"
      }`}
    >
      <SlidersHorizontal size={12} className="shrink-0 text-text-tertiary" />
      <span className="max-w-[110px] truncate">{option.name}</span>
    </button>
  );
}

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

/**
 * One composer popover for provider, model and reasoning. The trigger keeps
 * the T3 shape: logo, model name, muted reasoning, chevron.
 */
export function ProviderModelPicker({ threadId }: { threadId?: string }) {
  const {
    instances,
    instance: selected,
    options,
    activeRun,
    liveOptions,
    hasLiveRun,
    liveOnSelected,
    desired,
  } = useInstanceOptions(threadId);
  const setSelectedInstanceId = useUiStore((s) => s.setSelectedInstanceId);
  const loadInstances = useUiStore((s) => s.loadInstances);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (isTauri()) void loadInstances();
  }, [loadInstances]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
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

  const modelOption = options.find(isModelOption) as
    Extract<SessionConfigOption, { type: "select" }> | undefined;
  const reasoningOptions = options.filter(isReasoningOption);
  const modelValue = modelOption
    ? String(pickerConfigValue(modelOption, activeRun, liveOptions, desired))
    : null;
  const modelLabel = modelOption
    ? (flattenSelectOptions(modelOption.options).find((item) => item.value === modelValue)?.name ??
      modelValue ??
      "Model")
    : (selected?.displayName ?? "Model");
  const reasoningLabel = reasoningOptions[0]
    ? reasoningLabelFor(
        reasoningOptions[0],
        pickerConfigValue(reasoningOptions[0], activeRun, liveOptions, desired),
      )
    : null;

  const pickConfig = (id: string, value: ConfigOptionValue) => {
    useRunsStore.getState().setDesiredConfig(threadId ?? "", id, value);
    if (threadId && isTauri() && (!hasLiveRun || liveOnSelected)) {
      runsSetConfigOption(threadId, id, value).catch((err) =>
        console.error("runs_set_config_option failed", err),
      );
    }
  };

  const switchProvider = (inst: InstanceInfo) => {
    setSelectedInstanceId(inst.id);
    if (threadId) useUiStore.getState().rememberInstance(threadId, inst.id);
    useRunsStore.getState().pruneDesiredConfigForInstance(threadId ?? "", inst.configOptions);
    // Stay open: provider, model and reasoning are one decision.
  };

  const modelRow = (item: SessionConfigSelectOption) => (
    <button
      key={item.value}
      type="button"
      onClick={() => modelOption && pickConfig(modelOption.id, item.value)}
      aria-pressed={item.value === modelValue}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-text-secondary transition hover:bg-hover"
    >
      <span className="min-w-0 flex-1 truncate">{item.name}</span>
      {item.value === modelValue && <Check size={12} className="shrink-0 text-accent" />}
    </button>
  );

  const providers = instances.filter((inst) => inst.enabled || inst.id === selected?.id);
  const ariaLabel = `${selected?.displayName ?? "No agent"} · ${modelLabel}${reasoningLabel ? ` · ${reasoningLabel}` : ""}`;

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        title="Provider, model, and reasoning"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex h-8 min-w-0 max-w-[320px] items-center gap-1.5 rounded-full border border-border-subtle bg-surface px-2.5 text-xs text-text-secondary transition hover:bg-hover"
      >
        <ProviderLogo instance={selected} />
        <span className="min-w-0 max-w-[150px] truncate text-text-primary">{modelLabel}</span>
        {reasoningLabel && (
          <span data-reasoning className="shrink-0 text-text-tertiary">
            {reasoningLabel}
          </span>
        )}
        <ChevronDown size={12} className="shrink-0 text-text-tertiary" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" data-escape-layer onClick={() => setOpen(false)} />
          <div
            data-composer-submenu
            role="dialog"
            aria-label="Provider, model, and reasoning"
            className="absolute right-0 bottom-full z-50 mb-2 max-h-[min(70vh,560px)] w-80 overflow-y-auto rounded-(--radius-md) border border-border-strong bg-surface-raised py-1 shadow-(--shadow-composer)"
          >
            <section className="border-b border-border-subtle pb-1">
              <p className="px-3 pt-2 pb-1 text-xs font-semibold tracking-wider text-text-tertiary uppercase">
                Provider
              </p>
              {providers.length === 0 ? (
                <p className="px-3 py-2 text-xs text-text-tertiary">No agent instances detected</p>
              ) : (
                providers.map((inst) => (
                  <button
                    key={inst.id}
                    type="button"
                    onClick={() => switchProvider(inst)}
                    aria-pressed={inst.id === selected?.id}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-text-secondary transition hover:bg-hover"
                  >
                    <ProviderLogo instance={inst} />
                    <span className="min-w-0 flex-1 truncate">{inst.displayName}</span>
                    <span className="shrink-0 rounded-full bg-active px-1.5 text-xs text-text-tertiary">
                      {providerLabel(inst)}
                    </span>
                    <span
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT_CLASSES[inst.status]}`}
                    />
                    {inst.id === selected?.id && (
                      <Check size={12} className="shrink-0 text-accent" />
                    )}
                  </button>
                ))
              )}
            </section>

            <section className="border-b border-border-subtle pb-1">
              <p className="px-3 pt-2 pb-1 text-xs font-semibold tracking-wider text-text-tertiary uppercase">
                Model
              </p>
              {modelOption ? (
                isGroupedSelectOptions(modelOption.options) ? (
                  modelOption.options.map((group) => (
                    <Fragment key={group.group}>
                      <p className="px-3 py-1 text-xs tracking-wider text-text-tertiary uppercase">
                        {group.name}
                      </p>
                      {group.options.map(modelRow)}
                    </Fragment>
                  ))
                ) : (
                  modelOption.options.map(modelRow)
                )
              ) : (
                <p className="px-3 py-2 text-xs text-text-tertiary">
                  Default model (provider-managed)
                </p>
              )}
            </section>

            {reasoningOptions.length > 0 && (
              <section className="border-b border-border-subtle pb-2">
                <p className="px-3 pt-2 pb-1 text-xs font-semibold tracking-wider text-text-tertiary uppercase">
                  Reasoning
                </p>
                {reasoningOptions.map((option) => {
                  const value = pickerConfigValue(option, activeRun, liveOptions, desired);
                  return (
                    <div key={option.id} className="px-3 pb-1">
                      {option.name.toLowerCase() !== "reasoning" && (
                        <p className="pt-1 pb-1 text-xs text-text-secondary">{option.name}</p>
                      )}
                      <div
                        role="radiogroup"
                        aria-label={option.name}
                        className="flex flex-wrap gap-1"
                      >
                        {option.type === "boolean"
                          ? [false, true].map((candidate) => (
                              <button
                                key={String(candidate)}
                                type="button"
                                role="radio"
                                aria-checked={value === candidate}
                                onClick={() => pickConfig(option.id, candidate)}
                                className={reasoningPillClass(value === candidate)}
                              >
                                {candidate ? "On" : "Off"}
                              </button>
                            ))
                          : flattenSelectOptions(option.options).map((item) => (
                              <button
                                key={item.value}
                                type="button"
                                role="radio"
                                aria-checked={value === item.value}
                                onClick={() => pickConfig(option.id, item.value)}
                                className={reasoningPillClass(value === item.value)}
                              >
                                {item.name}
                              </button>
                            ))}
                      </div>
                    </div>
                  );
                })}
              </section>
            )}

            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void router.navigate({ to: "/settings/providers" });
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
            >
              Manage providers…
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function reasoningLabelFor(option: SessionConfigOption, value: ConfigOptionValue): string {
  if (option.type === "boolean") return value ? "On" : "Off";
  return (
    flattenSelectOptions(option.options).find((item) => item.value === value)?.name ?? String(value)
  );
}

function reasoningPillClass(active: boolean): string {
  return `rounded-(--radius-sm) border px-2 py-0.5 text-xs transition ${
    active
      ? "border-accent/50 bg-accent/10 text-text-primary"
      : "border-border-subtle bg-surface text-text-tertiary hover:bg-hover hover:text-text-secondary"
  }`;
}

export function AgentModePicker({ threadId }: { threadId?: string }) {
  const instances = useUiStore((s) => s.instances);
  const selectedInstanceId = useUiStore((s) => s.selectedInstanceId);
  const [open, setOpen] = useState(false);
  // Escape closes the popup — without it the invisible backdrop blocks the
  // whole UI until the user clicks somewhere random.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const modes = instances.find((i) => i.id === selectedInstanceId)?.modes ?? [];
  const runs = useRunsStore((s) => (threadId ? s.runsByThread[threadId] : undefined));
  const desiredModeId = useRunsStore((s) =>
    threadId ? s.desiredModeByThread[threadId] : s.desiredModeByThread[""],
  );
  const activeRun = activeRunForThread(runs);
  const activeRunId = activeRun?.id;
  const liveModeId = useRunsStore((s) =>
    activeRunId ? s.viewsByRun[activeRunId]?.modeId : undefined,
  );
  const currentModeId = pickerModeId(activeRun, liveModeId, desiredModeId);
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
          <div className="fixed inset-0 z-40" data-escape-layer onClick={() => setOpen(false)} />
          <div
            data-composer-submenu
            className="absolute bottom-full right-0 z-50 mb-1 w-56 rounded-(--radius-md) border border-border-strong bg-surface-raised py-1 shadow-(--shadow-composer)"
          >
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
          <div
            data-composer-submenu
            className="absolute bottom-full right-0 z-50 mb-1 w-56 rounded-(--radius-md) border border-border-strong bg-surface-raised py-1 shadow-(--shadow-composer)"
          >
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
