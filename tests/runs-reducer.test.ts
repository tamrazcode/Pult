import { describe, expect, it } from "vitest";
import { applyRunEvent, emptyRunView } from "../src/stores/runs";
import type { RunView } from "../src/stores/runs";
import type { AppEvent, PlanEntry } from "../src/lib/types";

let seq = 0;
function meta() {
  seq += 1;
  return { id: `run-1-${seq}`, runId: "run-1", seq, ts: 1_700_000_000_000 };
}

const userMessage = (text: string): AppEvent => ({
  ...meta(),
  kind: "user_message",
  payload: { text, images: [] },
});
const messageDelta = (delta: string): AppEvent => ({
  ...meta(),
  kind: "agent_message_delta",
  payload: { delta },
});
const thoughtDelta = (delta: string): AppEvent => ({
  ...meta(),
  kind: "agent_thought_delta",
  payload: { delta },
});
const toolCall = (toolCallId: string, status = "in_progress"): AppEvent => ({
  ...meta(),
  kind: "tool_call",
  payload: {
    toolCallId,
    title: `Tool ${toolCallId}`,
    kind: "read",
    status,
    locations: ["/repo/a.rs"],
  },
});
const toolUpdate = (
  toolCallId: string,
  patch: { status?: string; rawOutput?: unknown },
): AppEvent => ({
  ...meta(),
  kind: "tool_call_update",
  payload: { toolCallId, ...patch },
});
const plan = (entries: PlanEntry[]): AppEvent => ({
  ...meta(),
  kind: "plan",
  payload: { entries },
});
const approvalRequest = (requestId: string): AppEvent => ({
  ...meta(),
  kind: "approval_request",
  payload: {
    requestId,
    toolCallId: null,
    title: "Allow the edit?",
    options: [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ],
  },
});
const approvalResponse = (requestId: string): AppEvent => ({
  ...meta(),
  kind: "approval_response",
  payload: { requestId, optionId: "allow" },
});
const runFinished = (stopReason: string, error?: string): AppEvent => ({
  ...meta(),
  kind: "run_finished",
  payload: { stopReason, error },
});
const compaction = (
  payload: Partial<{
    status: string | null;
    compactionId: string | null;
    summaryReplace: string | null;
    summaryAppend: string | null;
  }>,
): AppEvent => ({
  ...meta(),
  kind: "compaction",
  payload,
});

