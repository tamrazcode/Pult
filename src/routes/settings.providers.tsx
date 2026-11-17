import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  Bot,
  Plus,
  RefreshCw,
  Trash2,
  X,
  ChevronDown,
  ChevronRight,
  Star,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import {
  providersAuthenticate,
  providersConfigStatus,
  providersDetectInstalled,
  providersInstancesList,
  providersInstancesSave,
  providersLogin,
  providersPreflight,
} from "../lib/ipc";
import { isTauri } from "../lib/tauri";
import { preflightInstances, readCachedChecks } from "../lib/providerChecks";
import type { CachedCheck } from "../lib/providerChecks";
import { useUiStore } from "../stores/ui";
import { useSettingsStore } from "../stores/settings";
import { localizeIpcError, translate, useT } from "../lib/i18n";
import { AddProviderDialog } from "../components/settings/AddProviderDialog";
import { SignInActions } from "../components/settings/SignInActions";
import { ProviderLogo } from "../components/chat/ProviderLogo";
import { flattenSelectOptions, isModelOption } from "../components/chat/ComposerControls";
import type { DetectedAgent, InstanceInfo, InstanceSpec, PreflightReport } from "../lib/types";

export const Route = createFileRoute("/settings/providers")({ component: ProvidersSettings });

interface DraftRuntime {
  command: string;
  args: string;
}

function fromRuntime(draft: DraftRuntime): { command: string; args: string[] } {
  return {
    command: draft.command.trim(),
    args: draft.args
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean),
  };
}

/** The full spec list, rebuilt from projections + one edited field. */
function specList(infos: InstanceInfo[], id: string, patch: Partial<InstanceSpec>): InstanceSpec[] {
  return infos.map((i) => {
    const spec: InstanceSpec = {
      id: i.id,
      displayName: i.displayName,
      driver: i.driver,
      command: i.command,
      args: i.args,
      env: i.env,
      secretEnvKeys: (i.secretEnv ?? []).map((secret) => secret.key),
      homePath: i.homePath ?? null,
      shadowHomePath: i.shadowHomePath ?? null,
      enabled: i.enabled,
    };
    return i.id === id ? { ...spec, ...patch } : spec;
  });
}

interface EnvRow {
  key: string;
  value: string;
  secret: boolean;
  hasValue?: boolean;
  masked?: string | null;
}

