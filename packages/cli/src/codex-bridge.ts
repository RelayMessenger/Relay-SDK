import type Relay from "@relaymessenger/sdk";
import type { MessagePartResponse, RelayWebhookEvent } from "@relaymessenger/sdk";
import type { CodexThreadStore } from "./codex-threads.js";
import { isAbsolute } from "node:path";
import { findExecutable } from "./runtime-sniff.js";
import { packageVersion } from "./config.js";
import { spawnCommand } from "./spawn-command.js";

/**
 * What `relay connect codex` leaves running so Codex answers by itself.
 *
 * Codex reaches Relay through MCP, and MCP cannot start a turn, so a message
 * waits until somebody asks Codex to read it. Claude Code, Hermes and OpenClaw
 * answer on their own because a long-lived process pushes messages into them.
 * This is that process for Codex: it holds the agent's event connection, runs
 * one `codex app-server` in the folder connect ran in, gives every chat its own
 * Codex thread, and sends the final answer back to the same chat.
 *
 * `codex app-server` is the interface Codex's own desktop app and its VS Code
 * extension speak: newline-delimited JSON-RPC on stdin and stdout. One process
 * holds many threads, takes a thread back by id after a restart, and stops a
 * turn that is already running. It runs the `codex` already on this computer,
 * so the person's own sign-in, settings and Relay MCP tools
 * (`~/.codex/config.toml`, written by connect) are the ones Codex uses.
 */

/** Relay takes 1 to 255 characters for an idempotency key (contracts/relay-v1-openapi.yaml). */
export const replyKey = (eventId: string): string => `codex-bridge-${eventId}`;

/** The longest text Relay takes in one message part. */
export const MAX_RELAY_TEXT = 10_000;

/**
 * `SandboxMode` (codex-app-server-protocol-0.154.0, v2/ThreadStartParams.json,
 * `definitions.SandboxMode`): Codex may write files in the folder it was
 * started in, and nowhere else.
 */
export const CODEX_SANDBOX = "workspace-write";

/**
 * `AskForApproval` (same file, `definitions.AskForApproval`): nobody is at the
 * keyboard to answer a question, so Codex is never asked one. Passing a
 * person's approvals through the chat is its own piece of work.
 */
export const CODEX_APPROVAL_POLICY = "never";

/** The one sub-command, over stdin and stdout, which is where it listens by default. */
export const APP_SERVER_ARGS = ["app-server"] as const;

/** What app-server is told this client is (`ClientInfo`, ClientRequest.json). */
export const CLIENT_NAME = "relaymessenger";

/**
 * One message, as the prompt Codex is given. Codex keeps its Relay tools during
 * the turn, so the prompt says who answers the person: this process sends the
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
 * The protocol, as far as this bridge needs it. Every shape here is written by
 * hand from the JSON Schema the installed Codex generates for itself
 * (`codex app-server generate-json-schema`, codex-cli 0.154.0, archived at
 * `_sources/codex-app-server-protocol-0.154.0/`), and each one names the file
 * it came from. The generated TypeScript is not copied in: it is hundreds of
 * files for the four calls below.
 *
 * The envelope is Codex's own, not JSON-RPC 2.0's: a request is
 * `{id, method, params}` and carries no `jsonrpc` field (JSONRPCRequest.json
 * requires `id` and `method` only).
 */
interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  /** `JSONRPCErrorError.json`: `code` and `message` are required. */
  error?: { code?: number; message?: string };
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

/** One notification app-server sent, with its parameters. */
export interface AppServerNotification {
  method: string;
  params: Record<string, unknown>;
}

/** One running `codex app-server`, and the calls this bridge makes to it. */
export interface CodexAppServer {
  request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  notify(method: string, params: Record<string, unknown>): void;
  /** Every notification, until the returned function is called. */
  watch(handler: (note: AppServerNotification) => void): () => void;
  /** Resolves, with the line to show the person, when the process is gone. */
  stopped: Promise<string>;
  /** True once the process is gone, so the next message starts a new one. */
  gone(): boolean;
}

/** What to run for Codex: the file, and anything that comes before `app-server`. */
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

