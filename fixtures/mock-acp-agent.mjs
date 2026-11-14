#!/usr/bin/env node
/**
 * mock-acp-agent.mjs — a dependency-free ACP (Agent Client Protocol v1) mock agent.
 *
 * Speaks newline-delimited JSON-RPC 2.0 over stdio (one object per line).
 * Every wire shape is modeled strictly on protocol/acp-schema.json (ACP v1.31.0).
 *
 * Environment switches (failure modes):
 *   MOCK_DELAY_MS=<n>      inter-message delay in ms (default 25)
 *   MOCK_SLOW_TURN=1       stretch inter-message delays to 300ms
 *   MOCK_BAD_JSON=1        write a garbage line to stdout right after start
 *   MOCK_CRASH_MID_TURN=1  during the first prompt turn, crash right after
 *                          the first agent_message_chunk (exit code 1)
 *   MOCK_HANG=1            accept initialize/session/new but never answer
 *                          session/prompt
 */

import { createInterface } from "node:readline";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SLOW_TURN = process.env.MOCK_SLOW_TURN === "1";
const DELAY_MS = SLOW_TURN ? 300 : Number.parseInt(process.env.MOCK_DELAY_MS ?? "", 10) || 25;
const BAD_JSON = process.env.MOCK_BAD_JSON === "1";
const CRASH_MID_TURN = process.env.MOCK_CRASH_MID_TURN === "1";
const HANG = process.env.MOCK_HANG === "1";
const SPAWN_LOG = process.env.MOCK_SPAWN_LOG || "";

const PROTOCOL_VERSION = 1;
const AGENT_INFO = { name: "mock-acp-agent", version: "0.1.0" };

// ---- auth scenarios (env-gated so the default stays unlocked) ----
const AUTH_REQUIRED = process.env.MOCK_AUTH_REQUIRED === "1";
const AUTH_TERMINAL = process.env.MOCK_AUTH_TERMINAL === "1";
const AUTH_FAIL = process.env.MOCK_AUTH_FAIL === "1";
const AUTH_STILL_REQUIRED = process.env.MOCK_AUTH_STILL_REQUIRED === "1";
const AUTH_STATE_FILE = process.env.MOCK_AUTH_STATE_FILE || "";
let authUnlocked =
  !AUTH_REQUIRED &&
  !AUTH_TERMINAL ||
  (AUTH_STATE_FILE !== "" && existsSync(AUTH_STATE_FILE));

const AUTH_METHODS = AUTH_TERMINAL
  ? [
      {
        type: "terminal",
        id: "mock-term",
        name: "Terminal sign-in",
        args: ["--login"],
        env: { MOCK_LOGIN: "1" },
      },
    ]
  : AUTH_REQUIRED
    ? [
        {
          id: "mock-token",
          name: "Mock sign-in",
          description: "Sign in with the mock account",
        },
      ]
    : [];

function handleAuthenticate(id, params) {
  const methodId = params && params.methodId;
  if (AUTH_TERMINAL || (AUTH_REQUIRED && methodId !== "mock-token")) {
    sendError(id, -32602, `unknown auth method '${methodId}'`);
    return;
  }
  if (AUTH_FAIL) {
    sendError(id, -32603, "Authentication failed: invalid credentials");
    return;
  }
  if (!AUTH_STILL_REQUIRED) {
    authUnlocked = true;
    if (AUTH_STATE_FILE !== "") {
      try {
        writeFileSync(AUTH_STATE_FILE, "ok");
      } catch {
        // best effort: the in-process flag is what matters for this run
      }
    }
  }
  sendResult(id, {});
}

const READ_PATH = "/repo/src/main.rs";
const WRITE_PATH = "/repo/src/mock-out.txt";
const WRITE_CONTENT = "hello from mock";
const READ_FILE_SNIPPET = 'fn main() { println!("hello from mock"); }';

/** SessionModeState — schema $defs/SessionModeState (currentModeId + availableModes). */
const MODES = {
  currentModeId: "code",
  availableModes: [
    { id: "code", name: "Code", description: "Default" },
    { id: "architect", name: "Architect" },
  ],
};

