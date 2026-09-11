import type Relay from "@relaymessenger/sdk";
import type { MessagePartResponse, RelayWebhookEvent } from "@relaymessenger/sdk";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { findExecutable } from "./runtime-sniff.js";
import { spawnCommand } from "./spawn-command.js";

/**
 * What `relay connect codex` leaves running so Codex answers by itself.
 *
 * Codex reaches Relay through MCP, and MCP cannot start a turn, so a message
 * waits until somebody asks Codex to read it. Claude Code, Hermes and OpenClaw
 * answer on their own because a long-lived process pushes messages into them.
 * This is that process for Codex: it holds the agent's event connection, runs
 * `codex exec` in the folder connect ran in for every message that arrives,
 * and sends the final answer back to the same chat.
 *
 * It runs the `codex` already on this computer, not the one `@openai/codex-sdk`
 * carries. That package is a wrapper that spawns `codex exec` itself
 * (sdk/typescript, dist/index.js: `commandArgs = ["exec", "--experimental-json"]`)
 * and it depends on `@openai/codex`, whose macOS arm64 build unpacks to 290 MB
 * (npm, read 2026-09-11). Every `npx relaymessenger` user would pay that
 * download to connect any of the ten agents, and the copy it carries is not the
 * one the person signed in and configured. `codex exec` gives the same events,
 * the same final message, and the same thread continuity through
 * `codex exec resume`.
 */

/** Relay takes 1 to 255 characters for an idempotency key (contracts/relay-v1-openapi.yaml). */
export const replyKey = (eventId: string): string => `codex-bridge-${eventId}`;

/** The longest text Relay takes in one message part. */
export const MAX_RELAY_TEXT = 10_000;

/** Codex may write files in the folder it was started in, and is never asked to confirm. */
export const CODEX_SANDBOX = "workspace-write";

/** Where the prompt would stand: Codex reads it from stdin instead. */
export const CODEX_PROMPT_ON_STDIN = "-";

/**
 * One message, as the prompt Codex is given. Codex keeps its Relay tools during
 * the run, so the prompt says who answers the person: this process sends the
 * final message, and Codex must not send a second one.
 */
export const codexPrompt = (sender: string, text: string): string => [
  `@${sender} sent you this message on Relay:`,
  "",
  text.slice(0, MAX_RELAY_TEXT),
  "",
  "Write your answer as your final message. Relay sends that answer to the chat for you, so do not send it yourself.",
].join("\n");

/**
 * The command line, from `codex exec --help` and `codex exec resume --help`
 * (codex-cli 0.154.0). `resume` takes a session id and keeps the chat's
 * context; it has no `--sandbox`, so the same setting travels as a config
 * override, whose value is read as TOML.
 *
 * The prompt is not on this line. `-` is where the prompt would stand, and it
 * means Codex reads it from stdin: "If not provided as an argument (or if `-`
 * is used), instructions are read from stdin" (`codex exec --help`), and
 * "Prompt to send after resuming the session. If `-` is used, read from stdin"
 * (`codex exec resume --help`). A message a person wrote cannot go on a
 * command line on Windows at all, where Codex is a `.cmd` shim that only
 * `cmd.exe` can run, and `cmd.exe` ends the command at the first newline
 * (spawn-command.ts). Both lines were run against codex-cli 0.154.0 on
 * 2026-09-11 and answered.
 */
export const codexExecArgs = (input: { answerFile: string; threadId?: string }): string[] =>
  input.threadId === undefined
    ? [
      "exec", "--json", "--skip-git-repo-check",
      "--sandbox", CODEX_SANDBOX,
      "--output-last-message", input.answerFile,
      CODEX_PROMPT_ON_STDIN,
    ]
    : [
      "exec", "resume", input.threadId, "--json", "--skip-git-repo-check",
      "-c", `sandbox_mode="${CODEX_SANDBOX}"`,
      "--output-last-message", input.answerFile,
      CODEX_PROMPT_ON_STDIN,
    ];

export interface CodexOutput {
  answer: string;
  /** Codex's own id for this chat, so the next message keeps the context. */
  threadId?: string;
}