function relativeTime(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return translate("settings.providers.justNow");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return translate("settings.providers.minutesAgo", { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return translate("settings.providers.hoursAgo", { count: hours });
  return translate("settings.providers.daysAgo", { count: Math.round(hours / 24) });
}

function capsLabel(loadSession: boolean, promptImage: boolean): string {
  return [
    loadSession ? translate("settings.providers.capResume") : null,
    promptImage ? translate("settings.providers.capImages") : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function statusLine(
  info: InstanceInfo,
  check: CachedCheck | undefined,
  checking: boolean,
  authenticating = false,
  authAttempted = false,
): { text: string; tone: "ok" | "warn" | "muted" | "bad" } {
  if (checking) return { text: translate("settings.providers.checking"), tone: "muted" };
  if (authenticating) return { text: translate("settings.providers.signingIn"), tone: "muted" };
  if (!info.enabled) return { text: translate("settings.providers.disabled"), tone: "muted" };
  // A fresh report outranks the cached status: Re-check must clear the badge.
  const report = check?.report;
  if (report?.authRequired ?? info.status === "needs_auth") {
    return {
      text: translate(
        authAttempted ? "settings.providers.stillNeedsSignIn" : "settings.providers.needsSignIn",
      ),
      tone: "warn",
    };
  }
  if (info.status === "crashed") {
    return { text: translate("settings.providers.crashed"), tone: "bad" };
  }
  if (report && check?.lastError) {
    // The last probe failed but a previous report still describes the agent.
    return {
      text: translate("settings.providers.checkFailed", { when: relativeTime(check.at) }),
      tone: "warn",
    };
  }
  if (report) {
    const caps = capsLabel(report.loadSession, report.promptImage);
    const checked = check?.lastAttemptAt ?? check?.at;
    const text = [
      translate("settings.providers.connected"),
      checked ? translate("settings.providers.checked", { when: relativeTime(checked) }) : null,
      report.agentVersion,
      caps || null,
    ]
      .filter(Boolean)
      .join(" · ");
    return { text, tone: "ok" };
  }
  if (
    info.loadSession ||
    info.modes.length > 0 ||
    info.promptImage ||
    info.configOptions.length > 0
  ) {
    const caps = capsLabel(info.loadSession, info.promptImage);
    return {
      text: [translate("settings.providers.connected"), caps || null].filter(Boolean).join(" · "),
      tone: "ok",
    };
  }
  return { text: translate("settings.providers.notChecked"), tone: "muted" };
}

/** A fresh report wins over the cached status (heading + actions agree). */
export function shouldShowSignIn(info: InstanceInfo, report: PreflightReport | undefined): boolean {
  return report ? report.authRequired : info.status === "needs_auth";
}

const TONE_CLASSES: Record<"ok" | "warn" | "muted" | "bad", string> = {
  ok: "text-success",
  warn: "text-warning",
  muted: "text-text-tertiary",
  bad: "text-danger",
};

function ProvidersSettings() {
  const t = useT();
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [detected, setDetected] = useState<DetectedAgent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reports, setReports] = useState<Record<string, CachedCheck>>({});
  const [configError, setConfigError] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState(false);
  const [runtimeDraft, setRuntimeDraft] = useState<DraftRuntime | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [homeDraft, setHomeDraft] = useState<{ home: string; shadow: string } | null>(null);
  const [runtimeOpen, setRuntimeOpen] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState("");
  const [envDraft, setEnvDraft] = useState<EnvRow[]>([]);
  const favoriteModels = useSettingsStore((s) => s.favoriteModels);
  const disabledModels = useSettingsStore((s) => s.disabledModels);
  const modelOrder = useSettingsStore((s) => s.modelOrder);
  const modelsDisabledAll = useSettingsStore((s) => s.modelsDisabledAll);
  const toggleFavoriteModel = useSettingsStore((s) => s.toggleFavoriteModel);
  const toggleModelEnabled = useSettingsStore((s) => s.toggleModelEnabled);
  const disableAllModels = useSettingsStore((s) => s.disableAllModels);
  const setModelOrder = useSettingsStore((s) => s.setModelOrder);
  const [authenticating, setAuthenticating] = useState<Record<string, boolean>>({});
  const [authAttempted, setAuthAttempted] = useState<Record<string, boolean>>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  const reload = async () => {
    if (!isTauri()) {
      setLoaded(true);
      return;
    }
    const list = await providersInstancesList();
    setInstances(list);
    setDetected(await providersDetectInstalled());
    // The composer's agent picker reads the ui store — keep it in sync.
    await useUiStore.getState().loadInstances();
    setLoaded(true);
    setSelectedId((sel) =>
      sel && list.some((i) => i.id === sel)
        ? sel
        : list.some((i) => i.id === useUiStore.getState().selectedInstanceId)
          ? useUiStore.getState().selectedInstanceId
          : (list[0]?.id ?? null),
    );
  };

  useEffect(() => {
    const cached = readCachedChecks();
    if (Object.keys(cached).length > 0) setReports(cached);
    if (!isTauri()) {
      setLoaded(true);
      return;
    }
    void providersConfigStatus()
      .then(setConfigError)
      .catch(() => {});
    void (async () => {
      try {
        const list = await providersInstancesList();
        setInstances(list);
        setDetected(await providersDetectInstalled());
        await useUiStore.getState().loadInstances();
        setLoaded(true);
        setSelectedId((sel) =>
          sel && list.some((i) => i.id === sel) ? sel : (list[0]?.id ?? null),
        );
        const enabled = list.filter((instance) => instance.enabled);
        if (enabled.length > 0) {
          setChecking(Object.fromEntries(enabled.map((instance) => [instance.id, true])));
          const results = await preflightInstances(list);
          setReports(results);
          setChecking({});
          const refreshed = await providersInstancesList();
          setInstances(refreshed);
        }
      } catch (err) {
        setSaveError(localizeIpcError(err));
        setLoaded(true);
      }
    })();
  }, []);

  const selected = useMemo(
    () => instances.find((i) => i.id === selectedId) ?? null,
    [instances, selectedId],
  );
  useEffect(() => {
    setRuntimeDraft(null);
    setNameDraft(null);
    setHomeDraft(null);
  }, [selectedId]);
  useEffect(() => {
    setEnvDraft(
      selected
        ? [
            ...Object.entries(selected.env).map(([key, value]) => ({
              key,
              value,
              secret: false,
            })),
            ...(selected.secretEnv ?? []).map((secret) => ({
              key: secret.key,
              value: "",
              secret: true,
              hasValue: secret.hasValue,
              masked: secret.masked,
            })),
          ]
        : [],
    );
    setApiKeyDraft("");
  }, [selected]);

  const saveEnv = () => {
    if (!selected) return;
    const env: Record<string, string> = {};
    const secretEnvKeys: string[] = [];
    for (const row of envDraft) {
      const key = row.key.trim();
      if (!key) continue;
      if (row.secret) {
        secretEnvKeys.push(key);
        // Empty means "keep the stored value"; only a typed value is sent.
        if (row.value) env[key] = row.value;
      } else {
        env[key] = row.value;
      }
    }
    setSaveError(null);
    void saveSpecs(specList(instances, selected.id, { env, secretEnvKeys })).catch((err) =>
      setSaveError(localizeIpcError(err)),
    );
  };

  const isClaude = selected
    ? selected.id.startsWith("claude") || /claude/i.test(selected.command)
    : false;

  const saveClaudeKey = async () => {
    if (!selected) return;
    const key = apiKeyDraft.trim();
    if (!key) {
      setSaveError("Enter an Anthropic API key.");
      return;
    }
    setSaveError(null);
    try {
      await saveSpecs(
        specList(instances, selected.id, {
          env: { ...selected.env, ANTHROPIC_API_KEY: key },
          secretEnvKeys: Array.from(
            new Set([
              ...(selected.secretEnv ?? []).map((secret) => secret.key),
              "ANTHROPIC_API_KEY",
            ]),
          ),
        }),
      );
      await check(selected.id);
    } catch (err) {
      setSaveError(localizeIpcError(err));
    }
  };

  const startClaudeLogin = () => {
    if (!selected) return;
    void providersLogin(selected.id).catch((err) => setSaveError(localizeIpcError(err)));
  };

  const modelOption = selected?.configOptions.find(isModelOption) as
    Extract<InstanceInfo["configOptions"][number], { type: "select" }> | undefined;
  const modelItems = modelOption ? flattenSelectOptions(modelOption.options) : [];
  const selectedOrder = selected ? (modelOrder[selected.id] ?? []) : [];
  const orderedModels = [...modelItems].sort((a, b) => {
    const ai = selectedOrder.indexOf(a.value);
    const bi = selectedOrder.indexOf(b.value);
    if (ai === -1 && bi === -1) return 0;
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  const disabled = selected ? (disabledModels[selected.id] ?? []) : [];
  const favorites = selected ? (favoriteModels[selected.id] ?? []) : [];
  const disabledAllSelected = selected ? (modelsDisabledAll[selected.id] ?? false) : false;
  const moveModel = (modelId: string, direction: -1 | 1) => {
    if (!selected) return;
    const ids = orderedModels.map((model) => model.value);
    const index = ids.indexOf(modelId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    setModelOrder(selected.id, ids);
  };

  const saveSpecs = async (specs: InstanceSpec[]) => {
    await providersInstancesSave(specs);
    await reload();
  };

  const toggle = (info: InstanceInfo) => {
    setSaveError(null);
    void saveSpecs(specList(instances, info.id, { enabled: !info.enabled })).catch((err) =>
      setSaveError(localizeIpcError(err)),
    );
  };

  const check = async (id: string) => {
    setChecking((m) => ({ ...m, [id]: true }));
    try {
      const report = await providersPreflight(id);
      const now = Date.now();
      setReports((m) => ({
        ...m,
        [id]: { report, at: now, lastAttemptAt: now, lastError: null },
      }));
      setCheckError((m) => {
        const { [id]: _dropped, ...rest } = m;
        return rest;
      });
      await reload();
    } catch (err) {
      setReports((m) => {
        const { [id]: _dropped, ...rest } = m;
        return rest;
      });
      setCheckError((m) => ({ ...m, [id]: localizeIpcError(err) }));
    } finally {
      setChecking((m) => ({ ...m, [id]: false }));
    }
  };

  const [checkError, setCheckError] = useState<Record<string, string>>({});

  const signIn = async (id: string, methodId: string) => {
    setAuthenticating((m) => ({ ...m, [id]: true }));
    try {
      const report = await providersAuthenticate(id, methodId);
      setAuthAttempted((m) => ({ ...m, [id]: report.authRequired }));
      const now = Date.now();
      setReports((m) => ({
        ...m,
        [id]: { report, at: now, lastAttemptAt: now, lastError: null },
      }));
      setCheckError((m) => {
        const { [id]: _dropped, ...rest } = m;
        return rest;
      });
      await reload();
    } catch (err) {
      setCheckError((m) => ({ ...m, [id]: localizeIpcError(err) }));
    } finally {
      setAuthenticating((m) => ({ ...m, [id]: false }));
    }
  };

  const remove = async (id: string) => {
    setSaveError(null);
    try {
      await providersInstancesSave(
        specList(
          instances.filter((i) => i.id !== id),
          id,
          {},
        ),
      );
      await reload();
    } catch (err) {
      setSaveError(localizeIpcError(err));
    }
  };

  const saveName = () => {
    if (!selected || nameDraft === null || !nameDraft.trim()) return;
    setSaveError(null);
    void saveSpecs(specList(instances, selected.id, { displayName: nameDraft.trim() }))
      .then(() => setNameDraft(null))
      .catch((err) => setSaveError(localizeIpcError(err)));
  };

  const saveRuntime = () => {
    if (!selected || !runtimeDraft) return;
    const { command, args } = fromRuntime(runtimeDraft);
    if (!command) return;
    setSaveError(null);
    void saveSpecs(specList(instances, selected.id, { command, args }))
      .then(() => setRuntimeDraft(null))
      .catch((err) => setSaveError(localizeIpcError(err)));
  };

  const saveHome = () => {
    if (!selected || !homeDraft) return;
    setSaveError(null);
    void saveSpecs(
      specList(instances, selected.id, {
        homePath: homeDraft.home.trim() || null,
        shadowHomePath: homeDraft.shadow.trim() || null,
      }),
    )
      .then(() => setHomeDraft(null))
      .catch((err) => setSaveError(localizeIpcError(err)));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {configError && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-danger/40 bg-diff-del-bg px-4 py-2 text-xs text-danger"
        >
          <span className="min-w-0 flex-1">
            {t("settings.providers.configError", { error: configError })}
          </span>
          <button
            type="button"
            onClick={() => setConfigError(null)}
            className="shrink-0 text-text-tertiary transition hover:text-text-secondary"
          >
            {t("common.dismiss")}
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {/* Provider list (T3-style left column) */}
        <div
          className={`${
            instances.length === 0 ? "hidden min-[1120px]:flex" : detailOpen ? "hidden" : "flex"
          } w-full shrink-0 flex-col border-r border-border-subtle min-[1120px]:flex min-[1120px]:w-64`}
        >
          <div className="flex items-center justify-between px-3 py-2.5">
            <p className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">
              {t("settings.providers.title")}
            </p>
            <button
              onClick={() => setAdding((a) => !a)}
              title={t("settings.providers.add")}
              aria-label={t("settings.providers.add")}
              className="flex h-6 w-6 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
            >
              <Plus size={14} />
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
            {loaded && instances.length === 0 && (
              <p className="px-2 py-2 text-sm text-text-tertiary">
                {t("settings.providers.noneConfigured")}
              </p>
            )}
            {instances.map((info) => {
              const st = statusLine(info, reports[info.id], checking[info.id]);
              return (
                <div
                  key={info.id}
                  className={`w-full rounded-(--radius-md) transition ${
                    selectedId === info.id ? "bg-active" : "hover:bg-hover"
                  }`}
                >
                  <div className="flex items-start gap-2 px-3 py-2">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedId(info.id);
                        setDetailOpen(true);
                      }}
                      aria-pressed={selectedId === info.id}
                      className="flex min-w-0 flex-1 items-start gap-2 text-left"
                    >
                      <ProviderLogo instance={info} className="mt-0.5 h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span
                          className={`block truncate text-sm ${
                            info.enabled ? "text-text-primary" : "text-text-tertiary"
                          }`}
                        >
                          {info.displayName}
                        </span>
                        <span className={`mt-0.5 block truncate text-xs ${TONE_CLASSES[st.tone]}`}>
                          {st.text}
                        </span>
                      </span>
                    </button>
                    <Toggle
                      on={info.enabled}
                      label={`${t(info.enabled ? "common.disable" : "common.enable")} ${info.displayName}`}
                      onClick={() => toggle(info)}
                    />
                  </div>
                </div>
              );
            })}
            {loaded && (
              <button
                onClick={() => setAdding((a) => !a)}
                className="mt-1 flex w-full items-center gap-2 rounded-(--radius-md) px-3 py-2 text-sm text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
              >
                <Plus size={14} /> {t("settings.providers.add")}
              </button>
            )}
          </div>
        </div>

        {/* Detail pane (T3-style right column) */}
        <div
          className={`${
            detailOpen || instances.length === 0 ? "block" : "hidden"
          } relative min-w-0 flex-1 overflow-y-auto p-5 min-[1120px]:block`}
        >
          {selected && (
            <button
              type="button"
              aria-label={t("settings.providers.back")}
              onClick={() => setDetailOpen(false)}
              className="mb-3 flex items-center gap-1 text-xs text-text-tertiary transition hover:text-text-secondary min-[1120px]:hidden"
            >
              ← {t("settings.providers.title")}
            </button>
          )}
          {!loaded && (
            <p className="text-sm text-text-tertiary">{t("settings.providers.loading")}</p>
          )}
          {saveError && (
            <p className="mb-3 rounded-(--radius-md) border border-danger/40 bg-diff-del-bg px-3 py-2 text-sm text-danger">
              {saveError}
            </p>
          )}
          {!selected && loaded && instances.length === 0 && (
            <div className="flex h-full min-h-64 flex-col items-center justify-center gap-2 text-center">
              <Bot size={24} className="text-text-tertiary" aria-hidden />
              <p className="text-sm font-medium text-text-primary">
                {t("settings.providers.emptyTitle")}
              </p>
              <p className="max-w-xs text-xs text-text-tertiary">
                {t("settings.providers.emptyBody")}
              </p>
              <button
                onClick={() => setAdding(true)}
                className="mt-1 flex h-8 items-center gap-1.5 rounded-(--radius-sm) bg-accent px-3 text-xs font-medium text-accent-fg transition hover:brightness-110"
              >
                <Plus size={13} /> {t("settings.providers.add")}
              </button>
            </div>
          )}
          {!selected && loaded && instances.length > 0 && (
            <p className="text-sm text-text-tertiary">{t("settings.providers.pickLeft")}</p>
          )}
          {selected && (
            <div className="max-w-xl">
              <div className="flex items-center gap-2.5">
                <ProviderLogo instance={selected} className="h-5 w-5 shrink-0" />
                <h2 className="min-w-0 truncate text-lg font-medium text-text-primary">
                  {selected.displayName}
                </h2>
              </div>
              {(() => {
                const st = statusLine(
                  selected,
                  reports[selected.id],
                  checking[selected.id],
                  authenticating[selected.id],
                  authAttempted[selected.id],
                );
                const err = checkError[selected.id];
                const needsAuth = shouldShowSignIn(selected, reports[selected.id]?.report);
                return (
                  <div className="mt-3 rounded-(--radius-md) border border-border-subtle bg-surface p-3">
                    <p className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">
                      {t("settings.providers.status")}
                    </p>
                    {err ? (
                      <p className="mt-1 text-sm text-danger" title={err}>
                        {err}
                      </p>
                    ) : (
                      <>
                        <p className={`mt-1 text-sm ${TONE_CLASSES[st.tone]}`}>{st.text}</p>
                      </>
                    )}
                    <button
                      onClick={() => void check(selected.id)}
                      disabled={checking[selected.id] || !selected.enabled}
                      className="mt-2 flex items-center gap-1.5 rounded-(--radius-sm) border border-border-subtle px-2.5 py-1 text-xs text-text-secondary transition hover:bg-hover disabled:opacity-40"
                    >
                      <RefreshCw
                        size={12}
                        className={checking[selected.id] ? "animate-spin" : ""}
                      />
                      {t("settings.providers.checkConnection")}
                    </button>
                    {needsAuth && selected.enabled && (
                      <SignInActions
                        launch={{
                          command: selected.command,
                          args: selected.args,
                          env: selected.env,
                        }}
                        authMethods={
                          reports[selected.id]?.report.authMethods ?? selected.authMethods ?? []
                        }
                        authHint={reports[selected.id]?.report.authHint ?? selected.authHint}
                        signingIn={authenticating[selected.id] === true}
                        authAttempted={authAttempted[selected.id] === true}
                        onSignIn={(methodId) => void signIn(selected.id, methodId)}
                        onRecheck={() => void check(selected.id)}
                      />
                    )}
                  </div>
                );
              })()}

              {isClaude && (
                <div className="mt-3 rounded-(--radius-md) border border-border-subtle bg-surface p-3">
                  <p className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">
                    Claude account
                  </p>
                  <p className="mt-1 text-xs text-text-tertiary">
                    Claude Code needs a Claude Pro/Max/Ultra plan or an Anthropic API key.
                  </p>
                  <div className="mt-2 flex gap-2">
                    <input
                      type="password"
                      value={apiKeyDraft}
                      onChange={(event) => setApiKeyDraft(event.target.value)}
                      placeholder={
                        selected?.secretEnv?.find((secret) => secret.key === "ANTHROPIC_API_KEY")
                          ?.masked ?? "ANTHROPIC_API_KEY"
                      }
                      className="h-8 min-w-0 flex-1 rounded-(--radius-sm) border border-border-subtle bg-(--input) px-2 font-mono text-sm text-text-primary focus:border-border-strong focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => void saveClaudeKey()}
                      className="flex h-8 shrink-0 items-center rounded-(--radius-sm) bg-accent px-3 text-xs font-medium text-accent-fg transition hover:brightness-110"
                    >
                      Save &amp; connect
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={startClaudeLogin}
                    className="mt-2 flex h-8 items-center gap-1.5 rounded-(--radius-sm) border border-border-strong px-3 text-xs text-text-secondary transition hover:bg-hover"
                  >
                    Sign in with Claude
                  </button>
                </div>
              )}

              <p className="mt-5 text-xs font-semibold tracking-wider text-text-tertiary uppercase">
                {t("settings.providers.displayName")}
              </p>
              <div className="mt-1.5 flex gap-2">
                <input
                  value={nameDraft ?? selected.displayName}
                  onChange={(e) => setNameDraft(e.target.value)}
                  className="h-8 min-w-0 flex-1 rounded-(--radius-sm) border border-border-subtle bg-(--input) px-2 text-sm text-text-primary focus:outline-none"
                />
                {nameDraft !== null && nameDraft !== selected.displayName && (
                  <button
                    onClick={saveName}
                    className="flex h-8 items-center rounded-(--radius-sm) bg-accent px-3 text-xs font-medium text-accent-fg transition hover:brightness-110"
                  >
                    {t("common.save")}
                  </button>
                )}
              </div>

              <p className="mt-2 text-xs leading-snug text-text-tertiary">
                Native subagent steps appear only when the provider exposes them in ACP
                <span className="font-mono"> _meta</span>. Otherwise Pult shows ordinary tool calls
                and never invents progress.
              </p>

              <button
                type="button"
                onClick={() => setRuntimeOpen((open) => !open)}
                className="mt-5 flex w-full items-center gap-1 text-left"
              >
                <span className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">
                  {t("settings.providers.runtime")}
                </span>
                {runtimeOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </button>
              {runtimeOpen && (
                <>
                  <p className="mt-0.5 text-xs text-text-tertiary">
                    {t("settings.providers.runtimeDesc")}
                  </p>
                  <div className="mt-1.5 space-y-2">
                    <input
                      value={runtimeDraft ? runtimeDraft.command : selected.command}
                      onChange={(e) =>
                        setRuntimeDraft(
                          runtimeDraft
                            ? { ...runtimeDraft, command: e.target.value }
                            : { command: e.target.value, args: selected.args.join(", ") },
                        )
                      }
                      className="h-8 w-full rounded-(--radius-sm) border border-border-subtle bg-(--input) px-2 font-mono text-sm text-text-primary focus:outline-none"
                    />
                    <input
                      value={runtimeDraft ? runtimeDraft.args : selected.args.join(", ")}
                      onChange={(e) =>
                        setRuntimeDraft(
                          runtimeDraft
                            ? { ...runtimeDraft, args: e.target.value }
                            : { command: selected.command, args: e.target.value },
                        )
                      }
                      placeholder={t("settings.providers.args")}
                      className="h-8 w-full rounded-(--radius-sm) border border-border-subtle bg-(--input) px-2 font-mono text-sm text-text-primary focus:outline-none"
                    />
                    {runtimeDraft &&
                      (runtimeDraft.command !== selected.command ||
                        runtimeDraft.args !== selected.args.join(", ")) && (
                        <div className="flex justify-end gap-2">
                          <button
                            onClick={() => setRuntimeDraft(null)}
                            className="flex h-7 items-center rounded-(--radius-sm) px-2 text-xs text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
                          >
                            <X size={12} /> {t("common.cancel")}
                          </button>
                          <button
                            onClick={saveRuntime}
                            className="flex h-7 items-center rounded-(--radius-sm) bg-accent px-3 text-xs font-medium text-accent-fg transition hover:brightness-110"
                          >
                            {t("settings.providers.saveRuntime")}
                          </button>
                        </div>
                      )}
                  </div>
                </>
              )}

              <p className="mt-5 text-xs font-semibold tracking-wider text-text-tertiary uppercase">
                Provider home
              </p>
              <p className="mt-0.5 text-xs text-text-tertiary">
                Config directory for this provider; the shadow path wins when set.
              </p>
              <div className="mt-1.5 space-y-2">
                <input
                  aria-label="Home path"
                  value={homeDraft ? homeDraft.home : (selected.homePath ?? "")}
                  onChange={(e) =>
                    setHomeDraft({
                      home: e.target.value,
                      shadow: homeDraft?.shadow ?? selected.shadowHomePath ?? "",
                    })
                  }
                  placeholder="C:\Users\me\.claude"
                  className="h-8 w-full rounded-(--radius-sm) border border-border-subtle bg-(--input) px-2 font-mono text-sm text-text-primary focus:outline-none"
                />
                <input
                  aria-label="Shadow home path"
                  value={homeDraft ? homeDraft.shadow : (selected.shadowHomePath ?? "")}
                  onChange={(e) =>
                    setHomeDraft({
                      home: homeDraft?.home ?? selected.homePath ?? "",
                      shadow: e.target.value,
                    })
                  }
                  placeholder="Optional shadow profile"
                  className="h-8 w-full rounded-(--radius-sm) border border-border-subtle bg-(--input) px-2 font-mono text-sm text-text-primary focus:outline-none"
                />
                {homeDraft &&
                  (homeDraft.home !== (selected.homePath ?? "") ||
                    homeDraft.shadow !== (selected.shadowHomePath ?? "")) && (
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setHomeDraft(null)}
                        className="flex h-7 items-center rounded-(--radius-sm) px-2 text-xs text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
                      >
                        <X size={12} /> {t("common.cancel")}
                      </button>
                      <button
                        onClick={saveHome}
                        className="flex h-7 items-center rounded-(--radius-sm) bg-accent px-3 text-xs font-medium text-accent-fg transition hover:brightness-110"
                      >
                        {t("common.save")}
                      </button>
                    </div>
                  )}
              </div>

              <div className="mt-5 flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">
                    Environment
                  </p>
                  <p className="mt-0.5 text-xs text-text-tertiary">
                    API keys, base URLs, and other per-instance CLI settings.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setEnvDraft((rows) => [...rows, { key: "", value: "", secret: false }])
                  }
                  className="flex h-7 shrink-0 items-center gap-1 rounded-(--radius-sm) border border-border-subtle px-2 text-xs text-text-secondary transition hover:bg-hover"
                >
                  <Plus size={12} /> Add variable
                </button>
              </div>
              <div className="mt-2 space-y-2">
                {envDraft.map((row, index) => (
                  <div key={index} className="flex gap-2">
                    <input
                      value={row.key}
                      onChange={(e) =>
                        setEnvDraft((rows) =>
                          rows.map((candidate, i) =>
                            i === index ? { ...candidate, key: e.target.value } : candidate,
                          ),
                        )
                      }
                      placeholder="KEY"
                      className="h-7 w-40 rounded-(--radius-sm) border border-border-subtle bg-(--input) px-2 font-mono text-xs text-text-primary focus:outline-none"
                    />
                    <input
                      value={row.value}
                      type={row.secret ? "password" : "text"}
                      onChange={(e) =>
                        setEnvDraft((rows) =>
                          rows.map((candidate, i) =>
                            i === index ? { ...candidate, value: e.target.value } : candidate,
                          ),
                        )
                      }
                      placeholder={row.hasValue ? (row.masked ?? "••••") : "value"}
                      className="h-7 min-w-0 flex-1 rounded-(--radius-sm) border border-border-subtle bg-(--input) px-2 font-mono text-xs text-text-primary focus:outline-none"
                    />
                    <label className="flex shrink-0 items-center gap-1 text-xs text-text-tertiary">
                      <input
                        type="checkbox"
                        checked={row.secret}
                        onChange={(e) =>
                          setEnvDraft((rows) =>
                            rows.map((candidate, i) =>
                              i === index ? { ...candidate, secret: e.target.checked } : candidate,
                            ),
                          )
                        }
                      />
                      Secret
                    </label>
                    <button
                      type="button"
                      aria-label="Remove variable"
                      onClick={() => setEnvDraft((rows) => rows.filter((_, i) => i !== index))}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-danger"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
                {envDraft.length > 0 && (
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={saveEnv}
                      className="flex h-7 items-center rounded-(--radius-sm) bg-accent px-3 text-xs font-medium text-accent-fg transition hover:brightness-110"
                    >
                      {t("common.save")}
                    </button>
                  </div>
                )}
              </div>

              <div className="mt-5 flex items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">
                    Models
                  </p>
                  <p className="mt-0.5 text-xs text-text-tertiary">
                    {modelItems.length} model{modelItems.length === 1 ? "" : "s"} reported by the
                    agent.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={modelItems.length === 0}
                  onClick={() =>
                    selected &&
                    disableAllModels(
                      selected.id,
                      modelItems.map((model) => model.value),
                    )
                  }
                  className="h-7 shrink-0 rounded-(--radius-sm) px-2 text-xs text-text-tertiary transition hover:bg-hover hover:text-text-secondary disabled:opacity-40"
                >
                  Disable all
                </button>
              </div>
              <div className="mt-2 space-y-0.5">
                {orderedModels.map((model) => {
                  const off = disabledAllSelected || disabled.includes(model.value);
                  const favorite = favorites.includes(model.value);
                  return (
                    <div
                      key={model.value}
                      className="flex items-center gap-1.5 rounded-(--radius-sm) px-1.5 py-1 transition hover:bg-hover"
                    >
                      <button
                        type="button"
                        aria-label={
                          favorite ? `Unfavorite ${model.name}` : `Favorite ${model.name}`
                        }
                        onClick={() => selected && toggleFavoriteModel(selected.id, model.value)}
                        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-(--radius-sm) transition hover:bg-active ${
                          favorite ? "text-warning" : "text-text-tertiary"
                        }`}
                      >
                        <Star size={11} fill={favorite ? "currentColor" : "none"} />
                      </button>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-text-primary">{model.name}</p>
                        <p className="truncate font-mono text-xs text-text-tertiary">
                          {model.value}
                        </p>
                      </div>
                      <button
                        type="button"
                        aria-label={`Move ${model.name} up`}
                        onClick={() => moveModel(model.value, -1)}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-active hover:text-text-secondary"
                      >
                        <ArrowUp size={11} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${model.name} down`}
                        onClick={() => moveModel(model.value, 1)}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-active hover:text-text-secondary"
                      >
                        <ArrowDown size={11} />
                      </button>
                      <Toggle
                        on={!off}
                        label={`${off ? "Enable" : "Disable"} ${model.name}`}
                        onClick={() => selected && toggleModelEnabled(selected.id, model.value)}
                      />
                    </div>
                  );
                })}
                {modelItems.length === 0 && (
                  <p className="rounded-(--radius-md) border border-border-subtle bg-surface px-3 py-2 text-xs text-text-tertiary">
                    This provider has not reported a model list yet. Check the connection first.
                  </p>
                )}
              </div>

              <div className="mt-6 flex items-center gap-2 border-t border-border-subtle pt-4">
                <button
                  onClick={() => void remove(selected.id)}
                  className="flex items-center gap-1.5 rounded-(--radius-sm) border border-border-subtle px-2.5 py-1 text-xs text-text-tertiary transition hover:bg-hover hover:text-danger"
                >
                  <Trash2 size={12} /> {t("settings.providers.disconnect")}
                </button>
                <p className="text-xs text-text-tertiary">
                  {t("settings.providers.removeHint", { path: "~/.pult/config.toml" })}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {adding && (
        <AddProviderDialog
          detected={detected}
          instances={instances}
          onClose={() => setAdding(false)}
          onAdded={(id) => {
            setSelectedId(id);
            setDetailOpen(true);
            void reload();
          }}
        />
      )}
    </div>
  );
}

/** T3-style switch. */
function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`relative h-4 w-8 shrink-0 rounded-full transition-colors duration-150 ${
        on ? "bg-accent" : "bg-border-strong"
      }`}
    >
      <span
        className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-[left] duration-150 ${
          on ? "left-4.5" : "left-0.5"
        }`}
      />
    </button>
  );
}
