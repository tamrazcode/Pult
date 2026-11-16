import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { appVersion } from "../lib/ipc";
import { useT } from "../lib/i18n";

export const Route = createFileRoute("/settings/about")({ component: AboutSettings });

function AboutSettings() {
  const t = useT();
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    void appVersion()
      .then(setVersion)
      .catch(() => setVersion(null));
  }, []);

  return (
    <div className="mx-auto max-w-2xl">
      <h2 className="text-lg font-medium text-text-primary">{t("settings.about.heading")}</h2>
      <p className="mt-1 text-sm text-text-tertiary">{t("settings.about.body")}</p>

      <dl className="mt-4 space-y-2 text-sm">
        <div className="flex gap-3">
          <dt className="w-32 shrink-0 text-text-tertiary">{t("settings.about.version")}</dt>
          <dd className="font-mono tnum text-text-primary">{version || "—"}</dd>
        </div>
        <div className="flex gap-3">
          <dt className="w-32 shrink-0 text-text-tertiary">{t("settings.about.protocol")}</dt>
          <dd className="text-text-primary">
            {t("settings.about.protocolValue", { path: "protocol/" })}
          </dd>
        </div>
        <div className="flex gap-3">
          <dt className="w-32 shrink-0 text-text-tertiary">{t("settings.about.data")}</dt>
          <dd className="text-text-primary">
            {t("settings.about.dataValue", { dataDir: "~/.pult", config: "config.toml" })}
          </dd>
        </div>
      </dl>
    </div>
  );
}
