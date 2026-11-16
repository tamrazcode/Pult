import { Suspense, lazy, useEffect } from "react";
import { ChevronLeft, FileDiff, FolderTree, Globe2, Terminal } from "lucide-react";
import { FilesPanel } from "../files/FilesPanel";
import { BrowserPanel } from "../browser/BrowserPanel";
import { PullRequestsList } from "../git/PullRequestsList";
import { isTauri } from "../../lib/tauri";

const DiffPanel = lazy(() =>
  import("../diff/DiffPanel").then((module) => ({ default: module.DiffPanel })),
);
const TerminalPanel = lazy(() =>
  import("../terminal/TerminalPanel").then((module) => ({ default: module.TerminalPanel })),
);
import { useThreadsStore } from "../../stores/threads";
import { useUiStore } from "../../stores/ui";
import type { RightPanelTab } from "../../stores/ui";
import { useT } from "../../lib/i18n";

const TABS: { id: RightPanelTab; labelKey: string; icon: typeof FileDiff }[] = [
  { id: "browser", labelKey: "panels.browser", icon: Globe2 },
  { id: "terminal", labelKey: "panels.terminal", icon: Terminal },
  { id: "files", labelKey: "panels.files", icon: FolderTree },
  { id: "diff", labelKey: "panels.diff", icon: FileDiff },
];

const SHORTCUTS: Record<RightPanelTab, string> = {
  none: "",
  browser: "B",
  terminal: "T",
  files: "F",
  diff: "D",
  "pull-requests": "P",
};

const DISABLED_SURFACES = [
  {
    labelKey: "panels.pullRequests",
    shortcut: "P",
    reasonKey: "panels.surface.pullRequestReason",
  },
  {
    labelKey: "panels.surface.linkedPr",
    shortcut: "L",
    reasonKey: "panels.surface.linkedPrReason",
  },
  {
    labelKey: "panels.surface.device",
    shortcut: "M",
    reasonKey: "panels.surface.deviceReason",
  },
  {
    labelKey: "panels.surface.sideChat",
    shortcut: "S",
    reasonKey: "panels.surface.sideChatReason",
  },
] as const;

export function RightPanel({ width }: { width: number }) {
  const t = useT();
  const tab = useUiStore((s) => s.rightPanelTab);
  const setTab = useUiStore((s) => s.setRightPanelTab);
  const activeThreadId = useThreadsStore((s) => s.activeThreadId);

  useEffect(() => {
    // A file preview belongs to the thread it was opened from.
    useUiStore.setState({ filePreview: null });
  }, [activeThreadId]);

  return (
    <aside
      style={{ width }}
      className="glass-panel flex shrink-0 flex-col border-l border-border-subtle bg-panel"
    >
      <div className={`flex h-10 shrink-0 items-center pl-3 ${isTauri() ? "pr-[136px]" : "pr-3"}`}>
        {tab !== "none" && (
          <button
            type="button"
            aria-label={t("panels.backToSurfaces")}
            title={t("panels.backToSurfaces")}
            onClick={() => setTab("none")}
            className="flex h-7 w-7 items-center justify-center rounded-(--radius-sm) text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
          >
            <ChevronLeft size={16} />
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <Suspense
          fallback={<p className="p-3 text-xs text-text-tertiary">{t("panels.loading")}</p>}
        >
          {tab === "none" ? (
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 p-6">
              <p className="mb-3 text-sm font-medium text-text-primary">
                {t("panels.openSurface")}
              </p>
              {TABS.map(({ id, labelKey, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className="flex w-64 items-center gap-2 rounded-(--radius-sm) px-3 py-1.5 text-left text-sm text-text-secondary transition hover:bg-hover hover:text-text-primary"
                >
                  <Icon size={14} />
                  <span className="flex-1">{t(labelKey)}</span>
                  <kbd className="rounded border border-border-subtle px-1 font-mono text-xs text-text-tertiary">
                    {SHORTCUTS[id]}
                  </kbd>
                </button>
              ))}
              {DISABLED_SURFACES.map((surface) => (
                <button
                  key={surface.labelKey}
                  type="button"
                  disabled
                  title={t(surface.reasonKey)}
                  className="flex w-64 items-center gap-2 rounded-(--radius-sm) px-3 py-1.5 text-left text-sm text-text-tertiary opacity-60"
                >
                  <span className="flex-1">{t(surface.labelKey)}</span>
                  <kbd className="rounded border border-border-subtle px-1 font-mono text-xs">
                    {surface.shortcut}
                  </kbd>
                </button>
              ))}
            </div>
          ) : tab === "diff" ? (
            <DiffPanel key={activeThreadId ?? "none"} threadId={activeThreadId} />
          ) : tab === "browser" ? (
            <BrowserPanel threadId={activeThreadId} />
          ) : tab === "terminal" ? (
            <TerminalPanel threadId={activeThreadId} />
          ) : tab === "pull-requests" ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <PullRequestsList />
            </div>
          ) : (
            <FilesPanel key={activeThreadId ?? "none"} threadId={activeThreadId} />
          )}
        </Suspense>
      </div>
    </aside>
  );
}
