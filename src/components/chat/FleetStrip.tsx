import { plural, useT } from "../../lib/i18n";
import { isTaskActive, useThreadSubagents } from "../../stores/subagents";
import { useUiStore } from "../../stores/ui";
import { ThinkingAscii } from "./MessagesTimeline";

/**
 * A fleet is only a fleet at two: one child already has a card, a crowd needs
 * a single hairline that says how much work is running and where to look.
 */
export function FleetStrip({ threadId }: { threadId: string }) {
  const t = useT();
  const tasks = useThreadSubagents(threadId);
  const activeTasks = tasks.filter((task) => isTaskActive(task.status));
  if (activeTasks.length < 2) return null;
  return (
    <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-1.5 text-xs text-text-secondary">
      <ThinkingAscii />
      <span className="font-medium text-text-primary">
        {plural("chat.fleet.working", activeTasks.length)}
      </span>
      <span className="min-w-0 flex-1 truncate text-text-tertiary">
        {activeTasks.map((task) => task.title).join(" · ")}
      </span>
      <button
        type="button"
        onClick={() => useUiStore.getState().setRightPanelTab("diff")}
        className="shrink-0 text-xs text-text-tertiary transition hover:text-text-primary"
      >
        {t("chat.fleet.viewDiff")}
      </button>
    </div>
  );
}
