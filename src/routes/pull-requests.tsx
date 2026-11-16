import { createFileRoute } from "@tanstack/react-router";
import { RouteHeader } from "../components/layout/WindowChrome";
import { PullRequestsList } from "../components/git/PullRequestsList";
import { useT } from "../lib/i18n";

export const Route = createFileRoute("/pull-requests")({ component: PullRequestsPage });

/** PRs opened from pult this session. */
export function PullRequestsPage() {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RouteHeader title={t("panels.pr.title")} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-8 py-10">
          <p className="text-sm text-text-tertiary">{t("panels.pr.body")}</p>
          <div className="mt-6">
            <PullRequestsList />
          </div>
        </div>
      </div>
    </div>
  );
}