/** PermissionOption list - schema $defs/PermissionOption (optionId, name, kind). */
const PERMISSION_OPTIONS = [
  { optionId: "mock-allow", name: "Allow", kind: "allow_once" },
  { optionId: "mock-allow-always", name: "Always allow", kind: "allow_always" },
  { optionId: "mock-reject", name: "Reject", kind: "reject_once" },
  { optionId: "mock-reject-always", name: "Always reject", kind: "reject_always" },
];

/** Per-session config state for session/set_config_option (model / effort / toggle). */
const SESSION_CONFIGS = new Map();

function sessionConfig(sessionId) {
  let config = SESSION_CONFIGS.get(sessionId);
  if (!config) {
    config = { model: "mock-fast", thought_level: "medium", web_search: false };
    SESSION_CONFIGS.set(sessionId, config);
  }
  return config;
}

function thoughtLevelsFor(model) {
  return model === "mock-v1" ? ["low", "medium"] : ["low", "medium", "high"];
}

function configOptionsFor(config) {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: config.model,
      options: [
        {
          group: "recommended",
          name: "Recommended",
          options: [
            { value: "mock-fast", name: "Mock Fast" },
            { value: "mock-pro", name: "Mock Pro" },
          ],
        },
        {
          group: "legacy",
          name: "Legacy",
          options: [{ value: "mock-v1", name: "Mock v1" }],
        },
      ],
    },
    {
      id: "thought_level",
      name: "Thought level",
      category: "thought_level",
      type: "select",
      currentValue: config.thought_level,
      options: thoughtLevelsFor(config.model).map((value) => ({
        value,
        name: value[0].toUpperCase() + value.slice(1),
      })),
    },
    {
      id: "web_search",
      name: "Web search",
      category: "other",
      type: "boolean",
      currentValue: config.web_search,
    },
  ];
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

