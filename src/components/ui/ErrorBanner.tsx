import { Link, useRouter } from "@tanstack/react-router";
import { RotateCcw, TriangleAlert, X, HardDrive, Bot } from "lucide-react";
import { useUiStore } from "../../stores/ui";
import type { GlobalError } from "../../stores/ui";
import { useT } from "../../lib/i18n";

const KIND_KEYS: Record<GlobalError["kind"], string> = {
  agent_crash: "errorBanner.agentCrash",
  storage: "errorBanner.storage",
  protocol: "errorBanner.protocol",
};

const KIND_ICONS: Record<GlobalError["kind"], typeof Bot> = {
  agent_crash: Bot,
  storage: HardDrive,
  protocol: TriangleAlert,
};

/**
 * App-level error banner (§8 M7): agent crash / storage / protocol failures
 * surface here with a designed recovery path instead of a silent stall.
 */
export function ErrorBanner() {
  const t = useT();
  const error = useUiStore((s) => s.globalError);
  const clear = useUiStore((s) => s.clearGlobalError);
  const router = useRouter();

  if (!error) return null;
  const Icon = KIND_ICONS[error.kind];

  return (
    <div
      role="alert"
      className="absolute inset-x-0 bottom-0 z-40 border-t border-border-strong bg-surface-raised shadow-(--shadow-composer)"
    >
      <div className="mx-auto flex max-w-3xl items-start gap-3 px-4 py-3">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-danger/15">
          <Icon size={14} className="text-danger" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-text-primary">{t(KIND_KEYS[error.kind])}</p>
          <p className="mt-0.5 text-sm break-words text-text-secondary">{error.message}</p>
          <div className="mt-2 flex items-center gap-2">
            {error.kind === "agent_crash" && (
              <button
                onClick={() => {
                  void router.navigate({ to: "/settings/diagnostics" });
                  clear();
                }}
                className="flex items-center gap-1.5 rounded-(--radius-sm) border border-border-subtle px-2.5 py-1 text-xs text-text-secondary transition hover:bg-hover"
              >
                <RotateCcw size={12} /> {t("errorBanner.openDiagnostics")}
              </button>
            )}
            {error.kind === "storage" && (
              <button
                onClick={() => window.location.reload()}
                className="flex items-center gap-1.5 rounded-(--radius-sm) border border-border-subtle px-2.5 py-1 text-xs text-text-secondary transition hover:bg-hover"
              >
                <RotateCcw size={12} /> {t("errorBanner.retrySpace")}
              </button>
            )}
            {error.kind === "protocol" && (
              <Link
                to="/settings/diagnostics"
                onClick={clear}
                className="flex items-center gap-1.5 rounded-(--radius-sm) border border-border-subtle px-2.5 py-1 text-xs text-text-secondary transition hover:bg-hover"
              >
                {t("errorBanner.inspectFrames")}
              </Link>
            )}
            <button
              onClick={clear}
              aria-label={t("errorBanner.dismiss")}
              className="flex items-center gap-1.5 rounded-(--radius-sm) px-2 py-1 text-xs text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
            >
              <X size={12} /> {t("errorBanner.dismiss")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Route-level error boundary content (§8 M7): a render crash shows a
 * designed card with reload + escape hatches, never a blank pane.
 */
export function RouteErrorCard({ error, reset }: { error?: Error; reset: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-8">
      <div className="w-full max-w-md rounded-(--radius-md) border border-border-strong bg-surface p-5">
        <p className="text-sm font-semibold tracking-wider text-danger uppercase">
          Something went wrong
        </p>
        <pre className="mt-2 max-h-40 overflow-auto rounded-(--radius-sm) bg-code-bg p-2 font-mono text-xs whitespace-pre-wrap text-text-secondary">
          {error?.message ?? "The view crashed while rendering."}
        </pre>
        <div className="mt-3 flex gap-2">
          <button
            onClick={reset}
            className="flex items-center gap-1.5 rounded-(--radius-sm) border border-border-subtle px-2.5 py-1 text-xs text-text-secondary transition hover:bg-hover"
          >
            <RotateCcw size={12} /> Reload view
          </button>
          <Link
            to="/chat"
            className="flex items-center gap-1.5 rounded-(--radius-sm) border border-border-subtle px-2.5 py-1 text-xs text-text-secondary transition hover:bg-hover"
          >
            Back to chat
          </Link>
        </div>
      </div>
    </div>
  );
}
