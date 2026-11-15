import { GitPullRequest } from "lucide-react";
import { openExternalUrl } from "../../lib/ipc";
import { useGitStore } from "../../stores/git";

/** PRs opened from pult this session; used by the page and the right panel. */
export function PullRequestsList() {
  const prs = useGitStore((s) => s.prHistory);
  if (prs.length === 0) {
    return (
      <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-2 rounded-(--radius-lg) border border-dashed border-border-subtle px-6 py-10 text-center">
        <GitPullRequest size={20} className="text-text-tertiary" />
        <p className="text-sm text-text-secondary">No pull requests yet</p>
        <p className="text-xs text-text-tertiary">
          Review a thread's diff, then Commit ▸ Push ▸ Create PR from the diff panel.
        </p>
      </div>
    );
  }
  return (
    <ul className="space-y-2 p-2">
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
              <p className="truncate text-xs text-text-tertiary">from thread “{pr.threadTitle}”</p>
            </div>
            <button
              type="button"
              onClick={() => void openExternalUrl(pr.url)}
              className="shrink-0 font-mono text-xs text-accent hover:underline"
            >
              {pr.url}
            </button>
          </li>
        ))}
    </ul>
  );
}