/**
 * `--json` prints one JSON object a line. `thread.started` carries the id
 * `codex exec resume` takes, and the last completed `agent_message` item holds
 * what Codex answered.
 */
export const readCodexJsonl = (output: string): CodexOutput => {
  let answer = "";
  let threadId: string | undefined;
  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    const row = parsed as { type?: unknown; thread_id?: unknown; item?: { type?: unknown; text?: unknown } | null };
    if (row.type === "thread.started" && typeof row.thread_id === "string") threadId = row.thread_id;
    if (row.item?.type === "agent_message" && typeof row.item.text === "string") answer = row.item.text;
  }
  return { answer, ...(threadId ? { threadId } : {}) };
};

export interface CodexRun {
  prompt: string;
  /** Absent for the first message in a chat, which opens a new Codex session. */
  threadId?: string;
  signal: AbortSignal;
}

export interface CodexAnswer {
  code: number;
  answer: string;
  threadId?: string;
}

export type CodexRunner = (run: CodexRun) => Promise<CodexAnswer>;

/** What to run for Codex: the file, and anything that comes before `exec`. */
export interface CodexCommand {
  command: string;
  /** Empty for the `codex` on this computer; a test's stand-in is a script Node runs. */
  args?: readonly string[];
}

/**
 * The file to run for Codex. connect hands over the one its own sniff found on
 * PATH, and the bare name when it found none (connect.ts). Windows has no file
 * called `codex`: npm installs the shim `codex.cmd`, which is what the sniff
 * looks for there (runtime-sniff.ts), so a bare name is looked up again here
 * and, failing that, left with the extension `cmd.exe` can find.
 */
