"use strict";
/**
 * A `codex app-server` the tests can run instead of the real one.
 *
 * It speaks what the real one speaks: newline-delimited JSON-RPC on stdin and
 * stdout, with Codex's own envelope (`{id, method, params}`, no `jsonrpc`
 * field). It is a Node script run by this very Node, so Windows runs it exactly
 * as macOS and Linux do: an extensionless file with a `#!` line is not a
 * program there, and npm installs the real Codex as a `.cmd` shim, which is
 * what the bridge starts on Windows (spawn-command.ts).
 *
 * Run as: node codex-app-server.fake.cjs <settings.json> app-server
 *
 * The settings file holds:
 *   record      where to append one JSON line per message in and out
 *   answers     what to answer, in order; each entry is a list of agent
 *               messages `{text, phase}`, or an empty list for no answer
 *   turnMs      how long a turn takes before it completes
 *   resumable   the thread ids `thread/resume` accepts; anything else is an
 *               error, as the real one answers for a thread it has lost
 */
const fs = require("node:fs");

const settingsPath = process.argv[2];
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
const record = (entry) => {
  fs.appendFileSync(settings.record, `${JSON.stringify(entry)}\n`);
};

const write = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const notify = (method, params) => {
  record({ out: method, params });
  write({ method, params });
};

/**
 * The threads it has opened. The real app-server keeps a rollout file for each
 * one and takes it back after a restart, so this list is a file too, and a
 * second run of this script still knows the threads the first run opened.
 */
const rollouts = `${settingsPath}.threads.json`;
const readRollouts = () => {
  try { return new Set(JSON.parse(fs.readFileSync(rollouts, "utf8"))); }
  catch { return new Set(settings.resumable ?? []); }
};
const keepRollout = (id) => {
  const all = readRollouts();
  all.add(id);
  fs.writeFileSync(rollouts, JSON.stringify([...all]));
};
const turns = new Map();
let threads = readRollouts().size;
let turnCount = 0;
let answerCount = 0;

const completeTurn = (turnId, status) => {
  const turn = turns.get(turnId);
  if (!turn) return;
  turns.delete(turnId);
  clearTimeout(turn.timer);
  if (status === "completed") {
    for (const message of turn.answers) {
      notify("item/agentMessage/delta", {
        threadId: turn.threadId, turnId, itemId: `${turnId}-item`, delta: message.text,
      });
      notify("item/completed", {
        threadId: turn.threadId,
        turnId,
        completedAtMs: 0,
        item: {
          type: "agentMessage",
          id: `${turnId}-item`,
          text: message.text,
          ...(message.phase === undefined ? {} : { phase: message.phase }),
        },
      });
    }
  }
  notify("turn/completed", { threadId: turn.threadId, turn: { id: turnId, status } });
};

const handle = (message) => {
  record({ in: message.method, params: message.params, argv: process.argv.slice(2) });
  const answer = (result) => { write({ id: message.id, result }); };
  if (message.method === "initialize") {
    answer({ userAgent: "fake/0.154.0", codexHome: "/fake", platformFamily: "unix", platformOs: "macos" });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start") {
    threads += 1;
    const id = `thread-${threads}`;
    keepRollout(id);
    answer({ thread: { id } });
    return;
  }
  if (message.method === "thread/resume") {
    const id = message.params.threadId;
    if (!readRollouts().has(id)) {
      write({ id: message.id, error: { code: -32600, message: `no rollout found for thread id ${id}` } });
      return;
    }
    answer({ thread: { id } });
    return;
  }
  if (message.method === "turn/start") {
    turnCount += 1;
    const turnId = `turn-${turnCount}`;
    answerCount += 1;
    const answers = (settings.answers ?? [])[answerCount - 1]
      ?? (settings.answers ?? []).at(-1)
      ?? [{ text: "ok", phase: "final_answer" }];
    const timer = setTimeout(() => { completeTurn(turnId, "completed"); }, settings.turnMs ?? 5);
    turns.set(turnId, { threadId: message.params.threadId, answers, timer });
    answer({ turn: { id: turnId, status: "inProgress" } });
    return;
  }
  if (message.method === "turn/interrupt") {
    answer({});
    completeTurn(message.params.turnId, "interrupted");
    return;
  }
  write({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
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