/** Starts `codex app-server` and speaks to it over its own stdin and stdout. */
export const startAppServer = (
  codex: CodexCommand,
  cwd: string,
  signal: AbortSignal,
): CodexAppServer => {
  // Started the way every other command this CLI runs is started, so the `.cmd`
  // shim npm installs on Windows runs too (spawn-command.ts). Nothing a person
  // wrote travels on this command line: messages go down stdin as JSON.
  const child = spawnCommand(codex.command, [...codex.args ?? [], ...APP_SERVER_ARGS], {
    cwd, stdio: ["pipe", "pipe", "pipe"], signal,
  });
  const pending = new Map<number, { resolve(value: Record<string, unknown>): void; reject(error: Error): void }>();
  const watchers = new Set<(note: AppServerNotification) => void>();
  let lastId = 0;
  let dead = false;
  let announce!: (line: string) => void;
  const stopped = new Promise<string>((resolve) => { announce = resolve; });

  const write = (message: RpcMessage): void => {
    child.stdin?.write(`${JSON.stringify(message)}\n`);
  };
  const die = (line: string): void => {
    if (dead) return;
    dead = true;
    for (const waiting of pending.values()) waiting.reject(new Error(line));
    pending.clear();
    announce(line);
  };

  const take = (line: string): void => {
    const text = line.trim();
    if (!text.startsWith("{")) return;
    let message: RpcMessage;
    try { message = JSON.parse(text) as RpcMessage; } catch { return; }
    if (message.id !== undefined && message.method === undefined) {
      const waiting = pending.get(Number(message.id));
      if (!waiting) return;
      pending.delete(Number(message.id));
      if (message.error) waiting.reject(new Error(message.error.message ?? "codex app-server refused that call."));
      else waiting.resolve(asRecord(message.result));
      return;
    }
    if (message.id !== undefined && message.method !== undefined) {
      // app-server asks a client to approve what its settings do not allow it
      // to do by itself. This bridge approves nothing, and a request left
      // unanswered would hold the turn open, so it is refused in JSON-RPC's
      // own words.
      write({ id: message.id, error: { code: -32601, message: "This Relay bridge answers no app-server requests." } });
      return;
    }
    if (message.method === undefined) return;
    const note = { method: message.method, params: asRecord(message.params) };
    for (const watcher of [...watchers]) watcher(note);
  };

  let rest = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    rest += chunk;
    for (;;) {
      const at = rest.indexOf("\n");
      if (at < 0) break;
      take(rest.slice(0, at));
      rest = rest.slice(at + 1);
    }
  });
  // Codex writes its own diagnostics to stderr; the person watching this
  // terminal is waiting for an answer, not for a log.
  child.stderr?.resume();
  child.stdin?.on("error", () => { /* The process went away mid-write; `close` says so. */ });
  child.once("error", () => die("Codex could not be started. Trying again on the next message."));
  child.once("close", () => die("Codex stopped. Starting it again on the next message."));

  return {
    request: async (method, params) => {
      if (dead) throw new Error("Codex is not running.");
      lastId += 1;
      const id = lastId;
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try { write({ id, method, params }); }
        catch (error) { pending.delete(id); reject(error instanceof Error ? error : new Error(String(error))); }
      });
    },
    notify: (method, params) => { write({ method, params }); },
    watch: (handler) => { watchers.add(handler); return () => { watchers.delete(handler); }; },
    stopped,
    gone: () => dead,
  };
};

/** The turn app-server is running for one chat right now. */
export interface LiveTurn {
  threadId: string;
  turnId: string;
  /** A newer message for this chat replaced it, so its answer is not sent. */
  dropped: boolean;
}

/** How a turn ended (`TurnStatus`, v2/TurnStartResponse.json), and what it said. */
export interface TurnOutcome {
  /** `completed`, `interrupted`, `failed` or `inProgress`. */
  status: string;
  answer: string;
}

/**
 * Which turn a notification is about. `item/completed` and
 * `item/agentMessage/delta` carry `turnId`; `turn/completed` carries the whole
 * turn instead, with the id inside it (v2/ItemCompletedNotification.json,
 * v2/AgentMessageDeltaNotification.json, v2/TurnCompletedNotification.json).
 */
const turnOf = (note: AppServerNotification): string => {
  if (typeof note.params.turnId === "string") return note.params.turnId;
  const id = asRecord(note.params.turn).id;
  return typeof id === "string" ? id : "";
};

/**
 * Whether an agent message is the turn's answer rather than something said
 * along the way. `MessagePhase` (v2/ItemCompletedNotification.json) is
 * `commentary` or `final_answer`, and its own description says providers do not
 * send it every time, so a message with no phase counts as the answer.
 */
export const isFinalMessage = (phase: unknown): boolean =>
  phase === undefined || phase === null || phase === "final_answer";

/**
 * Runs one turn in one thread, and gives back what Codex answered.
 *
 * The answer is the text of the last final agent message before
 * `turn/completed`. The streamed pieces (`item/agentMessage/delta`) are only
 * used when no completed message arrived at all.
 */
