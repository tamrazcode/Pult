import { useMemo } from "react";
import { Composer } from "./Composer";
import { NewThreadOptionsStrip } from "./NewThreadOptionsStrip";

/** Halftone-ish terrain of characters; deterministic so it never flickers. */
function asciiBackdrop(): string {
  const rows: string[] = [];
  for (let y = 0; y < 34; y += 1) {
    let row = "";
    for (let x = 0; x < 150; x += 1) {
      const wave = Math.sin(x * 0.11 + y * 0.17) + Math.cos(x * 0.07 - y * 0.23);
      const ridge = Math.sin((x + y) * 0.04) * 0.6;
      const value = wave + ridge;
      row += value > 1.15 ? "+" : value > 0.35 ? "·" : value > -0.4 ? "." : " ";
    }
    rows.push(row);
  }
  return rows.join("\n");
}

/** The app mark: chevron + bar, matching the desktop icon. */
function PultMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden fill="none">
      <path
        d="M13 14 33 34 13 54"
        stroke="currentColor"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M45 16v32" stroke="currentColor" strokeWidth="9" strokeLinecap="round" />
    </svg>
  );
}

/** First-run screen: logo, prompt, composer, and a quiet ASCII texture. */
export function NewChatEmptyState() {
  const backdrop = useMemo(asciiBackdrop, []);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto">
      <pre
        aria-hidden
        className="pointer-events-none absolute inset-0 flex select-none items-center justify-center font-mono text-[10px] leading-[1.4] whitespace-pre text-text-tertiary/[0.08] [mask-image:radial-gradient(ellipse_at_center,rgba(0,0,0,0.35),black_72%)]"
      >
        {backdrop}
      </pre>
      <div className="relative z-10 w-full -translate-y-3 py-10">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center px-6 text-center">
          <PultMark className="h-11 w-11 text-accent" />
          <h1 className="mt-5 text-2xl font-medium tracking-tight text-text-primary">
            What should we do in Pult?
          </h1>
          <p className="mt-1.5 max-w-md text-sm text-text-tertiary">
            Describe a task, pick a folder, and let the agent take it from there.
          </p>
        </div>
        <div className="mt-7">
          <NewThreadOptionsStrip />
          <Composer />
        </div>
      </div>
    </div>
  );
}
