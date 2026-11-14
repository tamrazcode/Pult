import type { ReactNode } from "react";

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-(--radius-sm) border border-border-subtle bg-surface px-1 font-mono text-xs text-text-tertiary">
      {children}
    </kbd>
  );
}
