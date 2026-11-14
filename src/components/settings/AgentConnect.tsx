import { useState } from "react";
import { Check, Loader2, ShieldAlert, TerminalSquare } from "lucide-react";
import {
  ipcErrorMessage,
  providersDetectInstalled,
  providersInstancesList,
  providersInstancesSave,
  providersPreflight,
} from "../../lib/ipc";
import { useUiStore } from "../../stores/ui";
import type { DetectedAgent, PreflightReport } from "../../lib/types";

/** Appends a detected agent as an instance without touching the others. */
export async function addDetectedAgent(agent: DetectedAgent): Promise<void> {
  const command = agent.suggestedCommand ?? [agent.command];
  const all = await providersInstancesList();
  const next = all
    .filter((i) => i.id !== agent.suggestedInstanceId)
    .map((i) => ({
      id: i.id,
      displayName: i.displayName,
      driver: i.driver,
      command: i.command,
      args: i.args,
      env: i.env,
      enabled: i.enabled,
    }));
  next.push({
    id: agent.suggestedInstanceId,
    displayName: agent.displayName,
    driver: "acp",
    command: command[0],
    args: command.slice(1),
    env: {},
    enabled: true,
  });
  await providersInstancesSave(next);
  // The composer picker reads the ui store — refresh it immediately.
  await useUiStore.getState().loadInstances();
}

type ConnectState =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "connected"; report: PreflightReport }
  | { kind: "needs_auth"; report: PreflightReport }
  | { kind: "error"; message: string };

/**
 * One agent row for the connect flow ("like T3 Code: press the button"):
 * Connect adds the instance with the right command and immediately verifies
 * the handshake — the user never edits a form or wires a command.
 */
export function ConnectRow({
  agent,
  alreadyAdded,
  onAdded,
}: {
  agent: DetectedAgent;
  alreadyAdded: boolean;
  onAdded: () => void;
}) {
  const [state, setState] = useState<ConnectState>({ kind: "idle" });

  const connect = async () => {
    setState({ kind: "working" });
    try {
      await addDetectedAgent(agent);
      onAdded();
      const report = await providersPreflight(agent.suggestedInstanceId);
      setState({ kind: report.authRequired ? "needs_auth" : "connected", report });
    } catch (err) {
      setState({ kind: "error", message: ipcErrorMessage(err) });
    }
  };

  const status = () => {
    switch (state.kind) {
      case "working":
        return (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-text-secondary">
            <Loader2 size={12} className="animate-spin" /> Connecting…
          </span>
        );
      case "connected":
        return (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-success">
            <Check size={12} />
            Connected
            {state.report.agentVersion ? ` · ${state.report.agentVersion}` : ""}
            {state.report.loadSession ? " · resume ✓" : ""}
            {state.report.promptImage ? " · images ✓" : ""}
          </span>
        );
      case "needs_auth":
        return (
          <span
            className="flex shrink-0 items-center gap-1.5 text-xs text-warning"
            title="Run the agent's own sign-in command once (e.g. `claude`, `codex`); pult picks it up on the next run."
          >
            <ShieldAlert size={12} /> Needs sign-in
          </span>
        );
      case "error":
        return (
          <span
            className="max-w-[220px] shrink-0 truncate text-xs text-danger"
            title={state.message}
          >
            {state.message}
          </span>
        );
      default:
        return null;
    }
  };

  return (
    <div className="flex items-center gap-3 rounded-(--radius-md) border border-border-subtle bg-surface-raised px-3 py-2">
      <TerminalSquare size={16} className="shrink-0 text-text-tertiary" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-text-primary">{agent.displayName}</p>
        <p className="truncate text-xs text-text-tertiary">
          {state.kind === "error" ? state.message : agent.notes}
        </p>
      </div>
      {alreadyAdded ? (
        <span className="flex shrink-0 items-center gap-1 text-xs text-success">
          <Check size={12} /> Added
        </span>
      ) : (
        <>
          {status()}
          <button
            onClick={() => void connect()}
            disabled={state.kind === "working" || !agent.suggestedCommand}
            title={
              agent.suggestedCommand
                ? `Connect ${agent.displayName} (${agent.suggestedCommand.join(" ")})`
                : agent.notes
            }
            className="flex h-7 shrink-0 items-center gap-1 rounded-(--radius-sm) bg-accent px-3 text-xs font-medium text-accent-fg transition hover:brightness-110 disabled:opacity-40"
          >
            Connect
          </button>
        </>
      )}
    </div>
  );
}

/** Re-runs detection (also used after adds so rows flip to "Added"). */
export async function refreshDetected(set: (agents: DetectedAgent[]) => void): Promise<void> {
  set(await providersDetectInstalled());
}