export const runTurn = async (
  server: CodexAppServer,
  input: { threadId: string; prompt: string; onStarted(turn: LiveTurn): void },
): Promise<TurnOutcome> => {
  const answers: string[] = [];
  const deltas: string[] = [];
  let turnId: string | undefined;
  const early: AppServerNotification[] = [];
  let settle!: (outcome: TurnOutcome) => void;
  const finished = new Promise<TurnOutcome>((resolve) => { settle = resolve; });

  const take = (note: AppServerNotification): void => {
    if (turnOf(note) !== turnId) return;
    if (note.method === "item/agentMessage/delta") {
      if (typeof note.params.delta === "string") deltas.push(note.params.delta);
      return;
    }
    if (note.method === "item/completed") {
      const item = asRecord(note.params.item);
      if (item.type === "agentMessage" && typeof item.text === "string" && isFinalMessage(item.phase)) {
        answers.push(item.text);
      }
      return;
    }
    if (note.method === "turn/completed") {
      const turn = asRecord(note.params.turn);
      settle({
        status: typeof turn.status === "string" ? turn.status : "",
        answer: answers.at(-1) ?? deltas.join(""),
      });
    }
  };

  // Watching starts before the turn does, because app-server may send the first
  // notification in the same breath as the answer to `turn/start`.
  const unwatch = server.watch((note) => { if (turnId === undefined) early.push(note); else take(note); });
  try {
    // `turn/start` (v2/TurnStartParams.json): `threadId` and `input` are the
    // required two, and `TextUserInput` is `{type: "text", text}`. The folder,
    // the sandbox and the approval policy belong to the thread and are set
    // there, so they are not repeated on every turn.
    const started = await server.request("turn/start", {
      threadId: input.threadId,
      input: [{ type: "text", text: input.prompt }],
    });
    const id = asRecord(started.turn).id;
    if (typeof id !== "string" || !id) throw new Error("Codex started a turn with no id.");
    turnId = id;
    input.onStarted({ threadId: input.threadId, turnId: id, dropped: false });
    for (const note of early.splice(0)) take(note);
    return await Promise.race([
      finished,
      server.stopped.then((line): TurnOutcome => { throw new Error(line); }),
    ]);
  } finally { unwatch(); }
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
  /** The `codex` to run, and the folder to run it in. */
  codex: CodexCommand;
  cwd: string;
  /** Which Codex thread belongs to which chat, across restarts. */
  threads: CodexThreadStore;
  signal: AbortSignal;
  /** One line to the terminal the person is watching. */
  say(line: string): void;
}

/** One line of what arrived, short enough to read at a glance. */
const arrival = (turn: BridgeTurn): string =>
  `@${turn.sender}  ${turn.text.replace(/\s+/gu, " ").slice(0, 160)}`;

/** What one chat has running, and what is waiting behind it. */
interface ChatLane {
  /** Turns in one chat run one after another, in the order the messages arrived. */
  chain: Promise<void>;
  live?: LiveTurn | undefined;
}

/**
 * Answers every message that arrives until the signal stops it.
 *
 * Turns run one at a time inside a chat and at the same time across chats,
 * which is what one app-server with one thread per chat allows. A message for a
 * chat whose turn is still running stops that turn (`turn/interrupt`) and takes
 * its place; the stopped turn sends nothing.
 */
