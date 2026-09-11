"use strict";
/**
 * An ACP agent the tests can run instead of the real cursor-agent, gemini or
 * opencode.
 *
 * It speaks what the real ones speak: newline-delimited JSON-RPC 2.0 on stdin
 * and stdout, the framing the official `@agentclientprotocol/sdk` uses
 * (dist/stream.js, dist/jsonrpc.js). It is a Node script run by this very Node,
 * so Windows runs it exactly as macOS and Linux do: an extensionless file is
 * not a program there, and npm installs the real agents as `.cmd` shims, which
 * is what the bridge starts on Windows (spawn-command.ts).
 *
 * Run as: node acp-agent.fake.cjs <settings.json> acp
 *
 * The settings file holds:
 *   record       where to append one JSON line per message in and out
 *   answers      the answer text for each turn, in order; "" for no answer;
 *                the last one is reused for any further turns
 *   turnMs       how long a turn takes before it completes
 *   loadSession  whether the agent advertises `session/load` (default true)
 *   resumable    the session ids `session/load` accepts; anything else errors,
 *                as a real agent answers for a session it has lost
 */
const fs = require("node:fs");

const settingsPath = process.argv[2];
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
const record = (entry) => {
  fs.appendFileSync(settings.record, `${JSON.stringify(entry)}\n`);
};

const write = (message) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
};
const notify = (method, params) => {
  record({ out: method, params });
  write({ method, params });
};

/**
 * The sessions it has opened. A real agent keeps each one until it is told to
 * close it and takes it back with `session/load`, so this list is a file too,
 * and a second run of this script still knows the sessions the first opened.
 */
const store = `${settingsPath}.sessions.json`;
const readStore = () => {
  try { return new Set(JSON.parse(fs.readFileSync(store, "utf8"))); }
  catch { return new Set(settings.resumable ?? []); }
};
const keep = (id) => {
  const all = readStore();
  all.add(id);
  fs.writeFileSync(store, JSON.stringify([...all]));
};

const active = new Map();
let sessions = readStore().size;
let turnCount = 0;

const answerFor = (index) => {
  const answers = settings.answers ?? ["ok"];
  const value = index < answers.length ? answers[index] : answers[answers.length - 1];
  return value ?? "ok";
};

const completePrompt = (sessionId, stopReason) => {
  const turn = active.get(sessionId);
  if (!turn) return;
  active.delete(sessionId);
  clearTimeout(turn.timer);
  if (stopReason === "end_turn" && turn.answer) {
    notify("session/update", {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: turn.answer } },
    });
  }
  write({ id: turn.id, result: { stopReason } });
};

const handle = (message) => {
  record({ in: message.method, params: message.params, argv: process.argv.slice(2) });
  const answer = (result) => { write({ id: message.id, result }); };
  if (message.method === "initialize") {
    answer({
      protocolVersion: message.params.protocolVersion,
      agentCapabilities: { loadSession: settings.loadSession !== false },
      agentInfo: { name: "fake-acp", version: "0.0.0" },
    });
    return;
  }
  if (message.method === "session/new") {
    sessions += 1;
    const sessionId = `session-${sessions}`;
    keep(sessionId);
    answer({ sessionId });
    return;
  }
  if (message.method === "session/load") {
    if (!readStore().has(message.params.sessionId)) {
      write({ id: message.id, error: { code: -32602, message: `no session ${message.params.sessionId}` } });
      return;
    }
    answer({});
    return;
  }
  if (message.method === "session/prompt") {
    turnCount += 1;
    const sessionId = message.params.sessionId;
    const turn = {
      id: message.id,
      answer: answerFor(turnCount - 1),
      timer: setTimeout(() => { completePrompt(sessionId, "end_turn"); }, settings.turnMs ?? 5),
    };
    active.set(sessionId, turn);
    return;
  }
  if (message.method === "session/cancel") {
    // A notification: no id, no response. The running prompt returns
    // `cancelled`, which is how ACP ends a cancelled turn.
    completePrompt(message.params.sessionId, "cancelled");
    return;
  }
  if (message.id !== undefined) {
    write({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
  }
};

let rest = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  rest += chunk;
  for (;;) {
    const at = rest.indexOf("\n");
    if (at < 0) break;
    const line = rest.slice(0, at).trim();
    rest = rest.slice(at + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => { process.exit(0); });
