#!/usr/bin/env node
/**
 * mock-selftest.mjs — dependency-free driver for fixtures/mock-acp-agent.mjs.
 *
 * Spawns the mock agent over stdio (newline-delimited JSON-RPC 2.0), plays the
 * ACP client, and asserts behavior across five scenarios:
 *   1. happy path          — full handshake + prompt turn sequence
 *   2. cancel              — MOCK_SLOW_TURN=1, cancel mid-turn -> "cancelled"
 *   3. MOCK_BAD_JSON=1     — garbage line ignored, handshake still completes
 *   4. MOCK_CRASH_MID_TURN — process exits non-zero, no prompt response
 *   5. MOCK_HANG=1         — prompt does not resolve within 1.5s
 *
 * Run: node scripts/mock-selftest.mjs   (exits 1 on any failure)
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_SCRIPT = path.join(ROOT, "fixtures", "mock-acp-agent.mjs");

const CLIENT_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: false,
  auth: { terminal: false },
  session: { notices: {} },
};

const MOCK_FILE_CONTENT = "mock file content from client";
const REQUEST_TIMEOUT_MS = 20_000;

class AssertionError extends Error {}

function assert(cond, message) {
  if (!cond) throw new AssertionError(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AssertionError(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Wait for a session/update matching `predicate`, received after `startIndex`.
 * Checks already-buffered updates first, then listens live — this avoids the
 * readline race where the agent's response line resolves the awaiting code
 * before the following notification line is processed.
 */
function waitForUpdate(client, startIndex, predicate, ms = 3000, label = "session update") {
  const buffered = client.updates.slice(startIndex).find(predicate);
  if (buffered) return Promise.resolve(buffered);
  return new Promise((resolve, reject) => {
    const listener = (params) => {
      if (!predicate(params)) return;
      clearTimeout(timer);
      client.updateListeners.delete(listener);
      resolve(params);
    };
    const timer = setTimeout(() => {
      client.updateListeners.delete(listener);
      reject(new AssertionError(`${label} not received within ${ms}ms`));
    }, ms);
    client.updateListeners.add(listener);
  });
}

// ---------------------------------------------------------------------------
// Mock client harness
// ---------------------------------------------------------------------------

class MockClient {
  /**
   * @param {Record<string, string>} envOverrides extra env vars for the agent
   */
  constructor(envOverrides = {}) {
    this.envOverrides = envOverrides;
    this.child = null;
    this.updates = []; // session/update notification params
    this.updateListeners = new Set();
    this.fsReads = [];
    this.fsWrites = [];
    this.permissionRequests = [];
    this.permissionOutcomeIds = [];
    this.clientRequestIdCounter = 0;
    this.pendingRequests = new Map(); // client request id -> {resolve, reject}
    this.garbageLines = 0;
    this.stderrText = "";
    this.exited = false;
    this.exitInfo = null;
    this.exitWaiters = [];
    this.closed = false;
  }

  start() {
    this.child = spawn(process.execPath, [AGENT_SCRIPT], {
      cwd: ROOT,
      env: { ...process.env, ...this.envOverrides },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutLines = createInterface({ input: this.child.stdout, terminal: false });
    stdoutLines.on("line", (line) => this.handleLine(line.trim()));

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderrText += chunk;
    });

    this.child.on("exit", (code, signal) => {
      this.exited = true;
      this.exitInfo = { code, signal };
      for (const wake of this.exitWaiters.splice(0)) wake();
    });
    this.child.on("error", (err) => {
      this.exited = true;
      this.exitInfo = { code: null, signal: null, spawnError: String(err) };
      for (const wake of this.exitWaiters.splice(0)) wake();
    });
  }

  handleLine(line) {
    if (!line) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.garbageLines += 1;
      return; // resilience: ignore non-JSON lines
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      this.garbageLines += 1;
      return;
    }

    // Agent -> client request?
    if (
      typeof msg.method === "string" &&
      Object.prototype.hasOwnProperty.call(msg, "id") &&
      msg.id !== undefined
    ) {
      this.handleAgentRequest(msg);
      return;
    }

    // Agent notification (no id, expects no response).
    if (typeof msg.method === "string" && !Object.prototype.hasOwnProperty.call(msg, "id")) {
      if (msg.method === "session/update" && msg.params && msg.params.update) {
        this.updates.push(msg.params);
        for (const listener of this.updateListeners) listener(msg.params);
      }
      return;
    }

