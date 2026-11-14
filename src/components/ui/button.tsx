import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "danger_outline";
type ButtonSize = "sm" | "md";

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-(--accent-hover) active:brightness-95",
  secondary: "bg-surface-raised text-text-primary border border-border-strong hover:bg-hover",
  ghost: "text-text-secondary hover:bg-hover hover:text-text-primary",
  danger: "bg-danger text-white hover:brightness-110",
  danger_outline: "border border-danger/40 bg-transparent text-danger hover:bg-danger/10",
};

const SIZE_CLASSES: Record<ButtonSize, string> = {
  sm: "h-6 px-2 text-xs gap-1 rounded-(--radius-sm)",
  md: "h-8 px-3 text-sm gap-1.5 rounded-(--radius-md)",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", className = "", children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`inline-flex select-none items-center justify-center font-medium transition-colors duration-150 focus-visible:shadow-(--focus-ring) focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 ${VARIANT_CLASSES[variant]} ${SIZE_CLASSES[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
});
