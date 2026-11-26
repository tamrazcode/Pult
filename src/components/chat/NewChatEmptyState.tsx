import { useRouter } from "@tanstack/react-router";
import { Composer } from "./Composer";
import { FileDropZone } from "./FileDropZone";
import { LivingAscii } from "./LivingAscii";
import { useProjectsStore } from "../../stores/projects";
import { useT } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import newThreadBackground from "../../assets/new-thread-bg.jpg";

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
    <FileDropZone className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-cover bg-center opacity-60"
        style={{ backgroundImage: `url(${newThreadBackground})` }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-canvas/80 via-canvas/10 to-canvas/85"
      />
      <div className="absolute inset-0 opacity-40">
        <LivingAscii />
      </div>
      <div className="relative z-10 w-full -translate-y-3 py-10">
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
        <div className="mt-7">
          <Composer />
        </div>
      </div>
    </FileDropZone>
  );
}
