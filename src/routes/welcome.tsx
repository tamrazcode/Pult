import { useEffect, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { RouteHeader } from "../components/layout/WindowChrome";
import { Button } from "../components/ui/button";
import { PultLogo } from "../components/ui/PultLogo";
import { ConnectRow, refreshDetected } from "../components/settings/AgentConnect";
import { isTauri } from "../lib/tauri";
import { useT } from "../lib/i18n";
import type { DetectedAgent } from "../lib/types";

export const Route = createFileRoute("/welcome")({ component: WelcomePage });

/** Onboarding wizard (§8 M6): detect installed agents, connect in one click. */
export function WelcomePage() {
  const t = useT();
  const router = useRouter();
  const [detected, setDetected] = useState<DetectedAgent[]>([]);

  useEffect(() => {
    if (isTauri()) void refreshDetected(setDetected);
  }, []);

  const enter = () => void router.navigate({ to: "/chat" });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RouteHeader title={t("panels.welcome.heading")} />
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10">
        <div className="w-full max-w-xl space-y-5">
          <div className="flex flex-col items-center gap-3 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-(--radius-lg) bg-accent text-accent-fg">
              <PultLogo className="h-8 w-8" />
            </div>
            <div className="space-y-1">
              <h1 className="text-2xl font-semibold text-text-primary">
                {t("panels.welcome.title")}
              </h1>
              <p className="text-sm text-text-secondary">{t("panels.welcome.subtitle")}</p>
            </div>
          </div>

          <div className="rounded-(--radius-lg) border border-border-subtle bg-surface p-4">
            <p className="text-xs font-semibold tracking-wider text-text-tertiary uppercase">
              {t("panels.welcome.detected")}
            </p>
            <div className="mt-2 space-y-2">
              {detected.length === 0 && (
                <p className="text-sm text-text-tertiary">{t("panels.welcome.none")}</p>
              )}
              {detected.map((agent) => (
                <ConnectRow
                  key={agent.id}
                  agent={agent}
                  alreadyAdded={false}
                  onAdded={() => void refreshDetected(setDetected)}
                />
              ))}
            </div>
          </div>

          <p className="text-center text-xs text-text-tertiary">{t("panels.welcome.footer")}</p>
          <div className="flex justify-center">
            <Button variant="primary" size="md" onClick={enter}>
              {t("panels.welcome.enter")} <ArrowRight size={14} />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
