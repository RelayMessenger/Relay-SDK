import { inboundMediaPrompt, type InboundMediaOptions } from "./inbound-media.js";
import type Relay from "@relaymessenger/sdk";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type McpServer,
  type AuthMethod,
} from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { isAbsolute } from "node:path";
import type { AcpSessionStore } from "./acp-threads.js";
import { bridgeTurn, codexPrompt, sendAnswer, type BridgeTurn } from "./codex-bridge.js";
import { replacesLiveTurn } from "./bridge-turn.js";
import { findExecutable } from "./runtime-sniff.js";
import { packageVersion } from "./config.js";
import { spawnCommand } from "./spawn-command.js";
import { MCP_SERVER_NAME, mcpRemoteServer, type HostedMcp } from "./hosted-mcp.js";

/**
 * What `relay connect cursor|gemini-cli|cline|opencode` leaves running so the
 * agent answers Relay messages by itself.
 *
 * These agents reach Relay through MCP, and MCP cannot start a turn, so a
 * message waits until somebody asks the agent to read it. This is the process
 * that asks. It speaks the Agent Client Protocol (ACP) — the same protocol Zed
 * uses to drive Cursor, Gemini CLI and OpenCode in the background — over the
 * official `@agentclientprotocol/sdk`. It runs the agent's own ACP command
 * (`cursor-agent acp`, `gemini --experimental-acp`, `opencode acp`), gives every
 * chat its own ACP session, and sends the final answer back to the same chat.
 *
 * Relay's own tools travel through the session, natively: Relay's hosted MCP
 * server, with this agent's token, is handed to `session/new` instead of being
 * written into the agent's `mcp.json`, so the agent keeps Relay's send, read and react tools
 * while this process drives its turns. This mirrors `codex-bridge.ts`, which
 * does the same over Codex's `app-server`; the two never share a session file.
 */

/** Relay takes 1 to 255 characters for an idempotency key (contracts/relay-v1-openapi.yaml). */
export const replyKey = (eventId: string): string => `acp-bridge-${eventId}`;

/** What the agent is told this client is (`clientInfo`, InitializeRequest). */
export const CLIENT_NAME = "relaymessenger";

/**
 * One message, as the prompt the agent is given. The agent keeps its Relay
 * tools during the turn, so the prompt says who answers the person: this
 * process sends the final message, and the agent must not send a second one.
 * The same words as `codexPrompt` (codex-bridge.ts), so both bridges say the
 * same thing.
 */
export const acpPrompt: (sender: string, text: string) => string = codexPrompt;

/** What to run for the agent: the file, and the words that put it in ACP mode. */
export interface AcpCommand {
  /** The executable, e.g. `cursor-agent`, or the absolute path connect found. */
  command: string;
  /** The ACP sub-command and flags, e.g. `["acp"]` or `["--experimental-acp"]`. */
  args: readonly string[];
}

/**
 * The file to run for the agent. connect hands over the one its own sniff found
 * on PATH, and the bare name when it found none (connect.ts). Windows has no
 * file called `cursor-agent`: npm installs a `.cmd` shim, so a bare name is
 * looked up again here and, failing that, left with the extension `cmd.exe` can
 * find. The ACP words are kept as they are (runtime-sniff.ts, spawn-command.ts).
 */
