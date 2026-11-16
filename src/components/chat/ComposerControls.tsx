import { Fragment, useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import {
  Check,
  ChevronDown,
  Layers,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Zap,
} from "lucide-react";
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
import { useSettingsStore } from "../../stores/settings";
import type { PermissionMode } from "../../stores/settings";
import { useT } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { ProviderLogo } from "./ProviderLogo";
import { FadeText } from "../ui/FadeText";

const MODES: PermissionMode[] = ["supervised", "auto_edit", "auto", "full_access"];

const PERMISSION_MODE_LABEL_KEYS: Record<PermissionMode, string> = {
  supervised: "composer.permission.supervised",
  auto_edit: "composer.permission.autoEdit",
  auto: "composer.permission.auto",
  full_access: "composer.permission.fullAccess",
};

const PERMISSION_MODE_DESCRIPTION_KEYS: Record<PermissionMode, string> = {
  supervised: "composer.permission.supervised.desc",
  auto_edit: "composer.permission.autoEdit.desc",
  auto: "composer.permission.auto.desc",
  full_access: "composer.permission.fullAccess.desc",
};

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

/**
 * Controls that parameterize the NEXT message (§6.1 composer control bar):
 * which agent runs it, in which session mode, with how much freedom. They
 * live beside the composer — not in the header — because that is where the
 * decision happens: write → pick who/how → send.
 */

/**
 * One composer popover for provider, model and reasoning. The trigger keeps
 * the T3 shape: logo, model name, muted reasoning, chevron.
 */
export function ProviderModelPicker({ threadId }: { threadId?: string }) {
  const t = useT();
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
  const [modelQuery, setModelQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    if (isTauri()) void loadInstances();
  }, [loadInstances]);

  useEffect(() => {
    if (!open) setModelQuery("");
  }, [open]);

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
      t("composer.model"))
    : (selected?.displayName ?? t("composer.model"));
  const reasoningLabel = reasoningOptions[0]
    ? reasoningLabelFor(
        reasoningOptions[0],
        pickerConfigValue(reasoningOptions[0], activeRun, liveOptions, desired),
        t,
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

  const providers = instances.filter((inst) => inst.enabled || inst.id === selected?.id);
  const ariaLabel = `${selected?.displayName ?? t("composer.noAgentShort")} · ${modelLabel}${reasoningLabel ? ` · ${reasoningLabel}` : ""}`;
  const favoriteModels = useSettingsStore((s) => s.favoriteModels);
  const toggleFavoriteModel = useSettingsStore((s) => s.toggleFavoriteModel);
  const favorites = selected ? (favoriteModels[selected.id] ?? []) : [];
  const allDisabledModels = useSettingsStore((s) => s.disabledModels);
  const allModelOrder = useSettingsStore((s) => s.modelOrder);
  const disabledModels = selected ? (allDisabledModels[selected.id] ?? []) : [];
  const modelOrder = selected ? (allModelOrder[selected.id] ?? []) : [];
  const modelItems = modelOption ? flattenSelectOptions(modelOption.options) : [];
  const orderedModels = [...modelItems].sort((a, b) => {
    const ai = modelOrder.indexOf(a.value);
    const bi = modelOrder.indexOf(b.value);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  const visibleModels = orderedModels
    .filter((item) => !disabledModels.includes(item.value))
    .filter((item) => item.name.toLowerCase().includes(modelQuery.trim().toLowerCase()));
  // Codex exposes a boolean "fast" switch; surface it as a lightning bolt
  // beside the picker instead of hiding it in an overflow menu.
  const fastOption = options.find(
    (option) =>
      option.type === "boolean" &&
      /fast/i.test(`${option.id} ${option.name} ${option.category ?? ""}`),
  );
  const fastOn = fastOption
    ? pickerConfigValue(fastOption, activeRun, liveOptions, desired) === true
    : false;
  // opencode model ids are long and meaningful; show them in full instead of
  // fading or ellipsizing the only part that distinguishes the model.
  const fullModelName = selected?.driver === "opencode" || selected?.id === "opencode";
  const extraOptions = options.filter(
    (option) =>
      option.id !== "mode" &&
      option.category !== "mode" &&
      option.id !== fastOption?.id &&
      !isModelOption(option) &&
      !isReasoningOption(option),
  );
  const modes = selected?.modes ?? [];
  const activeRunId = activeRun?.id;
  const liveModeId = useRunsStore((s) =>
    activeRunId ? s.viewsByRun[activeRunId]?.modeId : undefined,
  );
  const desiredModeId = useRunsStore((s) =>
    threadId ? s.desiredModeByThread[threadId] : s.desiredModeByThread[""],
  );
  const currentModeId = pickerModeId(activeRun, liveModeId, desiredModeId);
  const modeValue = modes.some((mode) => mode.id === currentModeId)
    ? (currentModeId ?? "")
    : (modes[0]?.id ?? "");
  const hasExtraOptions = extraOptions.length > 0 || modes.length > 0;
  const pickMode = (modeId: string) => {
    useRunsStore.getState().setDesiredMode(threadId ?? "", modeId);
    if (threadId && isTauri() && (!hasLiveRun || liveOnSelected)) {
      runsSetMode(threadId, modeId).catch((err) => console.error("runs_set_mode failed", err));
    }
  };

  return (
    <div ref={rootRef} className="relative min-w-0">
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          title={t("composer.providerModelReasoning")}
          aria-label={ariaLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className={`flex h-8 min-w-0 items-center gap-1.5 rounded-full px-2.5 text-xs text-text-secondary transition hover:bg-hover ${
            fullModelName ? "" : "max-w-[320px]"
          }`}
        >
          <ProviderLogo instance={selected} />
          {fullModelName ? (
            <span className="shrink-0 whitespace-nowrap text-text-primary">{modelLabel}</span>
          ) : (
            <FadeText text={modelLabel} className="max-w-[150px] text-text-primary" />
          )}
          {reasoningLabel && (
            <span data-reasoning className="shrink-0 text-text-tertiary">
              {reasoningLabel}
            </span>
          )}
          <ChevronDown size={12} className="shrink-0 text-text-tertiary" />
        </button>
        {fastOption && (
          <button
            type="button"
            aria-pressed={fastOn}
            aria-label={t("composer.fastMode")}
            title={t("composer.fastMode")}
            onClick={() => pickConfig(fastOption.id, !fastOn)}
            className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition hover:bg-hover ${
              fastOn ? "text-warning" : "text-text-tertiary"
            }`}
          >
            <Zap size={13} fill={fastOn ? "currentColor" : "none"} />
          </button>
        )}
      </div>

      {open && (
        <>
          <div className="fixed inset-0 z-40" data-escape-layer onClick={() => setOpen(false)} />
          <div
            data-composer-submenu
            role="dialog"
            aria-label={t("composer.providerModelReasoning")}
            onKeyDown={(event) => {
              if (!modelOption || !(event.ctrlKey || event.metaKey)) return;
              const index = Number(event.key) - 1;
              if (!Number.isInteger(index) || index < 0 || index >= visibleModels.length) return;
              event.preventDefault();
              pickConfig(modelOption.id, visibleModels[index].value);
            }}
            style={{ maxHeight: "min(380px, calc(100dvh - 220px))" }}
            className="absolute right-0 bottom-full z-50 mb-2 w-80 overflow-y-auto rounded-(--radius-md) border border-border-strong bg-surface-raised shadow-(--shadow-composer)"
          >
            <div className="border-b border-border-subtle px-2 py-1.5">
              <p className="sr-only">{t("composer.provider")}</p>
              <div className="flex items-center gap-1">
                {providers.length === 0 ? (
                  <p className="px-1 py-1 text-xs text-text-tertiary">
                    {t("composer.noInstances")}
                  </p>
                ) : (
                  providers.map((inst) => (
                    <button
                      key={inst.id}
                      type="button"
                      title={inst.displayName}
                      aria-label={inst.displayName}
                      aria-pressed={inst.id === selected?.id}
                      onClick={() => switchProvider(inst)}
                      className={`flex h-7 w-7 items-center justify-center rounded-md transition ${
                        inst.id === selected?.id
                          ? "bg-active ring-1 ring-accent/50"
                          : "hover:bg-hover"
                      }`}
                    >
                      <ProviderLogo instance={inst} className="h-4 w-4" />
                    </button>
                  ))
                )}
                <span className="flex-1" />
                <button
                  type="button"
                  aria-label={t("composer.addProvider")}
                  title={t("composer.addProvider")}
                  onClick={() => {
                    setOpen(false);
                    void router.navigate({ to: "/settings/providers" });
                  }}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
                >
                  <Plus size={14} />
                </button>
              </div>
            </div>

            {modelOption && modelItems.length > 0 && (
              <div className="relative border-b border-border-subtle px-2 py-1.5">
                <p className="sr-only">{t("composer.model")}</p>
                <Search
                  size={12}
                  className="pointer-events-none absolute top-1/2 left-4 -translate-y-1/2 text-text-tertiary"
                />
                <input
                  value={modelQuery}
                  onChange={(event) => setModelQuery(event.target.value)}
                  placeholder={t("composer.searchModels")}
                  aria-label={t("composer.searchModelsLabel")}
                  className="h-7 w-full rounded-(--radius-sm) border border-border-subtle bg-surface pr-2 pl-6 text-xs text-text-primary placeholder:text-text-tertiary focus:border-border-strong focus:outline-none"
                />
              </div>
            )}

            <div className="py-1">
              {modelOption ? (
                visibleModels.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-text-tertiary">
                    {t("composer.noModelsMatch")}
                  </p>
                ) : (
                  visibleModels.map((item, index) => {
                    const active = item.value === modelValue;
                    const favorite = favorites.includes(item.value);
                    return (
                      <div
                        key={item.value}
                        className="group flex items-center gap-1 px-2 transition hover:bg-hover"
                      >
                        <button
                          type="button"
                          onClick={() => modelOption && pickConfig(modelOption.id, item.value)}
                          aria-pressed={active}
                          className="flex min-w-0 flex-1 items-center gap-2 px-1 py-1.5 text-left text-sm text-text-secondary"
                        >
                          <span className="min-w-0 flex-1 truncate">{item.name}</span>
                          {active && <Check size={12} className="shrink-0 text-accent" />}
                        </button>
                        {index < 9 && (
                          <span className="shrink-0 rounded-(--radius-sm) bg-active px-1.5 py-0.5 text-xs text-text-tertiary">
                            Ctrl {index + 1}
                          </span>
                        )}
                        <button
                          type="button"
                          aria-label={
                            favorite ? t("composer.unfavoriteModel") : t("composer.favoriteModel")
                          }
                          title={
                            favorite
                              ? t("composer.unfavoriteModelTitle", { name: item.name })
                              : t("composer.favoriteModelTitle", { name: item.name })
                          }
                          onClick={() => selected && toggleFavoriteModel(selected.id, item.value)}
                          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-(--radius-sm) transition hover:bg-active ${
                            favorite ? "text-warning" : "text-text-tertiary"
                          }`}
                        >
                          <Star size={11} fill={favorite ? "currentColor" : "none"} />
                        </button>
                      </div>
                    );
                  })
                )
              ) : (
                <p className="px-3 py-2 text-xs text-text-tertiary">
                  {t("composer.defaultModelManaged")}
                </p>
              )}
            </div>

            {reasoningOptions.length > 0 && (
              <section className="border-t border-border-subtle px-3 py-2">
                <p className="sr-only">{t("composer.reasoning")}</p>
                {reasoningOptions.map((option) => {
                  const value = pickerConfigValue(option, activeRun, liveOptions, desired);
                  const values =
                    option.type === "boolean"
                      ? [
                          { value: false as ConfigOptionValue, name: t("composer.off") },
                          { value: true as ConfigOptionValue, name: t("composer.on") },
                        ]
                      : flattenSelectOptions(option.options).map((item) => ({
                          value: item.value as ConfigOptionValue,
                          name: item.name,
                        }));
                  return (
                    <div key={option.id} className="pb-1">
                      <div className="flex items-center justify-between pb-2">
                        <span className="text-xs text-text-tertiary">
                          {t("composer.selectEffort")}
                        </span>
                      </div>
                      <div
                        role="radiogroup"
                        aria-label={option.name}
                        className="relative flex items-start justify-between px-1"
                      >
                        <span
                          aria-hidden
                          className="absolute top-1.5 right-2 left-2 h-px bg-border-strong"
                        />
                        {values.map((candidate) => (
                          <span
                            key={String(candidate.value)}
                            className="relative z-10 flex flex-col items-center gap-1"
                          >
                            <button
                              type="button"
                              role="radio"
                              aria-label={candidate.name}
                              aria-checked={value === candidate.value}
                              title={candidate.name}
                              onClick={() => pickConfig(option.id, candidate.value)}
                              className={`h-3 w-3 rounded-full border transition ${
                                value === candidate.value
                                  ? "border-accent bg-accent"
                                  : "border-border-strong bg-surface hover:bg-hover"
                              }`}
                            />
                            <span className="text-xs text-text-tertiary">{candidate.name}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </section>
            )}

            {hasExtraOptions && (
              <section className="space-y-2 border-t border-border-subtle px-3 py-2">
                <p className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">
                  {t("composer.options")}
                </p>
                {modes.length > 0 && (
                  <label className="flex items-center justify-between gap-3">
                    <span className="text-xs text-text-secondary">{t("composer.sessionMode")}</span>
                    <select
                      aria-label={t("composer.sessionMode")}
                      value={modeValue}
                      onChange={(event) => pickMode(event.target.value)}
                      className="h-6 max-w-[150px] rounded-(--radius-sm) border border-border-subtle bg-surface px-1.5 text-xs text-text-secondary focus:border-border-strong focus:outline-none"
                    >
                      {modes.map((mode) => (
                        <option key={mode.id} value={mode.id}>
                          {mode.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {extraOptions.map((option) => {
                  const value = pickerConfigValue(option, activeRun, liveOptions, desired);
                  if (option.type === "boolean") {
                    const on = value === true;
                    return (
                      <div key={option.id} className="flex items-center justify-between gap-3">
                        <span className="text-xs text-text-secondary">{option.name}</span>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={on}
                          aria-label={option.name}
                          onClick={() => pickConfig(option.id, !on)}
                          className={`relative h-4 w-7 shrink-0 rounded-full transition ${
                            on ? "bg-accent" : "bg-active"
                          }`}
                        >
                          <span
                            className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
                              on ? "left-3.5" : "left-0.5"
                            }`}
                          />
                        </button>
                      </div>
                    );
                  }
                  return (
                    <label key={option.id} className="flex items-center justify-between gap-3">
                      <span className="text-xs text-text-secondary">{option.name}</span>
                      <select
                        aria-label={option.name}
                        value={String(value)}
                        onChange={(event) => pickConfig(option.id, event.target.value)}
                        className="h-6 max-w-[150px] rounded-(--radius-sm) border border-border-subtle bg-surface px-1.5 text-xs text-text-secondary focus:border-border-strong focus:outline-none"
                      >
                        {flattenSelectOptions(option.options).map((item) => (
                          <option key={item.value} value={item.value}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </label>
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
              className="flex w-full items-center gap-2 border-t border-border-subtle px-3 py-2 text-left text-xs text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
            >
              {t("composer.manageProviders")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function reasoningLabelFor(
  option: SessionConfigOption,
  value: ConfigOptionValue,
  t: (key: string) => string,
): string {
  if (option.type === "boolean") return value ? t("composer.on") : t("composer.off");
  return (
    flattenSelectOptions(option.options).find((item) => item.value === value)?.name ?? String(value)
  );
}

export function AgentModePicker({ threadId }: { threadId?: string }) {
  const t = useT();
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
        title={t("composer.sessionModeTitle")}
        onClick={() => setOpen((o) => !o)}
        className="flex min-w-0 items-center gap-1.5 rounded-(--radius-sm) border border-border-subtle bg-surface px-2 py-0.5 text-xs text-text-secondary transition hover:bg-hover"
      >
        <Layers size={12} className="shrink-0 text-text-tertiary" />
        <span className="max-w-[120px] truncate">
          {current?.name ?? current?.id ?? t("composer.modeFallback")}
        </span>
        <ChevronDown size={12} className="shrink-0 text-text-tertiary" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" data-escape-layer onClick={() => setOpen(false)} />
          <div
            data-composer-submenu
            className="absolute bottom-full right-0 z-50 mb-1 w-56 rounded-(--radius-md) border border-border-strong bg-surface-raised py-1 shadow-(--shadow-composer)"
          >
            <p className="px-3 py-1.5 text-xs text-text-tertiary">
              {t("composer.agentSessionModes")}
            </p>
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
  const t = useT();
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

  const fullAccess = permissionMode === "full_access";
  return (
    <div className="relative">
      <button
        title={t("composer.permissionModeTitle")}
        aria-label={t("composer.permission")}
        onClick={() => setOpen((o) => !o)}
        className={`flex min-w-0 items-center gap-1.5 rounded-(--radius-sm) px-1.5 py-0.5 text-xs transition hover:bg-hover ${
          fullAccess ? "text-warning" : "text-text-secondary"
        }`}
      >
        <ShieldCheck
          size={12}
          className={`shrink-0 ${fullAccess ? "text-warning" : "text-text-tertiary"}`}
        />
        <span className="max-w-[140px] truncate">
          {t(PERMISSION_MODE_LABEL_KEYS[permissionMode])}
        </span>
        <ChevronDown
          size={12}
          className={`shrink-0 ${fullAccess ? "text-warning" : "text-text-tertiary"}`}
        />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" data-escape-layer onClick={() => setOpen(false)} />
          <div
            data-composer-submenu
            className="absolute bottom-full right-0 z-50 mb-1 w-56 rounded-(--radius-md) border border-border-strong bg-surface-raised py-1 shadow-(--shadow-composer)"
          >
            <p className="px-3 py-1.5 text-xs text-text-tertiary">
              {t("composer.permissionMenuTitle")}
            </p>
            {MODES.map((mode) => (
              <button
                key={mode}
                onClick={() => pick(mode)}
                className={`flex w-full items-start gap-2 px-3 py-1.5 text-left transition hover:bg-hover ${
                  mode === permissionMode
                    ? mode === "full_access"
                      ? "bg-warning/10"
                      : "bg-active"
                    : ""
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span
                    className={`flex items-center gap-2 text-sm ${
                      mode === permissionMode
                        ? mode === "full_access"
                          ? "text-warning"
                          : "text-text-primary"
                        : "text-text-secondary"
                    }`}
                  >
                    {t(PERMISSION_MODE_LABEL_KEYS[mode])}
                    {mode === permissionMode && (
                      <Check
                        size={12}
                        className={`shrink-0 ${
                          mode === "full_access" ? "text-warning" : "text-accent"
                        }`}
                      />
                    )}
                  </span>
                  <span className="mt-0.5 block text-xs leading-snug text-text-tertiary">
                    {t(PERMISSION_MODE_DESCRIPTION_KEYS[mode])}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