    // Response to one of our client -> agent requests.
    if (
      msg.method === undefined &&
      Object.prototype.hasOwnProperty.call(msg, "id") &&
      (Object.prototype.hasOwnProperty.call(msg, "result") ||
        Object.prototype.hasOwnProperty.call(msg, "error"))
    ) {
      const key = String(msg.id);
      const entry = this.pendingRequests.get(key);
      if (entry) {
        this.pendingRequests.delete(key);
        if (Object.prototype.hasOwnProperty.call(msg, "error")) {
          entry.reject(
            new AssertionError(`agent returned error for ${key}: ${JSON.stringify(msg.error)}`),
          );
        } else {
          entry.resolve(msg.result);
        }
      }
      return;
    }

    this.garbageLines += 1; // unrecognized shape
  }

  handleAgentRequest(msg) {
    const id = msg.id;
    const respond = (result) => this.sendLine({ jsonrpc: "2.0", id, result });
    const respondError = (code, message) =>
      this.sendLine({ jsonrpc: "2.0", id, error: { code, message } });

    switch (msg.method) {
      case "fs/read_text_file": {
        this.fsReads.push(msg.params);
        respond({ content: MOCK_FILE_CONTENT });
        return;
      }
      case "fs/write_text_file": {
        this.fsWrites.push(msg.params);
        respond({}); // $defs/WriteTextFileResponse: empty result
        return;
      }
      case "session/request_permission": {
        this.permissionRequests.push(msg.params);
        const options = Array.isArray(msg.params && msg.params.options) ? msg.params.options : [];
        const allow = options.find(
          (o) => o && typeof o.kind === "string" && o.kind.startsWith("allow"),
        );
        const optionId = allow ? allow.optionId : null;
        this.permissionOutcomeIds.push(optionId);
        respond({ outcome: { outcome: "selected", optionId } });
        return;
      }
      default: {
        // Terminal or any other client-side method: the mock never needs them.
        respondError(-32601, `method not supported by selftest client: ${msg.method}`);
        return;
      }
    }
  }

  sendLine(obj) {
    if (!this.child || this.closed) return;
    this.child.stdin.write(JSON.stringify(obj) + "\n");
  }

  /** Client -> agent request. */
  request(method, params) {
    const id = ++this.clientRequestIdCounter;
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(String(id), { resolve, reject });
      this.sendLine({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Client -> agent notification (e.g. session/cancel). */
  notify(method, params) {
    this.sendLine({ jsonrpc: "2.0", method, params });
  }

  /** Collect session/update params received after this call. */
  collectUpdates() {
    const start = this.updates.length;
    return {
      start,
      all: () => this.updates.slice(start),
    };
  }

  waitForExit() {
    if (this.exited) return Promise.resolve(this.exitInfo);
    return new Promise((resolve) => this.exitWaiters.push(() => resolve(this.exitInfo)));
  }

  async handshake(sessionText = "unused") {
    const init = await withTimeout(
      this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: CLIENT_CAPABILITIES,
        clientInfo: { name: "mock-selftest", version: "0.1.0" },
      }),
      REQUEST_TIMEOUT_MS,
      "initialize",
    );
    const newSession = await withTimeout(
      this.request("session/new", { cwd: ROOT, mcpServers: [] }),
      REQUEST_TIMEOUT_MS,
      "session/new",
    );
    return { init, newSession };
  }

  async shutdown() {
    this.closed = true;
    if (this.child && this.child.exitCode === null && !this.exited) {
      this.child.kill();
    }
    if (this.child && this.child.stdin && !this.child.stdin.destroyed) {
      this.child.stdin.end();
    }
    await Promise.race([this.waitForExit(), sleep(2000)]);
    for (const entry of this.pendingRequests.values()) {
      entry.reject(new AssertionError("client shut down with pending requests"));
    }
    this.pendingRequests.clear();
  }
}

// ---------------------------------------------------------------------------
// Shared handshake + prompt helpers
// ---------------------------------------------------------------------------

