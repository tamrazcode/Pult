import { useEffect, useState } from "react";
import { buildTerminalAuthCommand, detectDefaultAuthShell, splitAuthMethods } from "../../lib/auth";
import type { AuthShell } from "../../lib/auth";
import type { AuthMethod } from "../../lib/types";
import { useT } from "../../lib/i18n";

/**
 * Sign-in actions for a provider that reports Needs sign-in. Agent-managed
 * methods call `authenticate`; terminal methods show the exact CLI to run —
 * pult never sends a terminal method over RPC.
 */
export function SignInActions({
  launch,
  authMethods,
  authHint,
  signingIn,
  authAttempted,
  onSignIn,
  onRecheck,
}: {
  launch: { command: string; args: string[]; env?: Record<string, string> };
  authMethods: AuthMethod[];
  authHint?: string | null;
  signingIn: boolean;
  authAttempted: boolean;
  onSignIn: (methodId: string) => void;
  onRecheck: () => void;
}) {
  const t = useT();
  const { agent, terminal } = splitAuthMethods(authMethods);
  const [copied, setCopied] = useState<string | null>(null);
  const [shell, setShell] = useState<AuthShell>(detectDefaultAuthShell);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = (command: string) => {
    void navigator.clipboard
      ?.writeText(command)
      .then(() => setCopied(command))
      .catch(() => undefined);
  };

  if (agent.length === 0 && terminal.length === 0) {
    return (
      <div className="mt-2 rounded-(--radius-sm) border border-warning/40 bg-warning/5 px-2 py-1.5">
        <p className="text-xs text-text-secondary">{authHint ?? t("settings.signIn.noMethods")}</p>
        <button
          onClick={onRecheck}
          className="mt-1 flex h-6 items-center rounded-(--radius-sm) border border-border-subtle px-2 text-xs text-text-secondary transition hover:bg-hover"
        >
          {t("settings.signIn.recheck")}
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-1.5 rounded-(--radius-sm) border border-warning/40 bg-warning/5 px-2 py-1.5">
      {agent.map((method) => (
        <div key={method.id ?? ""} className="flex items-center gap-2">
          <button
            disabled={signingIn}
            title={method.description ?? undefined}
            onClick={() => onSignIn(method.id ?? "")}
            className="flex h-6 items-center rounded-(--radius-sm) bg-accent px-2 text-xs font-medium text-accent-fg transition hover:brightness-110 disabled:opacity-50"
          >
            {signingIn
              ? t("settings.providers.signingIn")
              : method.name
                ? t("settings.signIn.signInWith", { name: method.name })
                : t("settings.signIn.signIn")}
          </button>
          {authAttempted && !signingIn && (
            <span className="text-xs text-warning">{t("settings.providers.stillNeedsSignIn")}</span>
          )}
        </div>
      ))}
      {terminal.map((method) => {
        const command = buildTerminalAuthCommand(launch, method, shell);
        return (
          <div key={method.id ?? ""} className="space-y-1">
            <p className="text-xs text-text-secondary">
              {t("settings.signIn.runsOutside", {
                name: method.name ?? t("settings.signIn.terminalTitle"),
              })}
            </p>
            <pre className="overflow-x-auto rounded-(--radius-sm) bg-code-bg p-1.5 font-mono text-[13px] text-text-primary">
              {command}
            </pre>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => copy(command)}
                className="flex h-6 items-center rounded-(--radius-sm) border border-border-subtle px-2 text-xs text-text-secondary transition hover:bg-hover"
              >
                {copied === command ? t("common.copied") : t("settings.signIn.copyCommand")}
              </button>
              <select
                aria-label={t("settings.signIn.shell")}
                value={shell}
                onChange={(event) => setShell(event.target.value as AuthShell)}
                className="h-6 rounded-(--radius-sm) border border-border-subtle bg-surface px-1 text-xs text-text-secondary focus:outline-none"
              >
                <option value="powershell">PowerShell</option>
                <option value="posix">sh</option>
              </select>
              <button
                onClick={onRecheck}
                className="flex h-6 items-center rounded-(--radius-sm) border border-border-subtle px-2 text-xs text-text-secondary transition hover:bg-hover"
              >
                {t("settings.signIn.recheck")}
              </button>
            </div>
          </div>
        );
      })}
      {authHint && !authAttempted && <p className="text-xs text-text-tertiary">{authHint}</p>}
    </div>
  );
}