export const acpCommand = async (
  found: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<AcpCommand> => {
  if (isAbsolute(found)) return { command: found, args };
  const onPath = await findExecutable(found, env, platform);
  return { command: onPath ?? (platform === "win32" ? `${found}.cmd` : found), args };
};

/**
 * Relay's hosted MCP server as ACP takes it. HTTP is optional in ACP: a client
 * sends an `McpServerHttp` (`type: "http"`, `name`, `url`, `headers` as
 * `{ name, value }` pairs) only to an agent whose `initialize` answer carries
 * `mcpCapabilities.http`, and every agent must take stdio (ACP "Session Setup",
 * MCP Servers; _sources/mcp-hosted-docs-20260926/acp-session-setup.md:374-470;
 * `McpServerHttp`, `McpCapabilities` in @agentclientprotocol/sdk 1.4.0
 * schema/types.gen). An agent without it gets the stdio `mcp-remote` entry
 * Relay-Docs gives clients without remote support (hosted-mcp.ts).
 */
export const relayMcpServer = (
  mcp: HostedMcp,
  capabilities: { http?: boolean } | null | undefined,
): McpServer => {
  if (capabilities?.http === true) {
    return {
      type: "http",
      name: MCP_SERVER_NAME,
      url: mcp.url,
      headers: [{ name: "Authorization", value: `Bearer ${mcp.token}` }],
    };
  }
  const remote = mcpRemoteServer(mcp);
  return {
    name: MCP_SERVER_NAME,
    command: remote.command,
    args: remote.args,
    env: Object.entries(remote.env).map(([name, value]) => ({ name, value })),
  };
};

/**
 * Nobody is at the keyboard, so a tool the agent asks to run is allowed the
 * same way Codex's `approvalPolicy: "never"` allows it: the agent proceeds. The
 * first `allow` option is chosen; when none is offered the request is cancelled
 * (`RequestPermissionOutcome`, schema/types.gen), which the reference client
 * does too (openclaw/src/acp/client-helpers.ts, `resolvePermissionRequest`).
 */
export const autoPermission = (params: RequestPermissionRequest): RequestPermissionResponse => {
  const allow = params.options.find((option) => option.kind === "allow_once")
    ?? params.options.find((option) => option.kind === "allow_always");
  return allow
    ? { outcome: { outcome: "selected", optionId: allow.optionId } }
    : { outcome: { outcome: "cancelled" } };
};

/**
 * How long a loaded session must stay silent before the bridge prompts it.
 * ACP says an agent replays the whole conversation and only then answers
 * `session/load` (Session Setup, "Loading Sessions";
 * _sources/mcp-hosted-docs-20260926/acp-session-setup.md:137,181). Gemini CLI
 * answers first and replays after (`session.streamHistory` is not awaited,
 * acpSessionManager.ts `loadSession`; acpSession.ts:241), so without a wait the
 * old answers stream into the new turn's answer (the Daytona run of
 * 2026-09-26 sent "Probe a8749ac6Probe a8749ac6"). An agent that follows the
 * spec sends nothing after its answer and costs one window.
 */
export const REPLAY_QUIET_MS = 300;
export const REPLAY_MAX_MS = 10_000;

/** ACP's `auth_required` error code (`RequestError.authRequired`, jsonrpc.js). */
export const AUTH_REQUIRED = -32000;

/**
 * Sign-in methods whose credential is an environment variable the agent reads
 * itself, by method id. ACP leaves the choice of method to the client
 * (Authentication, "Protocol-driven authentication";
 * _sources/mcp-hosted-docs-20260926/acp-v1-authentication.md:138-170), and no
 * person is at this client to choose, so the bridge picks only a method whose
 * credential is already present, the rule acpx follows (`selectAuthMethod`,
 * _sources/network-20260926/mcp-xos/acpx-src-src_acp_client.ts.txt:2054-2103).
 * `gemini-api-key` is Gemini CLI's `AuthType.USE_GEMINI`, read from
 * `GEMINI_API_KEY` (Gemini CLI docs/reference/configuration.md; Zed hands the
 * same variable to Gemini, zed-agent_servers-custom.rs.txt:250-253).
 */
export const ENV_AUTH_METHODS: Readonly<Record<string, readonly string[]>> = {
  "gemini-api-key": ["GEMINI_API_KEY"],
};

/** The advertised method whose credential this environment holds, when there is one. */
export const authMethodFromEnv = (
  methods: readonly AuthMethod[] | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined => methods?.find((method) =>
  !("type" in method && method.type === "terminal")
  && (ENV_AUTH_METHODS[method.id] ?? []).some((name) => Boolean(env[name]?.trim())))?.id;

/** An ACP error, an Error, or anything thrown, as one line. */
export const acpFailure = (error: unknown): string => {
  if (error instanceof Error && !("code" in error)) return error.message.trim().replace(/\s+/gu, " ");
  const record = (error ?? {}) as { message?: unknown; data?: { details?: unknown } };
  const message = typeof record.message === "string" ? record.message : String(error);
  const details = typeof record.data?.details === "string" ? record.data.details : "";
  return `${message}${details && !message.includes(details) ? ` (${details})` : ""}`.trim().replace(/\s+/gu, " ");
};

const isAuthRequired = (error: unknown): boolean =>
  error !== null && typeof error === "object" && (error as { code?: unknown }).code === AUTH_REQUIRED;

/** One running ACP agent, and the calls this bridge makes to it. */
export interface AcpAgent {
  client: Pick<ClientSideConnection, "initialize" | "authenticate" | "newSession" | "loadSession" | "prompt" | "cancel">;
  /**
   * Collect the answer streamed for one session's running turn. Every
   * `agent_message_chunk` of text is handed to the sink until the returned
   * function is called. Turns are serial within a session, so at most one sink
   * is registered per session at a time.
   */
  collect(sessionId: string, sink: (text: string) => void): () => void;
  /**
   * Resolves once the agent has sent nothing for this session for `windowMs`,
   * or after `maxMs` at most. See `REPLAY_QUIET_MS`.
   */
  quiet(sessionId: string, windowMs?: number, maxMs?: number): Promise<void>;
  /** True once the agent advertised `session/load`; set after `initialize`. */
  canLoad: boolean;
  /** What the agent said it can reach an MCP server over; set after `initialize`. */
  mcp?: { http?: boolean } | null;
  /** The sign-in methods the agent advertised in `initialize`. */
  authMethods?: readonly AuthMethod[];
  /** Set once `authenticate` has been sent, so it is sent at most once per process. */
  authenticated?: boolean;
  /** Resolves, with the line to show the person, when the process is gone. */
  stopped: Promise<string>;
  /** True once the process is gone, so the next message starts a new one. */
  gone(): boolean;
}

/** Starts the agent's ACP command and drives it over the official SDK. */
export const startAcpAgent = (
  acp: AcpCommand,
  cwd: string,
  signal: AbortSignal,
): AcpAgent => {
  // Started the way every other command this CLI runs is started, so the `.cmd`
  // shim npm installs on Windows runs too (spawn-command.ts). Nothing a person
  // wrote travels on this command line: messages go down the ACP stream.
  const child = spawnCommand(acp.command, acp.args, {
    cwd, stdio: ["pipe", "pipe", "pipe"], signal,
  });
  const sinks = new Map<string, (text: string) => void>();
  const heard = new Map<string, number>();
  let dead = false;
  let announce!: (line: string) => void;
  const stopped = new Promise<string>((resolve) => { announce = resolve; });
  const die = (line: string): void => {
    if (dead) return;
    dead = true;
    announce(line);
  };

  // The agent writes its own diagnostics to stderr; the person watching this
  // terminal is waiting for an answer, not for a log.
  child.stderr?.resume();
  child.stdin?.on("error", () => { /* The process went away mid-write; `close` says so. */ });
  child.once("error", () => die("The agent could not be started. Trying again on the next message."));
  child.once("close", () => die("The agent stopped. Starting it again on the next message."));

  if (!child.stdin || !child.stdout) {
    die("The agent gave this bridge no way to talk to it.");
  }
  const input = Writable.toWeb(child.stdin!);
  const output = Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, output);

  const handlers: Client = {
    sessionUpdate: async (params: SessionNotification): Promise<void> => {
      heard.set(params.sessionId, Date.now());
      const sink = sinks.get(params.sessionId);
      if (!sink) return;
      const update = params.update;
      if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
        sink(update.content.text);
      }
    },
    requestPermission: async (params: RequestPermissionRequest): Promise<RequestPermissionResponse> =>
      autoPermission(params),
  };
  const client = new ClientSideConnection(() => handlers, stream);

  return {
    client,
    collect: (sessionId, sink) => {
      sinks.set(sessionId, sink);
      return () => { if (sinks.get(sessionId) === sink) sinks.delete(sessionId); };
    },
    quiet: async (sessionId, windowMs = REPLAY_QUIET_MS, maxMs = REPLAY_MAX_MS) => {
      // The window starts now: a replay that has not begun yet still counts.
      const from = Date.now();
      const until = from + maxMs;
      for (;;) {
        const since = Date.now() - Math.max(heard.get(sessionId) ?? 0, from);
        if (since >= windowMs || Date.now() >= until || dead) return;
        await new Promise((resolve) => setTimeout(resolve, Math.min(windowMs - since, until - Date.now())));
      }
    },
    canLoad: false,
    stopped,
    gone: () => dead,
  };
};

