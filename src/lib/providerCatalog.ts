import type { ProviderBrand } from "../components/chat/ProviderLogo";

/** Providers shown in the Add provider grid, installed or not. */
export interface ProviderCatalogEntry {
  id: string;
  displayName: string;
  description: string;
  brand: ProviderBrand;
  /** DetectedAgent.suggestedInstanceId, when the CLI is on PATH. */
  detectedId: string;
  command: string;
  args: string[];
  /** No ACP path yet: the row is visible but cannot be added as ACP. */
  adapterRequired?: boolean;
  experimental?: boolean;
}

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    id: "codex",
    displayName: "Codex",
    description: "OpenAI's coding agent through the official ACP bridge.",
    brand: "codex",
    detectedId: "codex",
    command: "codex",
    args: [],
  },
  {
    id: "claude-code",
    displayName: "Claude",
    description: "Anthropic's Claude Code through the community ACP adapter.",
    brand: "claude",
    detectedId: "claude-code",
    command: "claude",
    args: [],
  },
  {
    id: "cursor",
    displayName: "Cursor",
    description: "Cursor CLI in ACP mode. Experimental; requires a recent CLI.",
    brand: "cursor",
    detectedId: "cursor",
    command: "cursor-agent",
    args: ["acp"],
    experimental: true,
  },
  {
    id: "grok",
    displayName: "Grok",
    description: "xAI's Grok Build CLI over ACP.",
    brand: "grok",
    detectedId: "grok",
    command: "grok",
    args: ["agent", "stdio"],
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    description: "OpenCode speaks ACP natively.",
    brand: "opencode",
    detectedId: "opencode",
    command: "opencode",
    args: ["acp"],
  },
  {
    id: "antigravity",
    displayName: "Antigravity",
    description: "Google's Antigravity ACP server (installed by Pult or T3).",
    brand: "antigravity",
    detectedId: "antigravity",
    command: "agy_acp_server",
    args: [],
  },
  {
    id: "muse",
    displayName: "Muse Code",
    description: "Muse Code ACP (>= 1.4.16). Experimental.",
    brand: "muse",
    detectedId: "muse",
    command: "muse",
    args: ["acp"],
    experimental: true,
  },
  {
    id: "pi",
    displayName: "Pi",
    description: "Pi uses its own RPC protocol; the ACP adapter is not implemented yet.",
    brand: "pi",
    detectedId: "pi",
    command: "pi",
    args: ["--mode", "rpc"],
    adapterRequired: true,
  },
];