async function connect(envOverrides) {
  const client = new MockClient(envOverrides);
  client.start();
  const { init, newSession } = await client.handshake();
  return { client, init, newSession };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenarioHappyPath() {
  const { client: c, init, newSession } = await connect();

  try {
    // -- initialize ---------------------------------------------------------
    assert(
      init.protocolVersion === 1,
      `initialize.protocolVersion should be 1, got ${JSON.stringify(init.protocolVersion)}`,
    );
    assert(
      init.agentCapabilities && init.agentCapabilities.loadSession === true,
      "agentCapabilities.loadSession should be true",
    );
    const pc = init.agentCapabilities.promptCapabilities || {};
    assert(
      pc.image === true && pc.audio === false && pc.embeddedContext === false,
      `promptCapabilities mismatch: ${JSON.stringify(pc)}`,
    );
    assert(
      Array.isArray(init.authMethods) && init.authMethods.length === 0,
      "authMethods should be an empty array",
    );
    assert(
      init.agentInfo && init.agentInfo.name === "mock-acp-agent",
      "agentInfo.name should be mock-acp-agent",
    );

    // -- session/new --------------------------------------------------------
    const sid = newSession.sessionId;
    assert(
      sid === "mock-session-1",
      `sessionId should be mock-session-1, got ${JSON.stringify(sid)}`,
    );
    assert(
      newSession.modes && newSession.modes.currentModeId === "code",
      "modes.currentModeId should be 'code'",
    );
    const modeIds = (newSession.modes.availableModes || []).map((m) => m.id);
    assert(
      modeIds.join(",") === "code,architect",
      `availableModes ids should be code,architect, got ${modeIds.join(",")}`,
    );

    // -- prompt turn 1 ------------------------------------------------------
    const h1 = c.collectUpdates();
    const prompt1 = withTimeout(
      c.request("session/prompt", {
        sessionId: sid,
        prompt: [{ type: "text", text: "hello mock" }],
      }),
      REQUEST_TIMEOUT_MS,
      "session/prompt (turn 1)",
    );
    const res1 = await prompt1;
    assert(
      res1.stopReason === "end_turn",
      `stopReason should be end_turn, got ${JSON.stringify(res1.stopReason)}`,
    );

    const ups1 = h1.all();
    const variants = ups1.map((u) => u.update.sessionUpdate);
    assert(
      ups1.every((u) => u.sessionId === sid),
      "every session/update must carry the sessionId",
    );

    // ordering: thought -> plan -> tool calls -> messages -> commands -> notice
    const idx = (name) => variants.indexOf(name);
    assert(idx("agent_thought_chunk") !== -1, "expected agent_thought_chunk updates");
    assert(idx("plan") > idx("agent_thought_chunk"), "plan must come after thought chunks");
    assert(idx("tool_call") > idx("plan"), "tool_call must come after plan");
    assert(
      idx("agent_message_chunk") > idx("tool_call"),
      "message chunks must come after tool calls",
    );
    assert(
      idx("available_commands_update") > idx("agent_message_chunk"),
      "commands update must come after messages",
    );
    assert(
      idx("notice") > idx("available_commands_update"),
      "notice must come after commands update",
    );

    const thoughts = ups1.filter((u) => u.update.sessionUpdate === "agent_thought_chunk");
    assert(thoughts.length === 2, `expected exactly 2 thought chunks, got ${thoughts.length}`);
    for (const t of thoughts) {
      assert(
        t.update.content &&
          t.update.content.type === "text" &&
          typeof t.update.content.text === "string",
        "thought chunk content must be a text block",
      );
    }

    const plan = ups1.find((u) => u.update.sessionUpdate === "plan");
    assert(plan, "expected a plan update");
    const entries = plan.update.entries || [];
    assert(entries.length === 3, `plan should have 3 entries, got ${entries.length}`);
    assert(
      JSON.stringify(entries.map((e) => e.status)) ===
        JSON.stringify(["pending", "in_progress", "completed"]),
      `plan statuses wrong: ${JSON.stringify(entries.map((e) => e.status))}`,
    );
    for (const e of entries) {
      assert(typeof e.content === "string" && e.content.length > 0, "plan entry needs content");
      assert(
        ["high", "medium", "low"].includes(e.priority),
        `plan entry priority invalid: ${JSON.stringify(e.priority)}`,
      );
    }

    // tool-1 read lifecycle
    const readCall = ups1.find(
      (u) => u.update.sessionUpdate === "tool_call" && u.update.kind === "read",
    );
    assert(readCall, "expected a tool_call with kind 'read'");
    assert(readCall.update.status === "in_progress", "read tool_call should start in_progress");
    assert(
      typeof readCall.update.toolCallId === "string" &&
        readCall.update.toolCallId.startsWith("tool-1-"),
      `read toolCallId should be turn-suffixed, got ${JSON.stringify(readCall.update.toolCallId)}`,
    );
    assert(
      Array.isArray(readCall.update.locations) &&
        readCall.update.locations[0] &&
        readCall.update.locations[0].path === "/repo/src/main.rs",
      `read locations[0].path should be /repo/src/main.rs, got ${JSON.stringify(readCall.update.locations)}`,
    );
    const readUpdate = ups1.find(
      (u) =>
        u.update.sessionUpdate === "tool_call_update" &&
        u.update.toolCallId === readCall.update.toolCallId,
    );
    assert(
      readUpdate && readUpdate.update.status === "completed",
      "read tool_call_update should be completed",
    );

    // fs read round-trip
    assert(
      c.fsReads.length === 1,
      `client should receive exactly 1 fs/read_text_file, got ${c.fsReads.length}`,
    );
    assert(
      c.fsReads[0].sessionId === sid && c.fsReads[0].path === "/repo/src/main.rs",
      `fs read params wrong: ${JSON.stringify(c.fsReads[0])}`,
    );

    const messageTexts = ups1
      .filter((u) => u.update.sessionUpdate === "agent_message_chunk")
      .map((u) => u.update.content.text);
    assert(
      messageTexts.some((t) => t.includes(MOCK_FILE_CONTENT)),
      `fs read content should be echoed in an agent_message_chunk, got ${JSON.stringify(messageTexts)}`,
    );

    // permission round-trip
    assert(
      c.permissionRequests.length === 1,
      `client should receive exactly 1 session/request_permission, got ${c.permissionRequests.length}`,
    );
    const perm = c.permissionRequests[0];
    assert(perm.sessionId === sid, "permission request must carry sessionId");
    assert(
      perm.toolCall &&
        typeof perm.toolCall.toolCallId === "string" &&
        perm.toolCall.toolCallId.startsWith("tool-1-"),
      "permission toolCall.toolCallId should be turn-suffixed",
    );
    assert(
      perm.toolCall.kind === "edit",
      `permission toolCall.kind should be 'edit', got ${JSON.stringify(perm.toolCall.kind)}`,
    );
    const kinds = (perm.options || []).map((o) => o.kind);
    assert(
      kinds.includes("allow_once") && kinds.includes("reject_once"),
      `permission options should include allow_once + reject_once, got ${JSON.stringify(kinds)}`,
    );
    for (const o of perm.options) {
      assert(
        typeof o.optionId === "string" && o.optionId.length > 0 && typeof o.name === "string",
        "permission options need optionId + name",
      );
    }
    const allowedOptionId = c.permissionOutcomeIds[0];
    assert(
      typeof allowedOptionId === "string" && allowedOptionId.length > 0,
      "client should have selected an allow optionId",
    );

    // fs write round-trip answered with empty result (turn continued)
    assert(
      c.fsWrites.length === 1,
      `client should receive exactly 1 fs/write_text_file, got ${c.fsWrites.length}`,
    );
    assert(
      c.fsWrites[0].path === "/repo/src/mock-out.txt" &&
        c.fsWrites[0].content === "hello from mock",
      `fs write params wrong: ${JSON.stringify(c.fsWrites[0])}`,
    );

    // edit tool lifecycle: completed with a diff content block
    const editCall = ups1.find(
      (u) => u.update.sessionUpdate === "tool_call" && u.update.kind === "edit",
    );
    assert(
      editCall && editCall.update.toolCallId === perm.toolCall.toolCallId,
      "edit tool_call should match the permission toolCallId",
    );
    const editUpdates = ups1.filter(
      (u) =>
        u.update.sessionUpdate === "tool_call_update" &&
        u.update.toolCallId === perm.toolCall.toolCallId,
    );
    assert(
      editUpdates.length > 0 && editUpdates[editUpdates.length - 1].update.status === "completed",
      "edit tool_call_update should end completed (allowed)",
    );
    const diffBlock = editUpdates
      .flatMap((u) => u.update.content || [])
      .find((blk) => blk.type === "diff");
    assert(diffBlock, "edit update should include a diff ToolCallContent block");
    assert(
      diffBlock.path === "/repo/src/mock-out.txt" && diffBlock.newText === "hello from mock",
      `diff shape wrong: ${JSON.stringify(diffBlock)}`,
    );

    // streamed echo: chunks after the fs echo join back to the prompt text
    const echoChunks = messageTexts.filter((t) => !t.includes(MOCK_FILE_CONTENT));
    assert(echoChunks.length >= 3, `expected ~4 streamed echo chunks, got ${echoChunks.length}`);
    assert(
      echoChunks.join("") === "hello mock",
      `echo chunks should reassemble the prompt, got ${JSON.stringify(echoChunks)}`,
    );

    // available commands
    const cmds = ups1.find((u) => u.update.sessionUpdate === "available_commands_update");
    assert(cmds, "expected available_commands_update");
    const cmdList = cmds.update.availableCommands || [];
    const byName = Object.fromEntries(cmdList.map((cmd) => [cmd.name, cmd]));
    assert(
      byName["mock-echo"] && byName["mock-echo"].description === "Echo the prompt",
      `mock-echo command wrong: ${JSON.stringify(byName["mock-echo"])}`,
    );
    assert(
      byName["mock-plan"] &&
        typeof byName["mock-plan"].description === "string" &&
        byName["mock-plan"].description.length > 0,
      `mock-plan command needs a description: ${JSON.stringify(byName["mock-plan"])}`,
    );

    // notice
    const notice = ups1.find((u) => u.update.sessionUpdate === "notice");
    assert(notice, "expected a notice update");
    assert(
      notice.update.severity === "info",
      `notice severity should be 'info', got ${JSON.stringify(notice.update.severity)}`,
    );
    assert(
      typeof notice.update.title === "string" && notice.update.title.length > 0,
      "notice needs a non-empty title",
    );

    // -- prompt turn 2: fresh toolCallIds ------------------------------------
    const turn1Ids = ups1
      .filter((u) => u.update.sessionUpdate === "tool_call")
      .map((u) => u.update.toolCallId);
    const h2 = c.collectUpdates();
    const res2 = await withTimeout(
      c.request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "turn two" }] }),
      REQUEST_TIMEOUT_MS,
      "session/prompt (turn 2)",
    );
    assert(res2.stopReason === "end_turn", "turn 2 should end with end_turn");
    const turn2Ids = h2
      .all()
      .filter((u) => u.update.sessionUpdate === "tool_call")
      .map((u) => u.update.toolCallId);
    assert(turn2Ids.length > 0, "turn 2 should emit tool calls");
    for (const id of turn2Ids) {
      assert(
        !turn1Ids.includes(id),
        `toolCallIds must be fresh per turn: ${JSON.stringify(id)} reused`,
      );
    }

    // -- session/set_mode -> current_mode_update -----------------------------
    const hm = c.collectUpdates();
    const setModeRes = await withTimeout(
      c.request("session/set_mode", { sessionId: sid, modeId: "architect" }),
      REQUEST_TIMEOUT_MS,
      "session/set_mode",
    );
    assert(
      setModeRes && typeof setModeRes === "object",
      "set_mode should respond with an object result",
    );
    const modeUpdate = await waitForUpdate(
      c,
      hm.start,
      (u) => u.update.sessionUpdate === "current_mode_update",
      3000,
      "current_mode_update after set_mode",
    );
    assert(
      modeUpdate.update.currentModeId === "architect",
      `current_mode_update should say architect, got ${JSON.stringify(modeUpdate.update)}`,
    );
    await withTimeout(
      c.request("session/set_mode", { sessionId: sid, modeId: "code" }),
      REQUEST_TIMEOUT_MS,
      "session/set_mode back",
    );

    // -- session/load: replay notifications + schema response ----------------
    const hl = c.collectUpdates();
    const loadRes = await withTimeout(
      c.request("session/load", { sessionId: sid, cwd: ROOT, mcpServers: [] }),
      REQUEST_TIMEOUT_MS,
      "session/load",
    );
    assert(
      loadRes.modes && loadRes.modes.currentModeId === "code",
      `session/load response should carry modes, got ${JSON.stringify(loadRes)}`,
    );
    const replayUser = await waitForUpdate(
      c,
      hl.start,
      (u) => u.update.sessionUpdate === "user_message_chunk",
      3000,
      "session/load user_message_chunk replay",
    );
    assert(
      replayUser.update.content.type === "text",
      "load replay user_message_chunk content must be a text block",
    );
    const replayAgent = await waitForUpdate(
      c,
      hl.start,
      (u) => u.update.sessionUpdate === "agent_message_chunk",
      3000,
      "session/load agent_message_chunk replay",
    );
    assert(
      replayAgent.update.content.type === "text",
      "load replay agent_message_chunk content must be a text block",
    );

    // -- unknown method -> -32601 --------------------------------------------
    let unknownErrored = false;
    try {
      await withTimeout(
        c.request("definitely/not/a/method", {}),
        REQUEST_TIMEOUT_MS,
        "unknown method",
      );
    } catch (err) {
      unknownErrored = String(err).includes("-32601");
    }
    assert(unknownErrored, "unknown method should return JSON-RPC error -32601");
  } finally {
    await c.shutdown();
  }
}

