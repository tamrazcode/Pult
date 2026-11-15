import type { ReactElement } from "react";
import type { InstanceInfo } from "../../lib/types";

export type ProviderBrand = "claude" | "codex" | "gemini" | "opencode" | "mock" | "custom";

type ProviderIdentity = Pick<InstanceInfo, "id" | "driver" | "displayName" | "command" | "args">;

/** Real instances all use driver "acp"; the binary/name identifies the brand. */
export function detectProviderBrand(inst: ProviderIdentity): ProviderBrand {
  const haystack = [inst.id, inst.driver, inst.displayName, inst.command, ...inst.args]
    .join(" ")
    .toLowerCase();
  if (haystack.includes("claude") || haystack.includes("anthropic")) return "claude";
  if (haystack.includes("codex") || haystack.includes("openai") || haystack.includes("gpt")) {
    return "codex";
  }
  if (haystack.includes("gemini") || haystack.includes("antigravity")) return "gemini";
  if (haystack.includes("opencode")) return "opencode";
  if (inst.driver === "mock" || haystack.includes("mock")) return "mock";
  return "custom";
}

/** Small inline provider marks; no remote assets or icon dependency. */
export function ProviderLogo({
  instance,
  className = "h-3.5 w-3.5 shrink-0",
}: {
  instance: ProviderIdentity | null | undefined;
  className?: string;
}): ReactElement {
  if (!instance) {
    return <BotMark className={className} brand="mock" />;
  }
  const brand = detectProviderBrand(instance);
  switch (brand) {
    case "claude":
      return (
        <svg viewBox="0 0 24 24" data-provider-logo="claude" aria-hidden className={className}>
          <g stroke="#d97757" strokeWidth="2.1" strokeLinecap="round">
            <path d="M12 2.5v19M2.5 12h19M5.3 5.3l13.4 13.4M18.7 5.3 5.3 18.7" />
          </g>
        </svg>
      );
    case "codex":
      return (
        <svg
          viewBox="0 0 24 24"
          data-provider-logo="codex"
          aria-hidden
          className={className}
          fill="none"
          stroke="#10a37f"
          strokeWidth="1.8"
          strokeLinejoin="round"
        >
          <path d="M12 2.4 20.3 7v10L12 21.6 3.7 17V7z" />
          <path d="m8.2 9.2 3.8-2.2 3.8 2.2v4.4L12 15.8l-3.8-2.2z" />
        </svg>
      );
    case "gemini":
      return (
        <svg viewBox="0 0 24 24" data-provider-logo="gemini" aria-hidden className={className}>
          <path
            d="M12 1.6c.7 5.5 4.9 9.7 10.4 10.4-5.5.7-9.7 4.9-10.4 10.4C11.3 16.9 7.1 12.7 1.6 12 7.1 11.3 11.3 7.1 12 1.6Z"
            fill="#4285f4"
          />
          <path
            d="M12 7.1c.4 2.5 2.4 4.5 4.9 4.9-2.5.4-4.5 2.4-4.9 4.9-.4-2.5-2.4-4.5-4.9-4.9 2.5-.4 4.5-2.4 4.9-4.9Z"
            fill="#a142f4"
          />
        </svg>
      );
    case "opencode":
      return (
        <svg viewBox="0 0 24 24" data-provider-logo="opencode" aria-hidden className={className}>
          <rect x="2.5" y="3.5" width="19" height="17" rx="4" fill="#0ea5e9" />
          <path
            d="m7.2 8.5 3.1 3.5-3.1 3.5M12.2 15.5h4.6"
            fill="none"
            stroke="#fff"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "mock":
      return <BotMark className={className} brand="mock" />;
    default:
      return (
        <span
          data-provider-logo="custom"
          aria-hidden
          className={`${className} flex items-center justify-center rounded-[4px] bg-active text-[9px] font-semibold text-text-secondary`}
        >
          {instance.displayName.slice(0, 1).toUpperCase()}
        </span>
      );
  }
}

function BotMark({ className, brand }: { className: string; brand: ProviderBrand }): ReactElement {
  return (
    <svg viewBox="0 0 24 24" data-provider-logo={brand} aria-hidden className={className}>
      <rect
        x="4"
        y="7"
        width="16"
        height="12"
        rx="4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M12 3.5v3.5M8.5 12.5h.01M15.5 12.5h.01"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path d="M9 16h6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