/** The turn the agent is running for one chat right now. */
export interface LiveTurn {
  sessionId: string;
  /** A newer message for this chat replaced it, so its answer is not sent. */
  dropped: boolean;
}

/** How a turn ended (`StopReason`, schema/types.gen), and what it said. */
export interface TurnOutcome {
  /** `end_turn`, `cancelled`, `refusal`, `max_tokens` or `max_turn_requests`. */
  stopReason: string;
  answer: string;
}

/**
 * Runs one turn in one session, and gives back what the agent answered.
 *
 * The answer is every `agent_message_chunk` of text the agent streamed before
 * `session/prompt` returned its stop reason, joined in order.
 */
export const runTurn = async (
  agent: AcpAgent,
  input: { sessionId: string; prompt: string; onStarted(turn: LiveTurn): void },
): Promise<TurnOutcome> => {
  const chunks: string[] = [];
  const stop = agent.collect(input.sessionId, (text) => chunks.push(text));
  try {
    input.onStarted({ sessionId: input.sessionId, dropped: false });
    const response = await Promise.race([
      agent.client.prompt({ sessionId: input.sessionId, prompt: [{ type: "text", text: input.prompt }] }),
      agent.stopped.then((line): never => { throw new Error(line); }),
    ]);
    return { stopReason: response.stopReason, answer: chunks.join("").trim() };
  } finally { stop(); }
};

