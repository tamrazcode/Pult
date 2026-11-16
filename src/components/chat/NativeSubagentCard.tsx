import { useState } from "react";
import { ChevronDown, ChevronRight, Cpu } from "lucide-react";
import type { NativeSubagentGroup } from "../../lib/nativeSubagents";
import { useT } from "../../lib/i18n";

/** Read-only view of a provider-native subagent: only what `_meta` proved. */
export function NativeSubagentCard({ group }: { group: NativeSubagentGroup }) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <div
      data-native-subagent
      className="rounded-(--radius-md) border border-border-subtle bg-surface px-3 py-2.5"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 text-left"
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Cpu size={13} className="text-text-tertiary" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
          {group.title}
        </span>
        <span className="shrink-0 rounded-full bg-active px-2 py-0.5 text-xs text-text-tertiary">
          native
        </span>
      </button>
      {group.model && (
        <p className="mt-1 pl-9 font-mono text-xs text-text-tertiary">{group.model}</p>
      )}
      {open && (
        <div className="mt-2 flex flex-col gap-1 border-t border-border-subtle pt-2">
          {group.steps.map((step) => (
            <div key={step.toolCallId} className="flex items-center gap-2 pl-5 text-xs">
              <span className="min-w-0 flex-1 truncate text-text-secondary">{step.title}</span>
              <span className="shrink-0 font-mono text-text-tertiary">{step.status}</span>
            </div>
          ))}
          <p className="pl-5 text-xs text-text-tertiary">{t("subagents.readOnly")}</p>
        </div>
      )}
    </div>
  );
}
