import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Plus, RefreshCw, Trash2, X } from "lucide-react";
import {
  ipcErrorMessage,
  providersAuthenticate,
  providersDetectInstalled,
  providersInstancesList,
  providersInstancesSave,
  providersPreflight,
} from "../lib/ipc";
import { isTauri } from "../lib/tauri";
import { useUiStore } from "../stores/ui";
import { ConnectRow } from "../components/settings/AgentConnect";
import { SignInActions } from "../components/settings/SignInActions";
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
  return infos.map((i) =>
    i.id === id
      ? {
          id: i.id,
          displayName: i.displayName,
          driver: i.driver,
          command: i.command,
          args: i.args,
          env: i.env,
          enabled: i.enabled,
          ...patch,
        }
      : {
          id: i.id,
          displayName: i.displayName,
          driver: i.driver,
          command: i.command,
          args: i.args,
          env: i.env,
          enabled: i.enabled,
        },
  );
}

function statusLine(
  info: InstanceInfo,
  report: PreflightReport | undefined,
  checking: boolean,
  authenticating = false,
  authAttempted = false,
): { text: string; tone: "ok" | "warn" | "muted" | "bad" } {
  if (checking) return { text: "Checking connection…", tone: "muted" };
  if (authenticating) return { text: "Signing in…", tone: "muted" };
  if (!info.enabled) return { text: "Disabled", tone: "muted" };
  if (info.status === "needs_auth") {
    return { text: authAttempted ? "Still needs sign-in" : "Needs sign-in", tone: "warn" };
  }
  if (info.status === "crashed") return { text: "Crashed on last run", tone: "bad" };
  if (report) {
    if (report.authRequired) {
      return { text: authAttempted ? "Still needs sign-in" : "Needs sign-in", tone: "warn" };
    }
    const caps = [report.loadSession ? "resume" : null, report.promptImage ? "images" : null]
      .filter(Boolean)
      .join(" · ");
    return {
      text: `Connected${report.agentVersion ? ` · ${report.agentVersion}` : ""}${caps ? ` · ${caps}` : ""}`,
      tone: "ok",
    };
  }
  if (
    info.loadSession ||
    info.modes.length > 0 ||
    info.promptImage ||
    info.configOptions.length > 0
  ) {
    const caps = [info.loadSession ? "resume" : null, info.promptImage ? "images" : null]
      .filter(Boolean)
      .join(" · ");
    return { text: `Connected${caps ? ` · ${caps}` : ""}`, tone: "ok" };
  }
  return { text: "Not checked yet", tone: "muted" };
}

const TONE_CLASSES: Record<"ok" | "warn" | "muted" | "bad", string> = {
  ok: "text-success",
  warn: "text-warning",
  muted: "text-text-tertiary",
  bad: "text-danger",
};