export interface AcpBridgeInput {
  client: Pick<Relay, "chats" | "paymentRequests" | "websocket">;
  media?: Omit<InboundMediaOptions, "chatId">;
  /** The agent's ACP command, and the folder to run it in. */
  acp: AcpCommand;
  cwd: string;
  /** Relay's hosted MCP server and this agent's token, handed to every
   * session so Relay's tools travel with it. */
  mcp: HostedMcp;
  /** The label shown to the person, e.g. "Cursor". */
  label: string;
  /** Which ACP session belongs to which chat, across restarts. */
  sessions: AcpSessionStore;
  signal: AbortSignal;
  /** One line to the terminal the person is watching. */
  say(line: string): void;
  /** Where a sign-in method's credential is looked for; this process's own by default. */
  env?: NodeJS.ProcessEnv;
}

/** One line of what arrived, short enough to read at a glance. */
const arrival = (turn: BridgeTurn): string =>
  `@${turn.sender}  ${turn.text.replace(/\s+/gu, " ").slice(0, 160)}`;

/** What one chat has running, and what is waiting behind it. */
interface ChatLane {
  /** Turns in one chat run one after another, in the order the messages arrived. */
  chain: Promise<void>;
  live?: LiveTurn | undefined;
  /** Whether the live turn answers another agent (`replacesLiveTurn`). */
  liveFromAgent?: boolean | undefined;
}

/**
 * Answers every message that arrives until the signal stops it.
 *
 * Turns run one at a time inside a chat and at the same time across chats,
 * which is what one agent with one session per chat allows. A person's
 * message for a chat whose turn for a person is still running cancels that
 * turn (`session/cancel`) and takes its place; the cancelled turn sends
 * nothing. An agent's message waits for the running turn instead
 * (`replacesLiveTurn`).
 */