function sendLine(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function logErr(msg) {
  process.stderr.write(`mock: ${msg}\n`);
}

function sendResult(id, result) {
  sendLine({ jsonrpc: "2.0", id, result: result === undefined ? {} : result });
}

function sendError(id, code, message) {
  sendLine({ jsonrpc: "2.0", id, error: { code, message } });
}

/** Agent -> client session/update notification (schema $defs/SessionNotification). */
function notifySessionUpdate(sessionId, update) {
  sendLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}

// ---------------------------------------------------------------------------
// Agent -> client requests ("agent-<n>" ids, increasing)
// ---------------------------------------------------------------------------

let agentRequestIdCounter = 0;
/** @type {Map<string, {resolve: Function, reject: Function}>} */
const pendingAgentRequests = new Map();

function agentRequest(method, params) {
  const id = `agent-${++agentRequestIdCounter}`;
  return new Promise((resolve, reject) => {
    pendingAgentRequests.set(id, {
      resolve: (value) => {
        pendingAgentRequests.delete(id);
        resolve(value);
      },
      reject: (err) => {
        pendingAgentRequests.delete(id);
        reject(err);
      },
    });
    sendLine({ jsonrpc: "2.0", id, method, params });
  });
}

function resolveAgentRequest(id, msg) {
  const entry = pendingAgentRequests.get(id);
  if (!entry) return false;
  if (Object.prototype.hasOwnProperty.call(msg, "error")) {
    entry.reject(new Error(`client returned error for ${id}: ${JSON.stringify(msg.error)}`));
  } else {
    entry.resolve(msg.result);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Cancellation machinery
// ---------------------------------------------------------------------------

class CancelledError extends Error {
  constructor() {
    super("turn cancelled");
    this.name = "CancelledError";
  }
}

/**
 * A turn tracks its own cancellation state; cancel hooks wake every pending
 * sleep/await so the sequence aborts promptly at the current step.
 */
function makeTurn() {
  return { cancelled: false, waiters: new Set() };
}

function signalCancel(turn) {
  if (!turn || turn.cancelled) return;
  turn.cancelled = true;
  for (const wake of turn.waiters) wake();
  turn.waiters.clear();
}

function checkpoint(turn) {
  if (turn.cancelled) throw new CancelledError();
}

function sleep(ms, turn) {
  return new Promise((resolve, reject) => {
    if (turn.cancelled) {
      reject(new CancelledError());
      return;
    }
    const wake = () => {
      clearTimeout(timer);
      turn.waiters.delete(wake);
      reject(new CancelledError());
    };
    const timer = setTimeout(() => {
      turn.waiters.delete(wake);
      resolve();
    }, ms);
    turn.waiters.add(wake);
  });
}

/** Await a promise, but bail out with CancelledError if the turn is cancelled first. */
function raceCancel(turn, promise) {
  if (turn.cancelled) return Promise.reject(new CancelledError());
  return new Promise((resolve, reject) => {
    const wake = () => reject(new CancelledError());
    turn.waiters.add(wake);
    promise.then(
      (value) => {
        turn.waiters.delete(wake);
        resolve(value);
      },
      (err) => {
        turn.waiters.delete(wake);
        reject(err);
      },
    );
  });
}

async function beat(turn) {
  await sleep(DELAY_MS, turn);
  checkpoint(turn);
}

// ---------------------------------------------------------------------------
// Session / turn state
// ---------------------------------------------------------------------------

let sessionCounter = 0;
const sessions = new Set();
let turnCounter = 0;
/** @type {Map<string, object>} sessionId -> in-flight turn */
const activeTurns = new Map();

function extractPromptText(prompt) {
  if (!Array.isArray(prompt)) return "";
  const block = prompt.find((b) => b && b.type === "text" && typeof b.text === "string");
  return block ? block.text : "";
}

/** Echo markers for image content blocks (promptCapabilities.image = true). */
function describeImages(prompt) {
  if (!Array.isArray(prompt)) return [];
  return prompt
    .filter((b) => b && b.type === "image")
    .map((b) => `[image ${b.mimeType || "unknown"} ${(b.data || "").length}b]`);
}

/** Split text into up to `parts` non-empty chunks. */
function splitEcho(text, parts) {
  const out = [];
  for (let i = 0; i < parts; i++) {
    const start = Math.round((i * text.length) / parts);
    const end = Math.round(((i + 1) * text.length) / parts);
    const piece = text.slice(start, end);
    if (piece) out.push(piece);
  }
  return out.length > 0 ? out : [text];
}

// ---------------------------------------------------------------------------
// Prompt turn sequence
// ---------------------------------------------------------------------------

let firstMessageChunkEmitted = false;

async function runTurn(sessionId, promptText, turnNumber, turn) {
  const t1 = `tool-${turnNumber}-1`;
  const t2 = `tool-${turnNumber}-2`;

  // 1. two agent_thought_chunk updates
  await beat(turn);
  notifySessionUpdate(sessionId, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: `Thinking about the request: "${promptText}".` },
  });
  await beat(turn);
  notifySessionUpdate(sessionId, {
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "Plan: read the file, ask permission, write a mock edit." },
  });

  // 2. plan update (3 entries: pending / in_progress / completed)
  await beat(turn);
  notifySessionUpdate(sessionId, {
    sessionUpdate: "plan",
    entries: [
      { content: "Locate the entry point", priority: "high", status: "pending" },
      { content: `Read ${READ_PATH}`, priority: "medium", status: "in_progress" },
      { content: "Apply the mock edit", priority: "low", status: "completed" },
    ],
  });

  // 3. tool_call (read) in_progress, then tool_call_update completed
  await beat(turn);
  notifySessionUpdate(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: t1,
    title: `Read ${READ_PATH}`,
    name: "read_file",
    kind: "read",
    status: "in_progress",
    locations: [{ path: READ_PATH }],
  });
  await beat(turn);
  notifySessionUpdate(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId: t1,
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: READ_FILE_SNIPPET } }],
  });

  // 4. fs/read_text_file round-trip; echo the client's content back
  await beat(turn);
  const readResp = await raceCancel(
    turn,
    agentRequest("fs/read_text_file", { sessionId, path: READ_PATH }).catch(
      (err) => ({ error: String(err && err.message ? err.message : err) }),
    ),
  );
  // A typed fs error (missing file, sandbox rejection) must not kill the
  // turn: real agents report the failure and keep working.
  const fileContent =
    readResp && typeof readResp.content === "string"
      ? readResp.content
      : `(read failed: ${readResp && readResp.error ? readResp.error : "unknown"})`;
  checkpoint(turn);
  notifySessionUpdate(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: {
      type: "text",
      text: `Read ${READ_PATH} via client fs: ${fileContent}`,
    },
  });
  if (CRASH_MID_TURN && turnNumber === 1 && !firstMessageChunkEmitted) {
    firstMessageChunkEmitted = true;
    logErr("simulated crash");
    process.exit(1);
  }

  // 5. session/request_permission round-trip for the edit
  await beat(turn);
  const permResp = await raceCancel(
    turn,
    agentRequest("session/request_permission", {
      sessionId,
      toolCall: {
        toolCallId: t2,
        title: `Edit ${WRITE_PATH}`,
        name: "edit_file",
        kind: "edit",
        status: "pending",
        locations: [{ path: WRITE_PATH }],
      },
      options: PERMISSION_OPTIONS,
    }),
  );
  checkpoint(turn);
  const outcome = permResp && typeof permResp.outcome === "object" ? permResp.outcome : null;
  if (outcome && outcome.outcome === "cancelled") {
    // Client reported the turn was cancelled while permission was pending.
    throw new CancelledError();
  }
  const selectedOptionId = outcome && outcome.outcome === "selected" ? outcome.optionId : null;
  const allowed =
    selectedOptionId === "mock-allow" || selectedOptionId === "mock-allow-always";

  await beat(turn);
  notifySessionUpdate(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId: t2,
    title: `Edit ${WRITE_PATH}`,
    name: "edit_file",
    kind: "edit",
    status: "in_progress",
    locations: [{ path: WRITE_PATH }],
  });

  if (allowed) {
    // 6. fs/write_text_file round-trip, then completed update with a diff
    await beat(turn);
    await raceCancel(
      turn,
      agentRequest("fs/write_text_file", {
        sessionId,
        path: WRITE_PATH,
        content: WRITE_CONTENT,
      }),
    );
    checkpoint(turn);
    await beat(turn);
    notifySessionUpdate(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: t2,
      status: "completed",
      content: [
        {
          type: "diff",
          path: WRITE_PATH,
          oldText: null,
          newText: WRITE_CONTENT,
        },
      ],
    });
    // M4 demo: on "commit" prompts the edit touches a TRACKED file (read →
    // append → write) and creates an UNTRACKED one, so the diff panel shows
    // both git diff projections. NOTE: fs paths map under the thread
    // workspace, so "/README.md" is the tracked repo-root file.
    if (/\bcommit\b/.test(promptText)) {
      await beat(turn);
      const readme = await raceCancel(
        turn,
        agentRequest("fs/read_text_file", { sessionId, path: "/README.md" }).catch(
          () => null,
        ),
      );
      const current =
        readme && typeof readme.content === "string" ? readme.content : "";
      await raceCancel(
        turn,
        agentRequest("fs/write_text_file", {
          sessionId,
          path: "/README.md",
          content: `${current}\nmock demo line ${turnNumber}\n`,
        }),
      );
      await beat(turn);
      await raceCancel(
        turn,
        agentRequest("fs/write_text_file", {
          sessionId,
          path: "/notes/pult-demo.md",
          content: `# pult demo\n\ncreated on turn ${turnNumber}\n`,
        }),
      );
    }
  } else {
    await beat(turn);
    notifySessionUpdate(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: t2,
      status: "failed",
    });
  }

  // 7. stream the prompt back in ~4 chunks; "commit" prompts carry a
  // suggested commit message the diff panel can prefill (M4).
  await beat(turn);
  const echoText =
    promptText + (allowed && /\bcommit\b/.test(promptText)
      ? "\n\nSuggested commit message: feat: mock demo changes"
      : "");
  const echoMessageId = `msg-${turnNumber}-echo`;
  for (const piece of splitEcho(echoText, 4)) {
    notifySessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: piece },
      messageId: echoMessageId,
    });
    await beat(turn);
  }

  // 7b. terminal callbacks (§5.5): create → poll output → wait_for_exit.
  // Wrapped in a tool_call row (kind execute) so the timeline and the M5
  // Terminal panel's agent mirror both have something to show.
  if (/\bterminal\b/.test(promptText)) {
    await beat(turn);
    const termToolId = `tool-${turnNumber}-terminal`;
    notifySessionUpdate(sessionId, {
      sessionUpdate: "tool_call",
      toolCallId: termToolId,
      title: "Run cmd /c echo mock-term-ok",
      name: "run_terminal",
      kind: "execute",
      status: "in_progress",
      locations: [],
    });
    const created = await raceCancel(
      turn,
      agentRequest("terminal/create", {
        sessionId,
        command: "cmd",
        args: ["/c", "echo mock-term-ok"],
        cwd: ".",
        outputByteLimit: 65536,
      }),
    );
    const terminalId = created && created.terminalId;
    let output = "";
    for (let i = 0; i < 20; i++) {
      await beat(turn);
      const snap = await raceCancel(
        turn,
        agentRequest("terminal/output", { sessionId, terminalId }),
      );
      output = snap && typeof snap.output === "string" ? snap.output : "";
      if (snap && snap.exitStatus) break;
    }
    const exited = await raceCancel(
      turn,
      agentRequest("terminal/wait_for_exit", { sessionId, terminalId }),
    );
    await raceCancel(
      turn,
      agentRequest("terminal/release", { sessionId, terminalId }),
    );
    const exitCode = exited && exited.exitCode != null ? exited.exitCode : -1;
    notifySessionUpdate(sessionId, {
      sessionUpdate: "tool_call_update",
      toolCallId: termToolId,
      status: "completed",
      rawOutput: { text: `${output.trim()} (exit ${exitCode})` },
    });
    notifySessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `terminal output: ${output.trim()} (exitCode:${exitCode})`,
      },
    });
  }

  // 7c. elicitation (§5.5): form mode with a typed schema; the answer's
  // content lands in the echo so tests can assert the round trip.
  if (/\bask me\b/.test(promptText)) {
    await beat(turn);
    const elicited = await raceCancel(
      turn,
      agentRequest("elicitation/create", {
        sessionId,
        message: "Pick a color",
        mode: "form",
        requestedSchema: {
          type: "object",
          title: "Colors",
          properties: {
            color: { type: "string", enum: ["red", "green", "blue"] },
          },
          required: ["color"],
        },
      }),
    );
    const picked =
      elicited && elicited.action === "accept" && elicited.content
        ? JSON.stringify(elicited.content)
        : `no answer (${elicited && elicited.action})`;
    notifySessionUpdate(sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `you picked ${picked}` },
    });
  }

  // 8. available_commands_update + session_info_update (thread auto-rename)
  await beat(turn);
  notifySessionUpdate(sessionId, {
    sessionUpdate: "available_commands_update",
    availableCommands: [
      { name: "mock-echo", description: "Echo the prompt" },
      { name: "mock-plan", description: "Show the mock plan" },
    ],
  });
  await beat(turn);
  notifySessionUpdate(sessionId, {
    sessionUpdate: "session_info_update",
    title: `Echo turn ${turnNumber}`,
  });

  // 8b. usage_update ($defs/UsageUpdate: used+size required, cost optional)
  await beat(turn);
  notifySessionUpdate(sessionId, {
    sessionUpdate: "usage_update",
    used: 120 + turnNumber,
    size: 200000,
    cost: { amount: 0.01, currency: "USD" },
  });

  // 9. notice (severity field per $defs/Notice; requires client session.notices)
  await beat(turn);
  notifySessionUpdate(sessionId, {
    sessionUpdate: "notice",
    severity: "info",
    title: "Mock turn complete",
    description: `Turn ${turnNumber} finished for session ${sessionId}.`,
  });

  // 10. respond to session/prompt
  sendResult(turn.promptRequestId, { stopReason: "end_turn" });
}

