import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { appVersion } from "../lib/ipc";

export const Route = createFileRoute("/settings/about")({ component: AboutSettings });

function AboutSettings() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    void appVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  return (
    <div className="mx-auto max-w-2xl">
      <h2 className="text-lg font-medium text-text-primary">About pult</h2>
      <p className="mt-1 text-sm text-text-tertiary">
        A local-first Agent Development Environment: your coding agents, one window, over the Agent
        Client Protocol. pult runs the agents you already have — it never resells access or stores
        your keys.
      </p>

      <dl className="mt-4 space-y-2 text-sm">
        <div className="flex gap-3">
          <dt className="w-32 shrink-0 text-text-tertiary">Version</dt>
          <dd className="font-mono tnum text-text-primary">{version || "—"}</dd>
        </div>
        <div className="flex gap-3">
          <dt className="w-32 shrink-0 text-text-tertiary">Protocol</dt>
          <dd className="text-text-primary">ACP over stdio (pinned schema in protocol/)</dd>
        </div>
        <div className="flex gap-3">
          <dt className="w-32 shrink-0 text-text-tertiary">Data</dt>
          <dd className="text-text-primary">
            ~/.pult — sqlite transcripts, config.toml, checkpoints; nothing leaves the machine.
          </dd>
        </div>
      </dl>
    </div>
  );
}