async function scenarioCancel() {
  const { client: c, newSession } = await connect({ MOCK_SLOW_TURN: "1" });
  try {
    const sid = newSession.sessionId;
    const promptPromise = withTimeout(
      c.request("session/prompt", {
        sessionId: sid,
        prompt: [{ type: "text", text: "cancel me" }],
      }),
      REQUEST_TIMEOUT_MS,
      "session/prompt (cancel scenario)",
    );
    setTimeout(() => c.notify("session/cancel", { sessionId: sid }), 500);
    const res = await promptPromise;
    assert(
      res.stopReason === "cancelled",
      `stopReason should be cancelled, got ${JSON.stringify(res.stopReason)}`,
    );
    await c.shutdown();
  } finally {
    await c.shutdown();
  }
}

async function scenarioBadJson() {
  const { client: c, newSession } = await connect({ MOCK_BAD_JSON: "1" });
  try {
    assert(c.garbageLines >= 1, "client should have seen the injected garbage line");
    const sid = newSession.sessionId;
    const res = await withTimeout(
      c.request("session/prompt", {
        sessionId: sid,
        prompt: [{ type: "text", text: "hello after garbage" }],
      }),
      REQUEST_TIMEOUT_MS,
      "session/prompt (bad-json scenario)",
    );
    assert(
      res.stopReason === "end_turn",
      `handshake + prompt should complete despite garbage, got ${JSON.stringify(res.stopReason)}`,
    );
    await c.shutdown();
  } finally {
    await c.shutdown();
  }
}