export const codexCommand = async (
  found: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<CodexCommand> => {
  if (isAbsolute(found)) return { command: found };
  const onPath = await findExecutable(found, env, platform);
  return { command: onPath ?? (platform === "win32" ? `${found}.cmd` : found) };
};

/** Runs the `codex` on this computer, in the folder connect ran in. */
export const codexRunner = (codex: CodexCommand, cwd: string): CodexRunner => async (run) => {
  const folder = await mkdtemp(join(tmpdir(), "relay-codex-"));
  const answerFile = join(folder, "answer.txt");
  try {
    const args = [...codex.args ?? [], ...codexExecArgs({
      answerFile,
      ...(run.threadId === undefined ? {} : { threadId: run.threadId }),
    })];
    const finished = await new Promise<{ code: number; output: string }>((resolve) => {
      // Started the way every other command this CLI runs is started, so the
      // `.cmd` shim npm installs on Windows runs too (spawn-command.ts).
      const child = spawnCommand(codex.command, args, {
        cwd, stdio: ["pipe", "pipe", "pipe"], signal: run.signal,
      });
      // The prompt, where `-` stands on the command line. The person's own
      // terminal is never read: this is a pipe of the bridge's own.
      child.stdin?.on("error", () => { /* Codex stopped before it read the prompt. */ });
      child.stdin?.end(run.prompt);
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
      child.stderr?.resume();
      child.once("error", () => resolve({ code: 127, output }));
      child.once("close", (code) => resolve({ code: code ?? 1, output }));
    });
    const events = readCodexJsonl(finished.output);
    let answer = events.answer;
    try { answer = (await readFile(answerFile, "utf8")).trim() || answer; }
    catch { /* Codex wrote no final message. */ }
    return {
      code: finished.code, answer: answer.trim(),
      ...(events.threadId ? { threadId: events.threadId } : {}),
    };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
};

/** One message this process answers. */
export interface BridgeTurn {
  eventId: string;
  chatId: string;
  sender: string;
  text: string;
}

/** An inbound message with text in it. Everything else is left alone. */
export const bridgeTurn = (event: RelayWebhookEvent): BridgeTurn | undefined => {
  if (event.event_type !== "message.received") return undefined;
  const data = event.data as {
    chat?: { id?: unknown } | null;
    direction?: unknown;
    sender_handle?: { handle?: unknown } | null;
    parts?: unknown;
  };
  if (data.direction !== "inbound") return undefined;
  const chatId = typeof data.chat?.id === "string" ? data.chat.id : "";
  const sender = typeof data.sender_handle?.handle === "string" ? data.sender_handle.handle : "";
  const text = (Array.isArray(data.parts) ? data.parts as MessagePartResponse[] : [])
    .filter((part) => part.type === "text" || part.type === "link")
    .map((part) => part.value)
    .join("\n")
    .trim();
  if (!chatId || !sender || !text) return undefined;
  return { eventId: event.event_id, chatId, sender, text };
};

export interface CodexBridgeInput {
  client: Pick<Relay, "chats" | "websocket">;
  run: CodexRunner;
  signal: AbortSignal;
  /** One line to the terminal the person is watching. */
  say(line: string): void;
}

/** One line of what arrived, short enough to read at a glance. */
const arrival = (turn: BridgeTurn): string =>
  `@${turn.sender}  ${turn.text.replace(/\s+/gu, " ").slice(0, 160)}`;

const answerOne = async (
  turn: BridgeTurn,
  threads: Map<string, string>,
  input: CodexBridgeInput,
): Promise<void> => {
  input.say(arrival(turn));
  let typing = false;
  try { await input.client.chats.startTyping(turn.chatId); typing = true; }
  catch { /* The answer matters more than the typing indicator. */ }
  const stopTyping = async (): Promise<void> => {
    if (!typing) return;
    typing = false;
    try { await input.client.chats.stopTyping(turn.chatId); } catch { /* As above. */ }
  };
  const threadId = threads.get(turn.chatId);
  let outcome: CodexAnswer | undefined;
  try {
    outcome = await input.run({
      prompt: codexPrompt(turn.sender, turn.text), signal: input.signal,
      ...(threadId === undefined ? {} : { threadId }),
    });
  } catch { /* Named below, with everything else Codex can fail at. */ }
  if (outcome?.threadId) threads.set(turn.chatId, outcome.threadId);
  // A session Codex can no longer open would fail on every later message, so
  // the next one in this chat opens a new one.
  else if (outcome && outcome.code !== 0) threads.delete(turn.chatId);
  if (!outcome || outcome.code !== 0 || !outcome.answer) {
    await stopTyping();
    input.say(`Codex gave no answer to @${turn.sender}, so nothing was sent.`);
    return;
  }
  try {
    await input.client.chats.messages.send(turn.chatId, {
      message: {
        parts: [{ type: "text", value: outcome.answer.slice(0, MAX_RELAY_TEXT) }],
        // The message that arrived is the key, so a retry after a dropped
        // connection cannot answer the same person twice.
        idempotency_key: replyKey(turn.eventId),
      },
    });
    input.say(`Sent the answer to @${turn.sender}.`);
  } catch {
    input.say(`The answer to @${turn.sender} did not reach Relay.`);
  } finally {
    await stopTyping();
  }
};

/**
 * Answers every message that arrives, one at a time, until the signal stops it.
 * Relay is told the message is handled only after the answer is sent, so a
 * Codex run that dies with the connection is asked again on the next one.
 */
export const runCodexBridge = async (input: CodexBridgeInput): Promise<void> => {
  const threads = new Map<string, string>();
  const answered = new Set<string>();
  // One folder means one Codex at a time. Two runs of `codex exec` in the same
  // folder, both allowed to write, would work on each other's files, so every
  // message waits for the one before it, in the order they arrived.
  let queue: Promise<void> = Promise.resolve();
  await input.client.websocket.run({
    signal: input.signal,
    onEvent: async (event) => {
      const turn = bridgeTurn(event);
      if (!turn || answered.has(turn.eventId)) return;
      answered.add(turn.eventId);
      // Nothing may be thrown here: a failure would close the connection, and
      // Codex failing to answer one message is not a reason to stop. The wait
      // is inside this call, so Relay is told the message is handled only after
      // the answer is sent.
      queue = queue.then(() => answerOne(turn, threads, input)).catch(() => undefined);
      await queue;
    },
    onFullSync: async () => {
      // This process keeps no copy of any chat, so there is nothing to rebuild.
      input.say("Codex was away longer than Relay keeps its messages. It answers the new ones from now on.");
    },
  });
};