export const runCodexBridge = async (input: CodexBridgeInput): Promise<void> => {
  const answered = new Set<string>();
  const lanes = new Map<string, ChatLane>();
  let session: Promise<CodexAppServer> | undefined;
  let sessionGone = false;
  /** The thread each chat is holding open in the app-server running now. */
  let opened = new Map<string, string>();

  const appServer = (): Promise<CodexAppServer> => {
    if (session && !sessionGone) return session;
    opened = new Map();
    session = (async () => {
      const started = startAppServer(input.codex, input.cwd, input.signal);
      // A stop the person asked for, with Control-C, is not news.
      void started.stopped.then((line) => {
        sessionGone = true;
        if (!input.signal.aborted) input.say(line);
      });
      // `initialize` then the `initialized` notification, in that order
      // (v1/InitializeParams.json requires `clientInfo`; ClientNotification.json
      // holds exactly one notification, `initialized`).
      await started.request("initialize", {
        clientInfo: { name: CLIENT_NAME, title: "Relay", version: packageVersion() },
      });
      started.notify("initialized", {});
      return started;
    })().catch((error: unknown) => {
      sessionGone = true;
      throw error instanceof Error ? error : new Error(String(error));
    });
    sessionGone = false;
    return session;
  };

  /**
   * The thread for this chat: the saved one if app-server still has it, a new
   * one if it does not. A thread whose rollout file is gone answers
   * `thread/resume` with an error (`-32600 no rollout found for thread id`,
   * read from codex-cli 0.154.0 on 2026-09-11).
   */
  const openThread = async (server: CodexAppServer, chatId: string): Promise<string> => {
    const settings = {
      cwd: input.cwd,
      sandbox: CODEX_SANDBOX,
      approvalPolicy: CODEX_APPROVAL_POLICY,
    };
    // This app-server already has the thread open; it is taken back by id once
    // per run of the process, not once per message.
    const open = opened.get(chatId);
    if (open !== undefined) return open;
    const saved = input.threads.get(chatId);
    if (saved !== undefined) {
      try {
        // `thread/resume` (v2/ThreadResumeParams.json) needs `threadId`; the
        // rest are the same settings `thread/start` takes.
        const resumed = await server.request("thread/resume", { ...settings, threadId: saved });
        const id = asRecord(resumed.thread).id;
        if (typeof id === "string" && id) {
          opened.set(chatId, id);
          return id;
        }
      } catch { /* Named below, once, for the one case a person can act on. */ }
      input.say("Codex no longer has this chat's thread. It starts a new one.");
    }
    const started = await server.request("thread/start", settings);
    const id = asRecord(started.thread).id;
    if (typeof id !== "string" || !id) throw new Error("Codex opened a thread with no id.");
    opened.set(chatId, id);
    await input.threads.set(chatId, id);
    return id;
  };

  const answerOne = async (turn: BridgeTurn, lane: ChatLane, started: () => void): Promise<void> => {
    let typing = false;
    try { await input.client.chats.startTyping(turn.chatId); typing = true; }
    catch { /* The answer matters more than the typing indicator. */ }
    const stopTyping = async (): Promise<void> => {
      if (!typing) return;
      typing = false;
      try { await input.client.chats.stopTyping(turn.chatId); } catch { /* As above. */ }
    };
    let mine: LiveTurn | undefined;
    let outcome: TurnOutcome | undefined;
    try {
      const server = await appServer();
      const threadId = await openThread(server, turn.chatId);
      outcome = await runTurn(server, {
        threadId, prompt: codexPrompt(turn.sender, turn.text),
        onStarted: (live) => { mine = live; lane.live = live; started(); },
      });
    } catch { /* Named below, with everything else Codex can fail at. */ }
    if (lane.live === mine) lane.live = undefined;
    if (mine?.dropped === true || outcome?.status === "interrupted") {
      await stopTyping();
      input.say(`A newer message came in, so the answer to @${turn.sender} was dropped.`);
      return;
    }
    const answer = (outcome?.answer ?? "").trim();
    if (!answer) {
      await stopTyping();
      input.say(`Codex gave no answer to @${turn.sender}, so nothing was sent.`);
      return;
    }
    try {
      await input.client.chats.messages.send(turn.chatId, {
        message: {
          parts: [{ type: "text", value: answer.slice(0, MAX_RELAY_TEXT) }],
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

  await input.client.websocket.run({
    signal: input.signal,
    onEvent: async (event) => {
      const turn = bridgeTurn(event);
      if (!turn || answered.has(turn.eventId)) return;
      answered.add(turn.eventId);
      input.say(arrival(turn));
      const lane = lanes.get(turn.chatId) ?? { chain: Promise.resolve() };
      lanes.set(turn.chatId, lane);
      const live = lane.live;
      if (live !== undefined) {
        live.dropped = true;
        try { await (await appServer()).request("turn/interrupt", { threadId: live.threadId, turnId: live.turnId }); }
        catch { /* The turn ended by itself, which is the same outcome. */ }
      }
      let ready!: () => void;
      const handed = new Promise<void>((resolve) => { ready = resolve; });
      // Nothing may be thrown here: a failure would close the connection, and
      // Codex failing to answer one message is not a reason to stop.
      lane.chain = lane.chain.then(() => answerOne(turn, lane, ready)).catch(() => undefined).finally(() => { ready(); });
      // Relay is told the message is handled once Codex is working on it. The
      // rest of the turn does not hold this connection, because every other
      // chat's messages, and the next message in this one, arrive down it.
      await handed;
    },
    onFullSync: async () => {
      // This process keeps no copy of any chat, so there is nothing to rebuild.
      input.say("Codex was away longer than Relay keeps its messages. It answers the new ones from now on.");
    },
  });
};