async function scenarioCrashMidTurn() {
  const { client: c, newSession } = await connect({ MOCK_CRASH_MID_TURN: "1" });
  try {
    const sid = newSession.sessionId;
    let promptResolved = false;
    const promptPromise = c
      .request("session/prompt", {
        sessionId: sid,
        prompt: [{ type: "text", text: "crash please" }],
      })
      .then(() => {
        promptResolved = true;
      })
      .catch(() => {
        promptResolved = true; // an error response also counts as a response
      });

    const exitInfo = await withTimeout(c.waitForExit(), 15_000, "agent process exit");
    await Promise.race([promptPromise, sleep(200)]);

    assert(!promptResolved, "prompt must not receive any response when the agent crashes mid-turn");
    assert(
      exitInfo && exitInfo.code === 1,
      `agent should exit with code 1, got ${JSON.stringify(exitInfo)}`,
    );
    assert(
      c.stderrText.includes("mock: simulated crash"),
      `stderr should contain the crash diagnostic, got ${JSON.stringify(c.stderrText.slice(-400))}`,
    );
    await c.shutdown();
  } finally {
    await c.shutdown();
  }
}

async function scenarioHang() {
  const { client: c, newSession } = await connect({ MOCK_HANG: "1" });
  try {
    const sid = newSession.sessionId;
    let settled = false;
    const promptPromise = c
      .request("session/prompt", {
        sessionId: sid,
        prompt: [{ type: "text", text: "hang please" }],
      })
      .then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

    const winner = await Promise.race([
      promptPromise.then(() => "resolved"),
      sleep(1500).then(() => "timeout"),
    ]);
    assert(winner === "timeout", "session/prompt should NOT resolve within 1.5s under MOCK_HANG=1");
    assert(!settled, "prompt promise must remain unsettled");
    assert(!c.exited, "agent should stay alive while hanging");

    c.child.kill();
    const exitInfo = await withTimeout(c.waitForExit(), 5_000, "agent exit after kill");
    assert(exitInfo, "agent should exit after being killed");
    await c.shutdown();
  } finally {
    await c.shutdown();
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const SCENARIOS = [
  ["happy path", scenarioHappyPath],
  ["cancel mid-turn", scenarioCancel],
  ["MOCK_BAD_JSON resilience", scenarioBadJson],
  ["MOCK_CRASH_MID_TURN", scenarioCrashMidTurn],
  ["MOCK_HANG", scenarioHang],
];

let failures = 0;
for (const [name, fn] of SCENARIOS) {
  const label = name.padEnd(26, " ");
  try {
    await fn();
    console.log(`PASS  ${label}`);
  } catch (err) {
    failures += 1;
    console.log(
      `FAIL  ${label} ${err instanceof AssertionError ? err.message : (err && err.stack) || String(err)}`,
    );
  }
}

console.log(failures === 0 ? "\nAll scenarios passed." : `\n${failures} scenario(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
