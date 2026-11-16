import { useState } from "react";
import { ChevronDown, ChevronRight, Layers } from "lucide-react";
import type { DelegatedTask } from "../../lib/types";
import { isTaskActive } from "../../stores/subagents";
import { ProviderLogo } from "./ProviderLogo";
import { SubagentCard } from "./SubagentCard";

/** Two or more siblings in one parent run collapse into one stack row. */
export function SubagentGroupCard({ tasks }: { tasks: DelegatedTask[] }) {
  const [open, setOpen] = useState(false);
  const active = tasks.filter((task) => isTaskActive(task.status)).length;
  const failed = tasks.filter((task) => task.status === "failed").length;

  return (
    <div
      data-subagent-group
      className="rounded-(--radius-md) border border-border-subtle bg-surface"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-hover"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Layers size={13} className="text-text-tertiary" />
        <div className="flex items-center">
          {tasks.slice(0, 4).map((task, index) => (
            <span
              key={task.taskId}
              className="flex h-5 w-5 items-center justify-center rounded-full border border-border-subtle bg-canvas"
              style={{ marginLeft: index === 0 ? 0 : -6 }}
            >
              <ProviderLogo
                instance={{
                  id: task.targetInstanceId,
                  driver: "acp",
                  displayName: task.targetInstanceId,
                  command: task.targetInstanceId,
                  args: [],
                }}
                className="h-3.5 w-3.5"
              />
            </span>
          ))}
        </div>
        <span className="min-w-0 flex-1 truncate text-sm text-text-primary">
          {tasks.length} subagents
        </span>
        <span className={`shrink-0 text-xs ${failed > 0 ? "text-danger" : "text-text-tertiary"}`}>
          {active > 0 ? `${active} working` : failed > 0 ? `${failed} failed` : "done"}
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 border-t border-border-subtle p-2">
          {tasks.map((task) => (
            <SubagentCard key={task.taskId} task={task} />
          ))}
        </div>
      )}
    </div>
  );
}
