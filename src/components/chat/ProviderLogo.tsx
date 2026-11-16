import type { ReactElement } from "react";
import type { DetectedAgent, InstanceInfo } from "../../lib/types";
import claudeLogo from "../../assets/providers/claude.svg";
import openaiLogo from "../../assets/providers/openai.svg";
import geminiLogo from "../../assets/providers/gemini.svg";
import opencodeLogo from "../../assets/providers/opencode.svg";
import antigravityLogo from "../../assets/editors/antigravity.svg";
import cursorLogo from "../../assets/providers/cursor.svg";
import grokLogo from "../../assets/providers/grok.svg";
import museLogo from "../../assets/providers/muse.svg";
import piLogo from "../../assets/providers/pi.svg";

export type ProviderBrand =
  | "claude"
  | "codex"
  | "gemini"
  | "antigravity"
  | "opencode"
  | "cursor"
  | "grok"
  | "muse"
  | "pi"
  | "mock"
  | "custom";

type ProviderIdentity = Pick<InstanceInfo, "id" | "driver" | "displayName" | "command" | "args">;

/** Detected CLIs are not instances yet, but the logo only needs their identity. */
export function providerIdentity(agent: DetectedAgent): ProviderIdentity {
  return {
    id: agent.suggestedInstanceId,
    driver: "acp",
    displayName: agent.displayName,
    command: agent.command,
    args: agent.suggestedCommand ?? [],
  };
}

/** Real instances all use driver "acp"; the binary/name identifies the brand. */
export function detectProviderBrand(inst: ProviderIdentity): ProviderBrand {
  const haystack = [inst.id, inst.driver, inst.displayName, inst.command, ...inst.args]
    .join(" ")
    .toLowerCase();
  if (haystack.includes("claude") || haystack.includes("anthropic")) return "claude";
  if (haystack.includes("codex") || haystack.includes("openai") || haystack.includes("gpt")) {
    return "codex";
  }
  if (haystack.includes("antigravity") || haystack.includes("agy_acp_server")) {
    return "antigravity";
  }
  if (haystack.includes("gemini")) return "gemini";
  if (haystack.includes("opencode")) return "opencode";
  if (haystack.includes("cursor")) return "cursor";
  if (haystack.includes("grok")) return "grok";
  if (haystack.includes("muse")) return "muse";
  if (/\bpi\b/.test(haystack)) return "pi";
  if (inst.driver === "mock" || haystack.includes("mock")) return "mock";
  return "custom";
}

const BRAND_LOGOS: Partial<Record<ProviderBrand, string>> = {
  claude: claudeLogo,
  codex: openaiLogo,
  gemini: geminiLogo,
  antigravity: antigravityLogo,
  opencode: opencodeLogo,
  cursor: cursorLogo,
  grok: grokLogo,
  muse: museLogo,
  pi: piLogo,
};

/** Bundled brand marks (no remote assets); custom agents fall back to a monogram. */
export function ProviderLogo({
  instance,
  className = "h-4 w-4 shrink-0",
}: {
  instance: ProviderIdentity | null | undefined;
  className?: string;
}): ReactElement {
  if (!instance) {
    return <BotMark className={className} brand="mock" />;
  }
  const brand = detectProviderBrand(instance);
  const logo = BRAND_LOGOS[brand];
  if (logo) {
    return (
      <img
        src={logo}
        alt=""
        aria-hidden
        data-provider-logo={brand}
        className={`${className} object-contain`}
      />
    );
  }
  if (brand === "mock") {
    return <BotMark className={className} brand="mock" />;
  }
  return (
    <span
      data-provider-logo="custom"
      aria-hidden
      className={`${className} flex items-center justify-center rounded-[4px] bg-active text-xs font-semibold text-text-secondary`}
    >
      {instance.displayName.slice(0, 1).toUpperCase()}
    </span>
  );
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
