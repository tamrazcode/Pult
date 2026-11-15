import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { diagnosticsFrames, providersInstancesList } from "../lib/ipc";
import { ipcErrorMessage } from "../lib/ipc";
import { isTauri } from "../lib/tauri";
import { useUiStore } from "../stores/ui";
import type { InstanceInfo } from "../lib/types";

export const Route = createFileRoute("/settings/diagnostics")({ component: DiagnosticsSettings });

/** One instance card: caps, process log, last raw frames (§8 M6). */
function InstanceDiagnostics({ info }: { info: InstanceInfo }) {
  const [frames, setFrames] = useState<string[] | null>(null);
  const [framesError, setFramesError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Select the stable record — `?? []` inside the selector would return a
  // fresh array each getSnapshot and loop React's useSyncExternalStore.
  const ring = useUiStore((s) => s.processEvents[info.id]);
  const processEvents = ring ?? [];

  const loadFrames = async () => {
    setLoading(true);
    setFramesError(null);
    try {
      setFrames(await diagnosticsFrames(info.id));
    } catch (err) {
      setFrames(null);
      setFramesError(ipcErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-(--radius-md) border border-border-subtle bg-surface p-3">
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            processEvents.at(-1)?.kind === "crashed"
              ? "bg-danger"
              : processEvents.at(-1)?.kind === "spawned" || processEvents.at(-1)?.kind === "running"
                ? "bg-success"
                : processEvents.at(-1)?.kind === "starting"
                  ? "bg-warning"
                  : "bg-text-tertiary"
          }`}
        />
        <p className="min-w-0 flex-1 truncate text-sm text-text-primary">{info.displayName}</p>
        <button
          onClick={() => void loadFrames()}
          title="Grab the last raw protocol frames (needs a live run)"
          className="flex h-7 items-center gap-1 rounded-(--radius-sm) border border-border-subtle px-2 text-xs text-text-secondary transition hover:bg-hover"
        >
          <RefreshCw size={11} className={loading ? "animate-spin" : ""} /> Frames
        </button>
      </div>
      <p className="mt-1 font-mono text-xs text-text-tertiary">
        {info.driver === "mock" ? "built-in mock agent" : `${info.command} ${info.args.join(" ")}`}
      </p>
      <p className="mt-1 text-xs text-text-tertiary">
        caps: {info.promptImage ? "images ✓ · " : ""}
        {info.loadSession ? "resume ✓ · " : ""}
        {info.modes.length > 0 ? `${info.modes.length} modes` : "no modes advertised"}
        {info.configOptions.length > 0 ? ` · ${info.configOptions.length} config options` : ""}
      </p>

      {processEvents.length > 0 && (
        <div className="mt-2">
          <p className="text-xs tracking-wider text-text-tertiary uppercase">Process log</p>
          <div className="mt-1 max-h-24 space-y-0.5 overflow-y-auto font-mono text-[13px] text-text-tertiary">
            {processEvents.map((event, i) => (
              <p key={i}>
                {new Date(event.at).toLocaleTimeString()} {event.kind}
                {event.detail ? ` — ${event.detail}` : ""}
              </p>
            ))}
          </div>
        </div>
      )}

      {framesError && <p className="mt-2 text-xs text-warning">{framesError}</p>}
      {frames && (
        <div className="mt-2">
          <p className="text-xs tracking-wider text-text-tertiary uppercase">Last raw frames</p>
          <pre className="mt-1 max-h-48 overflow-auto rounded-(--radius-sm) bg-canvas p-2 font-mono text-[13px] whitespace-pre-wrap text-text-tertiary">
            {frames.join("\n")}
          </pre>
        </div>
      )}
    </div>
  );
}

function DiagnosticsSettings() {
  const [instances, setInstances] = useState<InstanceInfo[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!isTauri()) {
      setLoaded(true);
      return;
    }
    // Direct visits must still subscribe to "agent:process" (the composer's
    // picker normally does this) so the ring fills while the page is open.
    void useUiStore.getState().loadInstances();
    void providersInstancesList().then((list) => {
      setInstances(list);
      setLoaded(true);
    });
  }, []);

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-lg font-medium text-text-primary">Diagnostics</h1>
      <p className="mt-1 text-sm text-text-tertiary">
        Live view of every configured agent: capabilities, process events, and the last raw protocol
        frames while a run is active.
      </p>
      <div className="mt-4 space-y-2">
        {loaded && instances.length === 0 && (
          <p className="text-sm text-text-tertiary">No instances configured.</p>
        )}
        {instances.map((info) => (
          <InstanceDiagnostics key={info.id} info={info} />
        ))}
      </div>
    </div>
  );
}
