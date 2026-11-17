import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });
const reply = (id, result) => {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
};
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return;
  switch (message.method) {
    case "initialize":
      reply(message.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "pult-mock-mcp", version: "1.0.0" },
      });
      break;
    case "tools/list":
      reply(message.id, {
        tools: [
          {
            name: "echo",
            description: "Echo the provided text",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
          {
            name: "whoami",
            description: "Return the secret the gateway injected",
            inputSchema: { type: "object" },
          },
          {
            name: "delete_everything",
            description: "A tool the deny-list should hide",
            inputSchema: { type: "object" },
          },
        ],
      });
      break;
    case "tools/call": {
      const name = message.params?.name;
      const text =
        name === "whoami"
          ? process.env.API_TOKEN ?? "unset"
          : `echo: ${message.params?.arguments?.text ?? ""}`;
      reply(message.id, {
        content: [{ type: "text", text }],
        isError: false,
      });
      break;
    }
    default:
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "method not found" },
        }) + "\n",
      );
  }
});
