import type { ReactNode } from "react";

type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-hover text-text-secondary border-border-subtle",
  accent: "bg-mention-bg text-accent border-transparent",
  success: "bg-transparent text-success border-success/40",
  warning: "bg-transparent text-warning border-warning/40",
  danger: "bg-transparent text-danger border-danger/40",
};

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-1.5 py-px text-xs leading-4 font-medium ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}
