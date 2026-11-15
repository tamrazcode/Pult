import { parseDiffLines, toSplitRows } from "../../lib/diffSplit";
import type { DiffLine, SplitRow } from "../../lib/diffSplit";

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
  const lines = parseDiffLines(raw);
  return (
    <div className="overflow-x-auto py-1 font-mono text-[13px] leading-[22px]">
      {lines.map((line, i) => (
        <div key={i} className={`flex px-2 ${LINE_CLASSES[line.kind]}`}>
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
    </div>
  );
}

export function SplitLines({ raw }: { raw: string }) {
  const rows: SplitRow[] = toSplitRows(parseDiffLines(raw));
  return (
    <div className="grid grid-cols-2 divide-x divide-border-subtle overflow-x-auto py-1 font-mono text-[13px] leading-[22px]">
      {rows.map((row, i) => (
        <div key={i} className="contents">
          <div className="flex min-w-0 px-2">
            <LineCell line={row.left} />
          </div>
          <div className="flex min-w-0 px-2">
            <LineCell line={row.right} />
          </div>
        </div>
      ))}
    </div>
  );
}