// ---------------------------------------------------------------------------
// Method handlers (client -> agent)
// ---------------------------------------------------------------------------

function handleInitialize(id) {
  if (SPAWN_LOG !== "") {
    try {
      appendFileSync(SPAWN_LOG, `${process.pid}\n`);
    } catch {
      // best-effort test logging
    }
  }
  sendResult(id, {
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: false },
    },
    authMethods: AUTH_METHODS,
    agentInfo: AGENT_INFO,
  });
}

function handleNewSession(id) {
  if (!authUnlocked) {
    sendError(id, -32000, "Authentication required");
    return;
  }
  const sessionId = `mock-session-${++sessionCounter}`;
  sessions.add(sessionId);
  sendResult(id, {
    sessionId,
    modes: MODES,
    configOptions: configOptionsFor(sessionConfig(sessionId)),
  });
}

function handleSetConfigOption(id, params) {
  const sessionId = params && params.sessionId;
  const configId = params && params.configId;
  const value = params && params.value;
  if (typeof sessionId !== "string" || !sessions.has(sessionId) || typeof configId !== "string") {
    sendError(id, -32602, "set_config_option: unknown session or config id");
    return;
  }
  const config = sessionConfig(sessionId);
  if (configId === "model") {
    if (typeof value !== "string" || !["mock-fast", "mock-pro", "mock-v1"].includes(value)) {
      sendError(id, -32602, `set_config_option: bad model '${value}'`);
      return;
    }
    config.model = value;
    if (!thoughtLevelsFor(value).includes(config.thought_level)) {
      config.thought_level = "medium";
    }
  } else if (configId === "thought_level") {
    const allowed = thoughtLevelsFor(config.model);
    if (typeof value !== "string" || !allowed.includes(value)) {
      sendError(id, -32602, `set_config_option: bad thought level '${value}'`);
      return;
    }
    config.thought_level = value;
  } else if (configId === "web_search") {
    if (params.type !== "boolean" || typeof value !== "boolean") {
      sendError(id, -32602, "set_config_option: web_search needs a boolean value");
      return;
    }
    config.web_search = value;
  } else {
    sendError(id, -32602, `set_config_option: unknown config '${configId}'`);
    return;
  }
  const configOptions = configOptionsFor(config);
  notifySessionUpdate(sessionId, {
    sessionUpdate: "config_option_update",
    configOptions,
  });
  sendResult(id, { configOptions });
}

