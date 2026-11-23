// Mock Pi RPC agent for driver tests. Strict LF framing: U+2028/U+2029 are
// legal inside JSON strings and must not split records.

let buffer = "";
process.stdin.setEncoding("utf8");

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respond(id, command, data) {
  send({ id, type: "response", command, success: true, data });
}

function handle(command) {
  switch (command.type) {
    case "get_state":
      respond(command.id, "get_state", {
        sessionId: "pi-mock",
        model: { id: "mock-model" },
        isStreaming: false,
        messageCount: 0,
      });
      return;
    case "new_session":
      respond(command.id, "new_session", { cancelled: false });
      return;
    case "prompt":
      respond(command.id, "prompt", { disposition: "started" });
      send({ type: "agent_start" });
      send({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "pondering" },
      });
      send({
        type: "message_update",
        assistantMessageEvent: {
          type: "text_delta",
          delta: `Hello\u2028line\u2029para`,
        },
      });
      send({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "bash",
        args: { command: "ls" },
      });
      send({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "bash",
        result: { output: "ok" },
        isError: false,
      });
      send({ type: "agent_end", messages: [], aborted: false });
      return;
    case "abort":
      respond(command.id, "abort", undefined);
      send({ type: "agent_end", messages: [], aborted: true });
      return;
    default:
      send({
        id: command.id,
        type: "response",
        command: command.type,
        success: false,
        error: "unknown command",
      });
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).replace(/\r$/, "");
    buffer = buffer.slice(index + 1);
    if (line.trim() !== "") handle(JSON.parse(line));
    index = buffer.indexOf("\n");
  }
});
