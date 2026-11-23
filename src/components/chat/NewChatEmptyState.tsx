import { useRouter } from "@tanstack/react-router";
import { Composer } from "./Composer";
import { LivingAscii } from "./LivingAscii";
import { useProjectsStore } from "../../stores/projects";
import { useT } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";

/** First-run screen: live ASCII field, prompt, and the composer. */
export function NewChatEmptyState() {
  const t = useT();
  const router = useRouter();
  const project = useProjectsStore((s) =>
    s.projects.find((candidate) => candidate.id === s.selectedProjectId),
  );
  const instances = useUiStore((s) => s.instances);
  const enabled = instances.filter((instance) => instance.enabled);
  const noAgent = enabled.length === 0;
  const onlyMock = enabled.length > 0 && enabled.every((i) => i.driver === "mock");
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <LivingAscii />
      {/* The prompt sits in the space above the composer, and the composer is
          docked to the bottom of the panel here exactly as it is in an open
          thread — the two states must not put it in different places. */}
      <div className="relative z-10 flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto py-10">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-6 text-center">
          <h1 className="text-2xl font-medium tracking-tight text-text-primary">
            {t("chat.firstRun.title")}
          </h1>
          <p className="mt-1.5 max-w-md text-sm text-text-tertiary">
            {project ? project.name : t("chat.firstRun.noProject")}
          </p>
          {noAgent && (
            <div
              role="status"
              className="mt-4 flex max-w-md items-center gap-3 rounded-(--radius-md) border border-border-subtle bg-surface px-3 py-2 text-left"
            >
              <p className="min-w-0 flex-1 text-xs text-text-secondary">
                {t("chat.firstRun.noAgent")}
              </p>
              <button
                type="button"
                onClick={() => void router.navigate({ to: "/settings/providers" })}
                className="shrink-0 rounded-(--radius-sm) border border-border-strong bg-surface-raised px-2 py-1 text-xs text-text-primary transition hover:bg-hover"
              >
                {t("chat.firstRun.connectAgent")}
              </button>
            </div>
          )}
          {onlyMock && (
            <button
              type="button"
              onClick={() => void router.navigate({ to: "/settings/providers" })}
              className="mt-3 rounded-full border border-border-subtle px-2.5 py-1 text-xs text-text-tertiary transition hover:border-border-strong hover:text-text-secondary"
            >
              {t("chat.firstRun.mock")}
            </button>
          )}
        </div>
      </div>
      <div className="relative z-10 w-full shrink-0">
        <Composer />
      </div>
    </div>
  );
}
