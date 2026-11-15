import { createFileRoute } from "@tanstack/react-router";
import { GitPullRequest } from "lucide-react";
import { RouteHeader } from "../components/layout/WindowChrome";
import { openExternalUrl } from "../lib/ipc";
import { useGitStore } from "../stores/git";

export const Route = createFileRoute("/pull-requests")({ component: PullRequestsPage });

/** M4 skeleton: PRs opened from pult this session (full page lands later). */
export function PullRequestsPage() {
  const prs = useGitStore((s) => s.prHistory);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RouteHeader title="Pull requests" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-8 py-10">
          <h1 className="text-lg font-medium text-text-primary">Pull requests</h1>
          <p className="mt-1 text-sm text-text-tertiary">
            PRs you open from pult will be listed here.
          </p>
          {prs.length === 0 ? (
            <div className="mt-16 flex flex-col items-center gap-2 rounded-(--radius-lg) border border-dashed border-border-subtle px-8 py-14 text-center">
              <GitPullRequest size={20} className="text-text-tertiary" />
              <p className="text-sm text-text-secondary">No pull requests yet</p>
              <p className="text-xs text-text-tertiary">
                Review a thread's diff, then Commit ▸ Push ▸ Create PR from the diff panel.
              </p>
            </div>
          ) : (
            <ul className="mt-6 space-y-2">
              {[...prs]
                .sort((a, b) => b.createdAt - a.createdAt)
                .map((pr) => (
                  <li
                    key={pr.url}
                    className="flex items-center gap-3 rounded-(--radius-md) border border-border-subtle bg-surface px-3 py-2.5"
                  >
                    <GitPullRequest size={15} className="shrink-0 text-success" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-text-primary">{pr.title}</p>
                      <p className="truncate text-xs text-text-tertiary">
                        from thread “{pr.threadTitle}”
                      </p>
                    </div>
                    <button
                      onClick={() => void openExternalUrl(pr.url)}
                      className="shrink-0 font-mono text-xs text-accent hover:underline"
                    >
                      {pr.url}
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
