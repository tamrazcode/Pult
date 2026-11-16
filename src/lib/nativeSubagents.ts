import type { ChatItem, ToolChatItem } from "../stores/runs";

/** What a provider actually gave us, never guessed. */
export interface NativeSubagentInfo {
  parentToolUseId: string;
  title: string;
  model?: string;
}

export interface NativeSubagentGroup extends NativeSubagentInfo {
  key: string;
  steps: ToolChatItem[];
}

const PARENT_KEYS = ["parentToolUseId", "parent_tool_use_id", "parentId", "parent_id"];
const TITLE_KEYS = ["subagentType", "subagent_type", "agentName", "agent_name", "name", "title"];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Strict detector: a card exists only when the provider put an explicit
 * parent-tool id in `_meta`. No meta means the normal tool row stays, so
 * progress is never invented.
 */
export function nativeSubagentInfo(item: ToolChatItem): NativeSubagentInfo | null {
  const root = record(item.meta);
  if (!root) return null;
  for (const candidate of [
    root,
    record(root["claude-code"]),
    record(root["claude_code"]),
    record(root.subagent),
    record(root.native),
  ]) {
    if (!candidate) continue;
    const parent = PARENT_KEYS.map((key) => candidate[key]).find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    if (!parent) continue;
    const title =
      TITLE_KEYS.map((key) => candidate[key]).find(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      ) ?? item.title;
    const model = [candidate.model, candidate.modelId, root.model].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    return { parentToolUseId: parent, title, model };
  }
  return null;
}

export function isNativeSubagentItem(item: ChatItem): boolean {
  return item.type === "tool" && nativeSubagentInfo(item) !== null;
}

/** One group per `parentToolUseId`, preserving transcript order. */
export function collectNativeSubagents(items: ChatItem[]): NativeSubagentGroup[] {
  const groups = new Map<string, NativeSubagentGroup>();
  for (const item of items) {
    if (item.type !== "tool") continue;
    const info = nativeSubagentInfo(item);
    if (!info) continue;
    const existing = groups.get(info.parentToolUseId);
    if (existing) {
      existing.steps.push(item);
    } else {
      groups.set(info.parentToolUseId, {
        ...info,
        key: info.parentToolUseId,
        steps: [item],
      });
    }
  }
  return [...groups.values()];
}
