import { describe, expect, it } from "vitest";
import {
  collectNativeSubagents,
  isNativeSubagentItem,
  nativeSubagentInfo,
} from "../src/lib/nativeSubagents";
import type { ToolChatItem } from "../src/stores/runs";

const tool = (overrides: Partial<ToolChatItem> = {}): ToolChatItem => ({
  type: "tool",
  toolCallId: "t1",
  title: "Task",
  kind: "think",
  status: "completed",
  locations: [],
  ...overrides,
});

describe("native subagent meta", () => {
  it("stays honest without explicit meta", () => {
    expect(nativeSubagentInfo(tool())).toBeNull();
    expect(nativeSubagentInfo(tool({ meta: { unrelated: true } }))).toBeNull();
    expect(isNativeSubagentItem(tool({ meta: { parentToolUseId: "p" } }))).toBe(true);
  });

  it("reads known parent ids from top-level and nested meta", () => {
    expect(nativeSubagentInfo(tool({ meta: { parentToolUseId: "p1" } }))).toMatchObject({
      parentToolUseId: "p1",
    });
    expect(
      nativeSubagentInfo(
        tool({
          meta: {
            "claude-code": {
              parent_tool_use_id: "p2",
              subagent_type: "review",
              model: "sonnet",
            },
          },
        }),
      ),
    ).toMatchObject({ parentToolUseId: "p2", title: "review", model: "sonnet" });
  });

  it("groups nested steps by parent id", () => {
    const groups = collectNativeSubagents([
      tool({ toolCallId: "a", meta: { parentToolUseId: "p1" } }),
      tool({ toolCallId: "b", meta: { subagent: { parentId: "p1" } } }),
      tool({ toolCallId: "c", meta: { parentToolUseId: "p2" } }),
      tool({ toolCallId: "plain" }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].steps.map((step) => step.toolCallId)).toEqual(["a", "b"]);
    expect(groups[1].steps.map((step) => step.toolCallId)).toEqual(["c"]);
  });
});