export const runAcpBridge = async (input: AcpBridgeInput): Promise<void> => {
  const answered = new Set<string>();
  const lanes = new Map<string, ChatLane>();
  let session: Promise<AcpAgent> | undefined;
  let sessionGone = false;
  /** The ACP session each chat is holding open in the agent running now. */
  let opened = new Map<string, string>();

  const acpAgent = (): Promise<AcpAgent> => {
    if (session && !sessionGone) return session;
    opened = new Map();
    session = (async () => {
      const started = startAcpAgent(input.acp, input.cwd, input.signal);
      // A stop the person asked for, with Control-C, is not news.
      void started.stopped.then((line) => {
        sessionGone = true;
        if (!input.signal.aborted) input.say(line);
      });
      // `initialize` negotiates the protocol version and reads back whether the
      // agent can take an old session back with `session/load` (ACP spec,
      // Initialization). The reference client sends the same capabilities
      // (openclaw/src/acp/client.ts).
      const info = await started.client.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo: { name: CLIENT_NAME, title: "Relay", version: packageVersion() },
      });
      started.canLoad = info.agentCapabilities?.loadSession === true;
      started.mcp = info.agentCapabilities?.mcpCapabilities ?? null;
      started.authMethods = info.authMethods ?? [];
      return started;
    })().catch((error: unknown) => {
      sessionGone = true;
      throw error instanceof Error ? error : new Error(String(error));
    });
    sessionGone = false;
    return session;
  };

  /**
   * The session for this chat: the saved one if the agent still has it, a new
   * one if it does not. `session/load` is only tried when the agent said it can
   * (`agentCapabilities.loadSession`); a load the agent refuses starts a new
   * session, the same fallback the Codex bridge makes for a lost thread.
   */
  /**
   * Runs one session call, and when the agent answers `auth_required`, signs in
   * the way ACP's initialize → authenticate flow gives it: `authenticate` with
   * an advertised method, once per agent process, then the call again. Gemini
   * CLI answers `session/load` this way whenever its settings name no sign-in
   * method, even though `session/new` works (acpSessionManager.ts,
   * `prepareSessionConfig`; the Daytona run of 2026-09-26).
   */
  const signedIn = async <T>(agent: AcpAgent, call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      if (!isAuthRequired(error) || agent.authenticated) throw error;
      const methodId = authMethodFromEnv(agent.authMethods, input.env ?? process.env);
      if (methodId === undefined) throw error;
      agent.authenticated = true;
      await agent.client.authenticate({ methodId });
      return await call();
    }
  };

  const openSession = async (agent: AcpAgent, chatId: string): Promise<string> => {
    const settings = { cwd: input.cwd, mcpServers: [relayMcpServer(input.mcp, agent.mcp)] };
    // This agent already has the session open; it is taken back by id once per
    // run of the process, not once per message.
    const open = opened.get(chatId);
    if (open !== undefined) return open;
    const saved = input.sessions.get(chatId);
    if (saved !== undefined && agent.canLoad) {
      try {
        await signedIn(agent, () => agent.client.loadSession({ ...settings, sessionId: saved }));
        await agent.quiet(saved);
        opened.set(chatId, saved);
        return saved;
      } catch { /* Named below, once, for the one case a person can act on. */ }
      input.say(`${input.label} no longer has this chat's session. It starts a new one.`);
    }
    const created = await signedIn(agent, () => agent.client.newSession(settings));
    const id = created.sessionId;
    if (!id) throw new Error("The agent opened a session with no id.");
    opened.set(chatId, id);
    await input.sessions.set(chatId, id);
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
    let failure: unknown;
    try {
      const agent = await acpAgent();
      const sessionId = await openSession(agent, turn.chatId);
      const media = await inboundMediaPrompt(turn, input.media);
      outcome = await runTurn(agent, {
        sessionId, prompt: acpPrompt(turn.sender, media.text),
        onStarted: (live) => { mine = live; lane.live = live; lane.liveFromAgent = turn.fromAgent; started(); },
      });
    } catch (error) { failure = error; }
    if (lane.live === mine) { lane.live = undefined; lane.liveFromAgent = undefined; }
    if (mine?.dropped === true || outcome?.stopReason === "cancelled") {
      await stopTyping();
      input.say(`A newer message came in, so the answer to @${turn.sender} was dropped.`);
      return;
    }
    // What the agent refused is named, so the person sees why.
    if (failure !== undefined && !input.signal.aborted) {
      await stopTyping();
      input.say(`${input.label} could not answer @${turn.sender}: ${acpFailure(failure)}. Nothing was sent.`);
      return;
    }
    const answer = (outcome?.answer ?? "").trim();
    if (!answer) {
      await stopTyping();
      input.say(`${input.label} gave no answer to @${turn.sender}, so nothing was sent.`);
      return;
    }
    try {
      await sendAnswer(input.client, turn, answer, input.say, replyKey(turn.eventId));
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
      const replacing = live !== undefined && replacesLiveTurn(turn, { fromAgent: lane.liveFromAgent === true });
      if (live !== undefined && replacing) {
        live.dropped = true;
        try { await (await acpAgent()).client.cancel({ sessionId: live.sessionId }); }
        catch { /* The turn ended by itself, which is the same outcome. */ }
      }
      let ready!: () => void;
      const handed = new Promise<void>((resolve) => { ready = resolve; });
      // Nothing may be thrown here: a failure would close the connection, and
      // the agent failing to answer one message is not a reason to stop.
      lane.chain = lane.chain.then(() => answerOne(turn, lane, ready)).catch(() => undefined).finally(() => { ready(); });
      // A message that waits behind the live turn is taken now, so the turn
      // it waits for does not hold this connection for every other chat.
      if (live !== undefined && !replacing) ready();
      // Relay is told the message is handled once the agent is working on it.
      // The rest of the turn does not hold this connection, because every other
      // chat's messages, and the next message in this one, arrive down it.
      await handed;
    },
    onFullSync: async () => {
      // This process keeps no copy of any chat, so there is nothing to rebuild.
      // Throwing here would not stop the bridge: the SDK closes the socket and
      // reconnects, Relay re-issues the same FULL sync, and no message is ever
      // answered again. Acknowledge it and answer the new ones.
      input.say(`${input.label} was away longer than Relay keeps its messages. It answers the new ones from now on.`);
    },
  });
};
