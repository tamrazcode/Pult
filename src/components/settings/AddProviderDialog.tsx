import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Check, X } from "lucide-react";
import { ProviderLogo } from "../chat/ProviderLogo";
import { PROVIDER_CATALOG, type ProviderCatalogEntry } from "../../lib/providerCatalog";
import {
  providersInstancesList,
  providersInstancesSave,
  providersPreflight,
  providersInstall,
} from "../../lib/ipc";
import { localizeIpcError } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import type { DetectedAgent, InstanceInfo } from "../../lib/types";

const ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

function fieldsFor(entry: ProviderCatalogEntry, detected: DetectedAgent[]) {
  const agent = detected.find(
    (candidate) =>
      candidate.suggestedInstanceId === entry.detectedId || candidate.id === entry.detectedId,
  );
  const suggested = agent?.suggestedCommand;
  return {
    label: agent ? agent.displayName : entry.displayName,
    id: agent?.suggestedInstanceId ?? entry.id,
    command: suggested?.[0] ?? entry.command,
    args: (suggested ? suggested.slice(1) : entry.args).join("\n"),
  };
}

/** Three-step Add provider wizard with a blurred app-wide backdrop. */
export function AddProviderDialog({
  detected,
  instances,
  onClose,
  onAdded,
}: {
  detected: DetectedAgent[];
  instances: InstanceInfo[];
  onClose: () => void;
  onAdded: (id: string) => void;
}) {
  const [step, setStep] = useState(0);
  const [entry, setEntry] = useState<ProviderCatalogEntry>(PROVIDER_CATALOG[0]!);
  const initial = fieldsFor(PROVIDER_CATALOG[0]!, detected);
  const [label, setLabel] = useState(initial.label);
  const [id, setId] = useState(initial.id);
  const [command, setCommand] = useState(initial.command);
  const [args, setArgs] = useState(initial.args);
  const [homePath, setHomePath] = useState("");
  const [shadowHomePath, setShadowHomePath] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [installing, setInstalling] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const detectedAgent = useMemo(
    () =>
      detected.find(
        (agent) => agent.suggestedInstanceId === entry.detectedId || agent.id === entry.detectedId,
      ),
    [detected, entry],
  );
  // No CLI, no installer, and the command is still the catalog default: a
  // preflight would only fail after saving and rolling back. Ask for a real
  // command first (the user may have it in a nonstandard place).
  const manualMissing = !detectedAgent && !entry.installPackage && command.trim() === entry.command;

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (!panelRef.current.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  const choose = (next: ProviderCatalogEntry) => {
    const fields = fieldsFor(next, detected);
    setEntry(next);
    setLabel(fields.label);
    setId(fields.id);
    setCommand(fields.command);
    setArgs(fields.args);
    setHomePath("");
    setShadowHomePath("");
    setApiKey("");
    setError(null);
  };

  const validateIdentity = () => {
    const value = id.trim();
    if (!value) return "Instance ID is required.";
    if (!ID_RE.test(value)) return "Use letters, digits, '-' or '_', starting with a letter.";
    if (instances.some((instance) => instance.id === value)) return "That instance ID is taken.";
    if (!label.trim()) return "Label is required.";
    return null;
  };

  const next = () => {
    setError(null);
    if (step === 0) {
      if (entry.adapterRequired) {
        setError("This provider needs a dedicated adapter before it can be added.");
        return;
      }
      setStep(1);
      return;
    }
    if (step === 1) {
      const problem = validateIdentity();
      if (problem) {
        setError(problem);
        return;
      }
      setStep(2);
    }
  };

  const add = async () => {
    if (!command.trim()) {
      setError("Command is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (entry.installPackage && !detectedAgent) {
        setInstalling(true);
        try {
          await providersInstall(entry.id);
        } catch (err) {
          setError(`Install failed: ${localizeIpcError(err)}`);
          return;
        } finally {
          setInstalling(false);
        }
      }
      const all = await providersInstancesList();
      if (all.some((instance) => instance.id === id.trim())) {
        setError("That instance ID is taken.");
        return;
      }
      const next = all
        .filter((instance) => instance.id !== id.trim())
        .map((instance) => ({
          id: instance.id,
          displayName: instance.displayName,
          driver: instance.driver,
          command: instance.command,
          args: instance.args,
          env: instance.env,
          secretEnvKeys: (instance.secretEnv ?? []).map((secret) => secret.key),
          homePath: instance.homePath ?? null,
          shadowHomePath: instance.shadowHomePath ?? null,
          enabled: instance.enabled,
        }));
      next.push({
        id: id.trim(),
        displayName: label.trim(),
        driver: entry.driver ?? "acp",
        command: command.trim(),
        args: args
          .split(/[\n,]/)
          .map((value) => value.trim())
          .filter(Boolean),
        env: entry.apiKeyEnv && apiKey.trim() ? { [entry.apiKeyEnv]: apiKey.trim() } : {},
        secretEnvKeys: entry.apiKeyEnv && apiKey.trim() ? [entry.apiKeyEnv] : [],
        homePath: homePath.trim() || null,
        shadowHomePath: shadowHomePath.trim() || null,
        enabled: true,
      });
      await providersInstancesSave(next);
      try {
        await providersPreflight(id.trim());
      } catch (err) {
        await providersInstancesSave(
          all.map((instance) => ({
            id: instance.id,
            displayName: instance.displayName,
            driver: instance.driver,
            command: instance.command,
            args: instance.args,
            env: instance.env,
            secretEnvKeys: (instance.secretEnv ?? []).map((secret) => secret.key),
            homePath: instance.homePath ?? null,
            shadowHomePath: instance.shadowHomePath ?? null,
            enabled: instance.enabled,
          })),
        );
        setError(`Connection failed: ${localizeIpcError(err)}`);
        return;
      }
      await useUiStore.getState().loadInstances();
      onAdded(id.trim());
      onClose();
    } catch (err) {
      setError(localizeIpcError(err));
    } finally {
      setSaving(false);
    }
  };

  const steps = ["Provider", "Identity", "Config"];

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-md"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Add provider"
        className="flex max-h-[calc(100vh-64px)] w-full max-w-[720px] flex-col overflow-hidden rounded-(--radius-lg) border border-border-strong bg-canvas shadow-2xl"
      >
        <div className="flex items-start justify-between border-b border-border-subtle px-5 py-4">
          <div>
            <h2 className="text-base font-medium text-text-primary">Add provider</h2>
            <p className="mt-1 text-xs text-text-tertiary">
              Add an account or configure a provider on this machine.
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex items-center gap-2 border-b border-border-subtle px-5 py-3">
          {steps.map((name, index) => {
            const done = index < step;
            const active = index === step;
            return (
              <div
                key={name}
                className={`flex h-7 items-center gap-2 rounded-(--radius-sm) px-2.5 text-xs ${
                  active
                    ? "bg-active text-text-primary"
                    : done
                      ? "text-text-secondary"
                      : "text-text-tertiary"
                }`}
              >
                <span
                  className={`flex h-4 w-4 items-center justify-center rounded-full text-[12px] ${
                    active || done ? "bg-accent text-accent-fg" : "bg-active text-text-tertiary"
                  }`}
                >
                  {done ? <Check size={10} /> : index + 1}
                </span>
                {name}
              </div>
            );
          })}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {step === 0 && (
            <>
              <p className="mb-2 text-sm font-medium text-text-primary">Provider</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {PROVIDER_CATALOG.map((provider) => {
                  const installed = detected.some(
                    (agent) =>
                      agent.suggestedInstanceId === provider.detectedId ||
                      agent.id === provider.detectedId,
                  );
                  const selected = entry.id === provider.id;
                  return (
                    <button
                      key={provider.id}
                      type="button"
                      onClick={() => choose(provider)}
                      className={`flex min-w-0 items-start gap-3 rounded-(--radius-md) border p-3 text-left transition ${
                        selected
                          ? "border-accent bg-accent/10"
                          : "border-border-subtle bg-surface hover:bg-hover"
                      } ${provider.adapterRequired ? "opacity-70" : ""}`}
                    >
                      <ProviderLogo
                        instance={{
                          id: provider.id,
                          driver: "acp",
                          displayName: provider.displayName,
                          command: provider.command,
                          args: provider.args,
                        }}
                        className="mt-0.5 h-5 w-5 shrink-0"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate text-sm font-medium text-text-primary">
                            {provider.displayName}
                          </span>
                          {installed && (
                            <span className="rounded bg-success/15 px-1 text-[12px] text-success">
                              Installed
                            </span>
                          )}
                          {!installed && provider.installPackage && (
                            <span className="rounded bg-accent/15 px-1 text-[12px] text-accent">
                              Auto-install
                            </span>
                          )}
                          {!installed && !provider.installPackage && (
                            <span className="rounded bg-active px-1 text-[12px] text-text-tertiary">
                              Manual setup
                            </span>
                          )}
                          {provider.experimental && (
                            <span className="rounded bg-warning/15 px-1 text-[12px] text-warning">
                              Experimental
                            </span>
                          )}
                        </span>
                        <span className="mt-1 block text-xs leading-4 text-text-tertiary">
                          {provider.description}
                        </span>
                      </span>
                      <span
                        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                          selected
                            ? "border-accent bg-accent text-accent-fg"
                            : "border-border-strong"
                        }`}
                      >
                        {selected && <Check size={10} />}
                      </span>
                    </button>
                  );
                })}
              </div>
              {entry.adapterRequired && (
                <p className="mt-3 rounded-(--radius-sm) border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                  {entry.displayName} needs a dedicated Pult adapter. It stays visible here, but
                  cannot be added as ACP yet.
                </p>
              )}
            </>
          )}

          {step === 1 && (
            <div className="max-w-lg space-y-4">
              <label className="block">
                <span className="text-sm font-medium text-text-primary">Label</span>
                <span className="mt-0.5 block text-xs text-text-tertiary">
                  Shown in the provider list.
                </span>
                <input
                  autoFocus
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  className="mt-1.5 h-8 w-full rounded-(--radius-sm) border border-border-subtle bg-(--input) px-2 text-sm text-text-primary focus:border-border-strong focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-text-primary">Instance ID</span>
                <span className="mt-0.5 block text-xs text-text-tertiary">
                  Letters, digits, '-' or '_', starting with a letter.
                </span>
                <input
                  value={id}
                  onChange={(event) => setId(event.target.value)}
                  className="mt-1.5 h-8 w-full rounded-(--radius-sm) border border-border-subtle bg-(--input) px-2 font-mono text-sm text-text-primary focus:border-border-strong focus:outline-none"
                />
              </label>
              <div className="flex items-center gap-2 rounded-(--radius-sm) border border-border-subtle bg-surface px-3 py-2">
                <ProviderLogo
                  instance={{
                    id: entry.id,
                    driver: "acp",
                    displayName: entry.displayName,
                    command: entry.command,
                    args: entry.args,
                  }}
                  className="h-4 w-4 shrink-0"
                />
                <span className="text-xs text-text-tertiary">
                  {detectedAgent
                    ? "Detected on PATH — command is prefilled."
                    : entry.installPackage
                      ? "Not detected on PATH — Pult can install it automatically in the next step."
                      : "Not detected on PATH — enter the command manually in the next step."}
                </span>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="max-w-lg space-y-4">
              <label className="block">
                <span className="text-sm font-medium text-text-primary">Command</span>
                <span className="mt-0.5 block text-xs text-text-tertiary">
                  Binary or ACP bridge used by this instance.
                </span>
                <input
                  autoFocus
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  className="mt-1.5 h-8 w-full rounded-(--radius-sm) border border-border-subtle bg-(--input) px-2 font-mono text-sm text-text-primary focus:border-border-strong focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-text-primary">Arguments</span>
                <span className="mt-0.5 block text-xs text-text-tertiary">
                  One argument per line, or comma-separated.
                </span>
                <textarea
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                  rows={3}
                  className="mt-1.5 w-full resize-y rounded-(--radius-sm) border border-border-subtle bg-(--input) px-2 py-1.5 font-mono text-sm text-text-primary focus:border-border-strong focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-text-primary">Home path</span>
                <span className="mt-0.5 block text-xs text-text-tertiary">
                  Optional config directory: CLAUDE_CONFIG_DIR for Claude, CODEX_HOME for Codex.
                </span>
                <input
                  value={homePath}
                  onChange={(event) => setHomePath(event.target.value)}
                  placeholder="C:\Users\me\.claude"
                  className="mt-1.5 h-8 w-full rounded-(--radius-sm) border border-border-subtle bg-(--input) px-2 font-mono text-sm text-text-primary focus:border-border-strong focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-text-primary">Shadow home path</span>
                <span className="mt-0.5 block text-xs text-text-tertiary">
                  Optional separate profile; wins over the home path when set.
                </span>
                <input
                  value={shadowHomePath}
                  onChange={(event) => setShadowHomePath(event.target.value)}
                  className="mt-1.5 h-8 w-full rounded-(--radius-sm) border border-border-subtle bg-(--input) px-2 font-mono text-sm text-text-primary focus:border-border-strong focus:outline-none"
                />
              </label>
              {entry.installPackage && !detectedAgent && (
                <p className="rounded-(--radius-sm) border border-border-subtle bg-surface px-3 py-2 text-xs text-text-tertiary">
                  Pult installs <span className="font-mono">{entry.installPackage}</span> into its
                  own npm folder (no admin rights) and downloads a portable Node runtime if this
                  machine has none, then tests the agent.
                </p>
              )}
              {manualMissing && (
                <p className="rounded-(--radius-sm) border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
                  {entry.displayName} was not found on PATH and has no automatic installer.{" "}
                  {entry.manualInstallHint ?? "Install its CLI first."} Or enter the absolute path
                  to its executable above.
                </p>
              )}
              {entry.apiKeyEnv && (
                <label className="block">
                  <span className="text-sm font-medium text-text-primary">
                    API key <span className="font-normal text-text-tertiary">(optional)</span>
                  </span>
                  <span className="mt-0.5 block text-xs text-text-tertiary">
                    Use an API key when the account has no Claude Code plan. Saved as{" "}
                    <span className="font-mono">{entry.apiKeyEnv}</span> in the encrypted secret
                    store.
                  </span>
                  <input
                    type="password"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder={entry.apiKeyEnv}
                    className="mt-1.5 h-8 w-full rounded-(--radius-sm) border border-border-subtle bg-(--input) px-2 font-mono text-sm text-text-primary focus:border-border-strong focus:outline-none"
                  />
                </label>
              )}
            </div>
          )}

          {error && <p className="mt-3 text-xs text-danger">{error}</p>}
        </div>

        <div className="flex items-center justify-between border-t border-border-subtle px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-(--radius-sm) px-3 text-xs text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
          >
            Cancel
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setStep((current) => current - 1);
                }}
                className="flex h-8 items-center gap-1 rounded-(--radius-sm) border border-border-strong px-3 text-xs text-text-secondary transition hover:bg-hover"
              >
                <ArrowLeft size={13} /> Back
              </button>
            )}
            {step < 2 ? (
              <button
                type="button"
                onClick={next}
                className="h-8 rounded-(--radius-sm) bg-accent px-4 text-xs font-medium text-accent-fg transition hover:brightness-110"
              >
                Next
              </button>
            ) : (
              <button
                type="button"
                disabled={saving || installing || manualMissing}
                onClick={() => void add()}
                className="h-8 rounded-(--radius-sm) bg-accent px-4 text-xs font-medium text-accent-fg transition hover:brightness-110 disabled:opacity-60"
              >
                {installing
                  ? "Installing…"
                  : saving
                    ? "Connecting…"
                    : entry.installPackage && !detectedAgent
                      ? "Install & connect"
                      : "Add instance"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