function handleSetMode(id, params) {
  const modeId = params && typeof params.modeId === "string" ? params.modeId : null;
  sendResult(id, {});
  if (modeId && params && typeof params.sessionId === "string") {
    notifySessionUpdate(params.sessionId, {
      sessionUpdate: "current_mode_update",
      currentModeId: modeId,
    });
  }
}

function handleLoadSession(id, params) {
  if (!authUnlocked) {
    sendError(id, -32000, "Authentication required");
    return;
  }
  const sessionId =
    params && typeof params.sessionId === "string" ? params.sessionId : "mock-session-1";
  sessions.add(sessionId);
  // Replay 1-2 notifications before responding (user_message_chunk then
  // agent_message_chunk; content is a text ContentBlock per $defs/ContentChunk).
  notifySessionUpdate(sessionId, {
    sessionUpdate: "user_message_chunk",
    content: { type: "text", text: "(replayed) earlier user message" },
  });
  notifySessionUpdate(sessionId, {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "(replayed) earlier agent reply" },
  });
  // Metadata replay must survive the runtime's replay drain.
  notifySessionUpdate(sessionId, {
    sessionUpdate: "available_commands_update",
    availableCommands: [
      { name: "replayed-command", description: "Replayed from the prior session" },
    ],
  });
  notifySessionUpdate(sessionId, {
    sessionUpdate: "session_info_update",
    title: "(replayed) prior title",
  });
  // $defs/LoadSessionResponse carries modes/configOptions only (no sessionId -
  // the client already knows the id it asked to load).
  sendResult(id, { modes: MODES, configOptions: configOptionsFor(sessionConfig(sessionId)) });
}

