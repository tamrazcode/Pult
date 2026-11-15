import { useEffect, useMemo, useState } from "react";
import { parseDiffLines, toSplitRows } from "../../lib/diffSplit";
import type { DiffLine } from "../../lib/diffSplit";

export const MAX_INITIAL_DIFF_LINES = 2000;

const LINE_CLASSES: Record<DiffLine["kind"], string> = {
  add: "bg-diff-add-bg text-diff-add-fg",
  del: "bg-diff-del-bg text-diff-del-fg",
  context: "",
  hunk: "text-text-tertiary bg-active/60",
  meta: "text-text-tertiary",
};

function LineNo({ n }: { n: number | null }) {
  return (
    <span className="tnum w-10 shrink-0 select-none pr-2 text-right text-xs text-text-tertiary/70">
      {n ?? ""}
    </span>
  );
}

/** One line cell (left or right column); `line` may be absent (gap). */
function LineCell({ line, emptyCopy }: { line: DiffLine | null; emptyCopy?: string }) {
  if (!line) {
    return (
      <span className="flex min-w-0 flex-1 bg-surface/40">
        <span className="w-10 shrink-0" />
        <span className="whitespace-pre">{emptyCopy ?? ""}</span>
      </span>
    );
  }
  return (
    <span className={`flex min-w-0 flex-1 ${LINE_CLASSES[line.kind]}`}>
      {line.kind !== "meta" && line.kind !== "hunk" && <LineNo n={line.oldNo ?? line.newNo} />}
      <span className="truncate whitespace-pre">
        {line.kind === "add" || line.kind === "del" ? (
          <span className="select-none pr-1 opacity-70">{line.kind === "add" ? "+" : "−"}</span>
        ) : null}
        {line.text || " "}
      </span>
    </span>
  );
}

export function UnifiedLines({ raw }: { raw: string }) {
  const lines = useMemo(() => parseDiffLines(raw), [raw]);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [raw]);
  const visible = showAll ? lines : lines.slice(0, MAX_INITIAL_DIFF_LINES);
  return (
    <div className="overflow-x-auto py-1 font-mono text-[13px] leading-[22px]">
      {visible.map((line, i) => (
        <div key={i} data-diff-line-row className={`flex px-2 ${LINE_CLASSES[line.kind]}`}>
          {line.kind !== "meta" && line.kind !== "hunk" && (
            <>
              <LineNo n={line.oldNo} />
              <LineNo n={line.newNo} />
            </>
          )}
          <span className="truncate whitespace-pre">
            {line.kind === "add" || line.kind === "del" ? (
              <span className="select-none pr-1 opacity-70">{line.kind === "add" ? "+" : "−"}</span>
            ) : null}
            {line.text || " "}
          </span>
        </div>
      ))}
      {!showAll && lines.length > MAX_INITIAL_DIFF_LINES && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mx-2 my-1 rounded-(--radius-sm) border border-border-subtle px-2 py-1 text-xs text-text-secondary hover:bg-hover"
        >
          Show all {lines.length.toLocaleString("en-US")} lines
        </button>
      )}
    </div>
  );
}

export function SplitLines({ raw }: { raw: string }) {
  const rows = useMemo(() => toSplitRows(parseDiffLines(raw)), [raw]);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [raw]);
  const visible = showAll ? rows : rows.slice(0, MAX_INITIAL_DIFF_LINES);
  return (
    <div className="grid grid-cols-2 divide-x divide-border-subtle overflow-x-auto py-1 font-mono text-[13px] leading-[22px]">
      {visible.map((row, i) => (
        <div key={i} data-diff-line-row className="contents">
          <div className="flex min-w-0 px-2">
            <LineCell line={row.left} />
          </div>
          <div className="flex min-w-0 px-2">
            <LineCell line={row.right} />
          </div>
        </div>
      ))}
      {!showAll && rows.length > MAX_INITIAL_DIFF_LINES && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="col-span-2 mx-2 my-1 rounded-(--radius-sm) border border-border-subtle px-2 py-1 text-xs text-text-secondary hover:bg-hover"
        >
          Show all {rows.length.toLocaleString("en-US")} lines
        </button>
      )}
    </div>
  );
}