describe("applyRunEvent", () => {
  it("accumulates message deltas into a single assistant item", () => {
    let view: RunView = emptyRunView(true);
    view = applyRunEvent(view, messageDelta("Hel"));
    view = applyRunEvent(view, messageDelta("lo, "));
    view = applyRunEvent(view, messageDelta("world"));
    expect(view.items).toEqual([
      { type: "assistant", text: "Hello, world", streaming: true, ts: 1_700_000_000_000 },
    ]);
    expect(view.streaming).toBe(true);
  });

  it("starts a new assistant item when text resumes after a tool row", () => {
    let view = emptyRunView(true);
    view = applyRunEvent(view, messageDelta("before tool"));
    view = applyRunEvent(view, toolCall("t1"));
    view = applyRunEvent(view, messageDelta("after tool"));
    expect(view.items.map((i) => i.type)).toEqual(["assistant", "tool", "assistant"]);
    const [first] = view.items;
    expect(first.type === "assistant" && first.streaming).toBe(false);
  });

  it("accumulates thought deltas into thought items, dimmed model", () => {
    let view = emptyRunView(true);
    view = applyRunEvent(view, thoughtDelta("think"));
    view = applyRunEvent(view, thoughtDelta("ing"));
    const [thought] = view.items;
    expect(thought.type === "thought" && thought.text === "thinking").toBe(true);
  });

  it("patches a tool row in place on tool_call_update", () => {
    let view = emptyRunView(true);
    view = applyRunEvent(view, toolCall("t1"));
    view = applyRunEvent(view, toolUpdate("t1", { status: "completed", rawOutput: { ok: true } }));
    const tools = view.items.filter((i) => i.type === "tool");
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    if (tool.type !== "tool") throw new Error("expected tool item");
    expect(tool.status).toBe("completed");
    expect(tool.rawOutput).toEqual({ ok: true });
    expect(tool.locations).toEqual(["/repo/a.rs"]);
  });

  it("replaces the plan wholesale", () => {
    let view = emptyRunView(true);
    view = applyRunEvent(view, plan([{ content: "step 1", status: "pending" }]));
    view = applyRunEvent(
      view,
      plan([
        { content: "step 1", status: "completed" },
        { content: "step 2", status: "in_progress" },
      ]),
    );
    expect(view.plan).toEqual([
      { content: "step 1", status: "completed" },
      { content: "step 2", status: "in_progress" },
    ]);
  });

  it("sets pendingApproval on approval_request and clears it on approval_response", () => {
    let view = emptyRunView(true);
    view = applyRunEvent(view, approvalRequest("req-1"));
    expect(view.pendingApproval?.requestId).toBe("req-1");
    expect(view.pendingApproval?.options).toHaveLength(2);
    view = applyRunEvent(view, approvalResponse("req-1"));
    expect(view.pendingApproval).toBeUndefined();
  });

  it("keeps pendingApproval when the response is for another request", () => {
    let view = emptyRunView(true);
    view = applyRunEvent(view, approvalRequest("req-1"));
    view = applyRunEvent(view, approvalResponse("req-other"));
    expect(view.pendingApproval?.requestId).toBe("req-1");
  });

  it("clears pendingApproval, stops streaming and records stopReason on run_finished", () => {
    let view = emptyRunView(true);
    view = applyRunEvent(view, messageDelta("partial"));
    view = applyRunEvent(view, approvalRequest("req-1"));
    view = applyRunEvent(view, runFinished("end_turn"));
    expect(view.streaming).toBe(false);
    expect(view.stopReason).toBe("end_turn");
    expect(view.pendingApproval).toBeUndefined();
    const texts = view.items.filter((i) => i.type === "assistant");
    expect(texts.every((i) => i.type !== "assistant" || !i.streaming)).toBe(true);
  });

  it("inserts a user bubble on user_message", () => {
    let view = emptyRunView(true);
    view = applyRunEvent(view, userMessage("fix the bug"));
    expect(view.items).toEqual([
      { type: "user", text: "fix the bug", images: [], ts: 1_700_000_000_000 },
    ]);
  });

  it("builds a compaction divider from chunks and status updates", () => {
    let view = emptyRunView(true);
    view = applyRunEvent(view, compaction({ compactionId: "c1", summaryAppend: "summary so far" }));
    view = applyRunEvent(view, compaction({ compactionId: "c1", summaryAppend: " continued" }));
    view = applyRunEvent(view, compaction({ compactionId: "c1", status: "completed" }));
    expect(view.items).toEqual([
      {
        type: "compaction",
        compactionId: "c1",
        status: "completed",
        summary: "summary so far continued",
        ts: 1_700_000_000_000,
      },
    ]);
  });

  it("summaryReplace overwrites the accumulated summary", () => {
    let view = emptyRunView(true);
    view = applyRunEvent(view, compaction({ compactionId: "c1", summaryAppend: "old" }));
    view = applyRunEvent(
      view,
      compaction({ compactionId: "c1", status: "completed", summaryReplace: "new" }),
    );
    const [item] = view.items;
    expect(item.type === "compaction" && item.summary === "new").toBe(true);
  });

  it("records run_finished failure detail", () => {
    let view = emptyRunView(true);
    view = applyRunEvent(view, runFinished("failed", "agent process exited"));
    expect(view.stopReason).toBe("failed");
    expect(view.error).toBe("agent process exited");
    let healthy = emptyRunView(true);
    healthy = applyRunEvent(healthy, runFinished("end_turn"));
    expect(healthy.error).toBeUndefined();
  });

  it("stores usage and mode_change without rendering items", () => {
    let view = emptyRunView(true);
    view = applyRunEvent(view, { ...meta(), kind: "usage", payload: { detail: { tokens: 42 } } });
    view = applyRunEvent(view, { ...meta(), kind: "mode_change", payload: { modeId: "code" } });
    expect(view.items).toEqual([]);
    expect(view.usage).toEqual({ tokens: 42 });
    expect(view.modeId).toBe("code");
  });
});