function ProvidersSettings() {
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [detected, setDetected] = useState<DetectedAgent[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reports, setReports] = useState<Record<string, PreflightReport>>({});
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState(false);
  const [runtimeDraft, setRuntimeDraft] = useState<DraftRuntime | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [authenticating, setAuthenticating] = useState<Record<string, boolean>>({});
  const [authAttempted, setAuthAttempted] = useState<Record<string, boolean>>({});

  const reload = async () => {
    if (!isTauri()) return;
    const list = await providersInstancesList();
    setInstances(list);
    setDetected(await providersDetectInstalled());
    // The composer's agent picker reads the ui store — keep it in sync.
    await useUiStore.getState().loadInstances();
    setLoaded(true);
    setSelectedId((sel) => (sel && list.some((i) => i.id === sel) ? sel : (list[0]?.id ?? null)));
  };

  useEffect(() => {
    void reload();
  }, []);

  const selected = useMemo(
    () => instances.find((i) => i.id === selectedId) ?? null,
    [instances, selectedId],
  );
  useEffect(() => {
    setRuntimeDraft(null);
    setNameDraft(null);
  }, [selectedId]);

  const saveSpecs = async (specs: InstanceSpec[]) => {
    await providersInstancesSave(specs);
    await reload();
  };

  const toggle = (info: InstanceInfo) =>
    void saveSpecs(specList(instances, info.id, { enabled: !info.enabled }));

  const check = async (id: string) => {
    setChecking((m) => ({ ...m, [id]: true }));
    try {
      const report = await providersPreflight(id);
      setReports((m) => ({ ...m, [id]: report }));
      setCheckError((m) => {
        const { [id]: _dropped, ...rest } = m;
        return rest;
      });
    } catch (err) {
      setReports((m) => {
        const { [id]: _dropped, ...rest } = m;
        return rest;
      });
      setCheckError((m) => ({ ...m, [id]: ipcErrorMessage(err) }));
    } finally {
      setChecking((m) => ({ ...m, [id]: false }));
    }
  };

  const [checkError, setCheckError] = useState<Record<string, string>>({});

  const signIn = async (id: string, methodId: string) => {
    setAuthenticating((m) => ({ ...m, [id]: true }));
    setAuthAttempted((m) => ({ ...m, [id]: true }));
    try {
      const report = await providersAuthenticate(id, methodId);
      setReports((m) => ({ ...m, [id]: report }));
      setCheckError((m) => {
        const { [id]: _dropped, ...rest } = m;
        return rest;
      });
      await reload();
    } catch (err) {
      setCheckError((m) => ({ ...m, [id]: ipcErrorMessage(err) }));
    } finally {
      setAuthenticating((m) => ({ ...m, [id]: false }));
    }
  };

  const remove = async (id: string) => {
    await providersInstancesSave(
      instances
        .filter((i) => i.id !== id)
        .map((i) => ({
          id: i.id,
          displayName: i.displayName,
          driver: i.driver,
          command: i.command,
          args: i.args,
          env: i.env,
          enabled: i.enabled,
        })),
    );
    void reload();
  };

  const saveName = () => {
    if (!selected || nameDraft === null || !nameDraft.trim()) return;
    void saveSpecs(specList(instances, selected.id, { displayName: nameDraft.trim() }));
    setNameDraft(null);
  };

  const saveRuntime = () => {
    if (!selected || !runtimeDraft) return;
    const { command, args } = fromRuntime(runtimeDraft);
    if (!command) return;
    void saveSpecs(specList(instances, selected.id, { command, args }));
    setRuntimeDraft(null);
  };

  return (
    <div className="flex min-h-0 flex-1">
      {/* Provider list (T3-style left column) */}
      <div className="flex w-72 shrink-0 flex-col border-r border-border-subtle">
        <div className="flex items-center justify-between px-3 py-2.5">
          <p className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">
            Providers
          </p>
          <button
            onClick={() => setAdding((a) => !a)}
            title="Add provider"
            aria-label="Add provider"
            className="flex h-6 w-6 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {loaded && instances.length === 0 && (
            <p className="px-2 py-2 text-sm text-text-tertiary">No providers configured.</p>
          )}
          {instances.map((info) => {
            const st = statusLine(info, reports[info.id], checking[info.id]);
            return (
              <button
                key={info.id}
                onClick={() => setSelectedId(info.id)}
                className={`w-full rounded-(--radius-md) px-3 py-2 text-left transition ${
                  selectedId === info.id ? "bg-active" : "hover:bg-hover"
                }`}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={`min-w-0 flex-1 truncate text-sm ${
                      info.enabled ? "text-text-primary" : "text-text-tertiary"
                    }`}
                  >
                    {info.displayName}
                  </span>
                  <Toggle on={info.enabled} onClick={() => toggle(info)} />
                </span>
                <span className={`mt-0.5 block truncate text-xs ${TONE_CLASSES[st.tone]}`}>
                  {st.text}
                </span>
              </button>
            );
          })}
          {loaded && (
            <button
              onClick={() => setAdding((a) => !a)}
              className="mt-1 flex w-full items-center gap-2 rounded-(--radius-md) px-3 py-2 text-sm text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
            >
              <Plus size={14} /> Add provider
            </button>
          )}
        </div>
      </div>

      {/* Detail pane (T3-style right column) */}
      <div className="relative min-w-0 flex-1 overflow-y-auto p-5">
        {!selected && loaded && (
          <p className="text-sm text-text-tertiary">Pick a provider on the left.</p>
        )}
        {selected && (
          <div className="max-w-xl">
            <h2 className="text-lg font-medium text-text-primary">{selected.displayName}</h2>
            {(() => {
              const st = statusLine(
                selected,
                reports[selected.id],
                checking[selected.id],
                authenticating[selected.id],
                authAttempted[selected.id],
              );
              const err = checkError[selected.id];
              const needsAuth =
                reports[selected.id]?.authRequired === true || selected.status === "needs_auth";
              return (
                <div className="mt-3 rounded-(--radius-md) border border-border-subtle bg-surface p-3">
                  <p className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">
                    Status
                  </p>
                  {err ? (
                    <p className="mt-1 text-sm text-danger" title={err}>
                      {err}
                    </p>
                  ) : (
                    <>
                      <p className={`mt-1 text-sm ${TONE_CLASSES[st.tone]}`}>{st.text}</p>
                      {reports[selected.id]?.authRequired && reports[selected.id]?.authHint && (
                        <p
                          className="mt-1 text-xs text-text-tertiary"
                          title={reports[selected.id]?.authHint ?? undefined}
                        >
                          {reports[selected.id]?.authHint}
                        </p>
                      )}
                    </>
                  )}
                  <button
                    onClick={() => void check(selected.id)}
                    disabled={checking[selected.id] || !selected.enabled}
                    className="mt-2 flex items-center gap-1.5 rounded-(--radius-sm) border border-border-subtle px-2.5 py-1 text-xs text-text-secondary transition hover:bg-hover disabled:opacity-40"
                  >
                    <RefreshCw size={12} className={checking[selected.id] ? "animate-spin" : ""} />
                    Check connection
                  </button>
                  {needsAuth && (
                    <SignInActions
                      instanceId={selected.id}
                      launch={{
                        command: selected.command,
                        args: selected.args,
                        env: selected.env,
                      }}
                      authMethods={reports[selected.id]?.authMethods ?? selected.authMethods ?? []}
                      authHint={reports[selected.id]?.authHint ?? selected.authHint}
                      signingIn={authenticating[selected.id] === true}
                      authAttempted={authAttempted[selected.id] === true}
                      onSignIn={(methodId) => void signIn(selected.id, methodId)}
                      onRecheck={() => void check(selected.id)}
                    />
                  )}
                </div>
              );
            })()}

            <p className="mt-5 text-xs font-semibold tracking-wider text-text-tertiary uppercase">
              Display name
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
                  Save
                </button>
              )}
            </div>

            <p className="mt-5 text-xs font-semibold tracking-wider text-text-tertiary uppercase">
              Runtime
            </p>
            <p className="mt-0.5 text-xs text-text-tertiary">
              How pult starts the agent (ACP over stdio). Bare names resolve on PATH — `npx`,
              `opencode`, `claude` all work.
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
                placeholder="Arguments (comma-separated)"
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
                      <X size={12} /> Cancel
                    </button>
                    <button
                      onClick={saveRuntime}
                      className="flex h-7 items-center rounded-(--radius-sm) bg-accent px-3 text-xs font-medium text-accent-fg transition hover:brightness-110"
                    >
                      Save runtime
                    </button>
                  </div>
                )}
            </div>

            <div className="mt-6 flex items-center gap-2 border-t border-border-subtle pt-4">
              <button
                onClick={() => void remove(selected.id)}
                className="flex items-center gap-1.5 rounded-(--radius-sm) border border-border-subtle px-2.5 py-1 text-xs text-text-tertiary transition hover:bg-hover hover:text-danger"
              >
                <Trash2 size={12} /> Disconnect
              </button>
              <p className="text-xs text-text-tertiary">
                Removes the provider from <code className="font-mono">~/.pult/config.toml</code>.
              </p>
            </div>
          </div>
        )}

        {adding && (
          <div className="absolute inset-y-0 right-0 w-[420px] max-w-[90vw] overflow-y-auto border-l border-border-strong bg-canvas p-4 shadow-(--shadow-composer)">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-text-primary">Add provider</p>
              <button
                onClick={() => setAdding(false)}
                aria-label="Close"
                className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
              >
                <X size={14} />
              </button>
            </div>
            <p className="mt-1 text-xs text-text-tertiary">
              One click connects a detected CLI — pult picks the right command and checks the
              handshake itself.
            </p>
            <div className="mt-3 space-y-2">
              {detected.length === 0 && (
                <p className="text-sm text-text-tertiary">
                  No known agent CLIs on PATH. Use "Add custom ACP instance" below for any
                  ACP-over-stdio command.
                </p>
              )}
              {detected.map((agent) => (
                <ConnectRow
                  key={agent.id}
                  agent={agent}
                  alreadyAdded={instances.some((i) => i.id === agent.suggestedInstanceId)}
                  onAdded={() => void reload()}
                  onReport={(report) => {
                    setReports((m) => ({ ...m, [agent.suggestedInstanceId]: report }));
                    setSelectedId(agent.suggestedInstanceId);
                  }}
                />
              ))}
              <AddInstanceForm onAdded={() => void reload()} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** T3-style switch. */
function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
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

/** Add-instance form: any ACP-over-stdio command works (custom providers). */
function AddInstanceForm({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ id: "", displayName: "", command: "", args: "" });
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    try {
      const all = await providersInstancesList();
      const next = all.map((i) => ({
        id: i.id,
        displayName: i.displayName,
        driver: i.driver,
        command: i.command,
        args: i.args,
        env: i.env,
        enabled: i.enabled,
      }));
      next.push({
        id: draft.id.trim(),
        displayName: draft.displayName.trim() || draft.id.trim(),
        driver: "acp",
        command: draft.command.trim(),
        args: draft.args
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean),
        env: {},
        enabled: true,
      });
      await providersInstancesSave(next);
      await useUiStore.getState().loadInstances();
      setOpen(false);
      setError(null);
      setDraft({ id: "", displayName: "", command: "", args: "" });
      onAdded();
    } catch (err) {
      setError(ipcErrorMessage(err));
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 rounded-(--radius-md) border border-dashed border-border-strong px-3 py-2 text-sm text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
      >
        <Plus size={14} /> Add custom ACP instance
      </button>
    );
  }
  return (
    <div className="rounded-(--radius-md) border border-border-strong bg-surface p-3">
      <div className="space-y-2">
        <div className="flex gap-2">
          <input
            value={draft.id}
            onChange={(e) => setDraft({ ...draft, id: e.target.value })}
            placeholder="id (e.g. my-agent)"
            className="h-8 w-40 rounded-(--radius-sm) border border-border-subtle bg-(--input) px-2 font-mono text-sm text-text-primary focus:outline-none"
          />
          <input
            value={draft.displayName}
            onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
            placeholder="Display name"
            className="h-8 min-w-0 flex-1 rounded-(--radius-sm) border border-border-subtle bg-(--input) px-2 text-sm text-text-primary focus:outline-none"
          />
        </div>
        <input
          value={draft.command}
          onChange={(e) => setDraft({ ...draft, command: e.target.value })}
          placeholder="Command (e.g. opencode acp)"
          className="h-8 w-full rounded-(--radius-sm) border border-border-subtle bg-(--input) px-2 font-mono text-sm text-text-primary focus:outline-none"
        />
        <input
          value={draft.args}
          onChange={(e) => setDraft({ ...draft, args: e.target.value })}
          placeholder="Arguments (comma-separated)"
          className="h-8 w-full rounded-(--radius-sm) border border-border-subtle bg-(--input) px-2 font-mono text-sm text-text-primary focus:outline-none"
        />
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <button
            onClick={() => setOpen(false)}
            className="flex h-7 items-center rounded-(--radius-sm) px-2 text-xs text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
          >
            <X size={12} /> Cancel
          </button>
          <button
            onClick={() => void add()}
            className="flex h-7 items-center rounded-(--radius-sm) bg-accent px-3 text-xs font-medium text-accent-fg transition hover:brightness-110"
          >
            Add instance
          </button>
        </div>
      </div>
    </div>
  );
}