function handlePrompt(id, params) {
  const sessionId = params ? params.sessionId : null;
  const promptText = extractPromptText(params && params.prompt);
  const imageMarkers = describeImages(params && params.prompt).join(" ");
  const turnNumber = ++turnCounter;
  if (HANG) {
    // Accept the request but never respond; keep the process alive.
    return;
  }
  const turn = makeTurn();
  turn.promptRequestId = id;
  if (typeof sessionId === "string") activeTurns.set(sessionId, turn);
  runTurn(sessionId, imageMarkers ? `${promptText} ${imageMarkers}` : promptText, turnNumber, turn)
    .catch((err) => {
      if (err instanceof CancelledError) {
        sendResult(id, { stopReason: "cancelled" });
      } else {
        logErr(`turn ${turnNumber} failed: ${err && err.stack ? err.stack : err}`);
        sendError(id, -32603, "mock agent internal error");
      }
    })
    .finally(() => {
      if (typeof sessionId === "string" && activeTurns.get(sessionId) === turn) {
        activeTurns.delete(sessionId);
      }
    });
}

function handleCancelNotification(params) {
  const sessionId = params && typeof params.sessionId === "string" ? params.sessionId : null;
  const turn = sessionId ? activeTurns.get(sessionId) : null;
  if (turn) {
    signalCancel(turn);
  }
  // Nothing to cancel -> ignore silently.
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const TERMINAL_METHODS = new Set([
  "terminal/create",
  "terminal/output",
  "terminal/release",
  "terminal/wait_for_exit",
  "terminal/kill",
]);

function handleMessage(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    logErr(`ignoring malformed line: ${JSON.stringify(line.slice(0, 120))}`);
    return;
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    logErr("ignoring malformed line: not a JSON object");
    return;
  }

  // Response to one of our agent->client requests?
  if (
    msg.method === undefined &&
    Object.prototype.hasOwnProperty.call(msg, "id") &&
    (Object.prototype.hasOwnProperty.call(msg, "result") ||
      Object.prototype.hasOwnProperty.call(msg, "error"))
  ) {
    resolveAgentRequest(String(msg.id), msg);
    return;
  }

  if (typeof msg.method !== "string") {
    logErr(`ignoring message without method: ${JSON.stringify(msg).slice(0, 120)}`);
    return;
  }

  const isRequest = Object.prototype.hasOwnProperty.call(msg, "id") && msg.id !== undefined;
  const params = msg.params;

  if (!isRequest) {
    // Notifications expect no response. Only session/cancel matters to us.
    if (msg.method === "session/cancel") {
      handleCancelNotification(params);
    }
    return;
  }

  switch (msg.method) {
    case "initialize":
      handleInitialize(msg.id);
      return;
    case "authenticate":
      handleAuthenticate(msg.id, msg.params);
      return;
    case "session/new":
      handleNewSession(msg.id);
      return;
    case "session/load":
      handleLoadSession(msg.id, params);
      return;
    case "session/set_mode":
      handleSetMode(msg.id, params);
      return;
    case "session/set_config_option":
      handleSetConfigOption(msg.id, params);
      return;
    case "session/prompt":
      handlePrompt(msg.id, params);
      return;
    default:
      if (TERMINAL_METHODS.has(msg.method)) {
        sendError(msg.id, -32601, `method not supported by mock agent: ${msg.method}`);
      } else {
        sendError(msg.id, -32601, `method not found: ${msg.method}`);
      }
      return;
  }
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

if (BAD_JSON) {
  // Resilience fixture: garbage on stdout before anything else. Handshake
  // must still work afterwards.
  process.stdout.write("NOT JSON AT ALL\n");
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed) handleMessage(trimmed);
});
rl.on("close", () => {
  process.exit(0);
});

process.on("unhandledRejection", (err) => {
  logErr(`unhandled rejection: ${err && err.stack ? err.stack : err}`);
});
