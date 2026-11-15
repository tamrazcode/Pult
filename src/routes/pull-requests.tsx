import { createFileRoute } from "@tanstack/react-router";
import { RouteHeader } from "../components/layout/WindowChrome";
import { PullRequestsList } from "../components/git/PullRequestsList";

export const Route = createFileRoute("/pull-requests")({ component: PullRequestsPage });

/** PRs opened from pult this session. */
export function PullRequestsPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RouteHeader title="Pull requests" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-8 py-10">
          <p className="text-sm text-text-tertiary">PRs you open from pult will be listed here.</p>
          <div className="mt-6">
            <PullRequestsList />
          </div>
        </div>
      </div>
    </div>
  );
}
