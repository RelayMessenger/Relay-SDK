import { inboundMediaPrompt, type InboundMediaOptions } from "./inbound-media.js";
import { isAbsolute } from "node:path";
import { findExecutable } from "./runtime-sniff.js";
import type Relay from "@relaymessenger/sdk";
import { query, type SpawnOptions, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import { platformCommand, spawnCommand } from "./spawn-command.js";
import { bridgeTurn, codexPrompt, sendAnswer, type BridgeTurn } from "./codex-bridge.js";
import type { ClaudeThreadStore } from "./claude-threads.js";
import { MCP_SERVER_NAME, claudeMcpServer, type HostedMcp } from "./hosted-mcp.js";

export interface ClaudeBridgeInput {
  client: Pick<Relay, "chats" | "paymentRequests" | "websocket">;
  media?: Omit<InboundMediaOptions, "chatId">;
  claude: { executable: string };
  cwd: string;
  /** The platform the executable runs on; this computer's unless a test says otherwise. */
  platform?: NodeJS.Platform;
  threads: ClaudeThreadStore;
  /** Relay's hosted MCP server and this agent's token (hosted-mcp.ts). */
  mcp: HostedMcp;
  signal: AbortSignal;
  say(line: string): void;
  query?: typeof query;
}

/** Resolve the executable connect found, including npm's Windows shim. */
export const claudeCommand = async (
  found: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<ClaudeBridgeInput["claude"]> => {
  if (isAbsolute(found)) return { executable: found };
  const onPath = await findExecutable(found, env, platform);
  return { executable: onPath ?? (platform === "win32" ? `${found}.cmd` : found) };
};

/** The last bytes Claude Code wrote to stderr, kept to name a failed start. */
const STDERR_TAIL = 2_000;

/**
 * How the Agent SDK starts Claude Code. On Windows npm installs `claude` as the
 * shim `claude.cmd`, and Node refuses to spawn a `.cmd` or `.bat` without a
 * shell (EINVAL, the fix for CVE-2024-27980; Node docs, "Spawning .bat and
 * .cmd files on Windows"). The SDK's own spawn passes no shell, so a shim
 * never starts (the Daytona Windows run of 2026-09-26: `spawn EINVAL`). The SDK
 * takes `spawnClaudeCodeProcess` for exactly this, a spawn the caller owns
 * (sdk.d.ts, `Options.spawnClaudeCodeProcess`), and this CLI already starts
 * every shim through `spawnCommand`, which runs a non-`.exe` through the shell
 * with each argument escaped (spawn-command.ts). Everything else keeps the
 * SDK's own spawn.
 */
export const claudeSpawn = (
  executable: string,
  platform: NodeJS.Platform = process.platform,
): { spawn?: (options: SpawnOptions) => SpawnedProcess; stderr(): string } => {
  let tail = "";
  const stderr = (): string => tail;
  if (!platformCommand(executable, [], platform).shell) return { stderr };
  return { spawn: spawnClaude(platform, (chunk) => { tail = `${tail}${chunk}`.slice(-STDERR_TAIL); }), stderr };
};

/** The spawn itself: `spawnCommand` with the SDK's command, arguments and environment. */
export const spawnClaude = (
  platform: NodeJS.Platform,
  onStderr: (chunk: string) => void,
) => (options: SpawnOptions): SpawnedProcess => {
  const child = spawnCommand(options.command, options.args, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "pipe"],
  }, platform);
  // Read to the end so a full pipe never stalls Claude Code.
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", onStderr);
  return child as unknown as SpawnedProcess;
};

/** One line saying why a turn failed, from the error and what Claude Code last wrote. */
const failureLine = (error: unknown, stderr: string): string => {
  const message = error instanceof Error ? error.message : String(error);
  const last = stderr.trim().split(/\r?\n/u).at(-1)?.trim();
  return last && !message.includes(last) ? `${message} (${last})` : message;
};

interface LiveTurn {
  control: AbortController;
  dropped: boolean;
}

interface ChatLane {
  chain: Promise<void>;
  live?: LiveTurn | undefined;
}

/** One Agent SDK session per Relay chat; newer messages cancel the current turn. */
export const runClaudeBridge = async (input: ClaudeBridgeInput): Promise<void> => {
  const answered = new Set<string>();
  const lanes = new Map<string, ChatLane>();
  const ask = input.query ?? query;
  const spawner = claudeSpawn(input.claude.executable, input.platform);

  const answerOne = async (turn: BridgeTurn, lane: ChatLane, started: () => void): Promise<void> => {
    const mine: LiveTurn = { control: new AbortController(), dropped: false };
    lane.live = mine;
    const abort = (): void => mine.control.abort();
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    let typing = false;
    try {
      let answer = "";
      try {
        if (mine.control.signal.aborted) return;
        try { await input.client.chats.startTyping(turn.chatId); typing = true; }
        catch { /* The answer matters more than the typing indicator. */ }
        if (mine.control.signal.aborted) return;
        const resume = input.threads.get(turn.chatId);
        const media = await inboundMediaPrompt(turn, input.media);
        const result = ask({
          prompt: codexPrompt(turn.sender, media.text),
          options: {
            cwd: input.cwd,
            ...(resume !== undefined ? { resume } : {}),
            pathToClaudeCodeExecutable: input.claude.executable,
            // Like CODEX_APPROVAL_POLICY = "never", no person is at the keyboard.
            permissionMode: "bypassPermissions",
            allowDangerouslySkipPermissions: true,
            mcpServers: { [MCP_SERVER_NAME]: claudeMcpServer(input.mcp) },
            ...(spawner.spawn ? { spawnClaudeCodeProcess: spawner.spawn } : {}),
            abortController: mine.control,
          },
        });
        started();
        for await (const message of result) {
          if (mine.control.signal.aborted) break;
          if (message.type === "system" && message.subtype === "init") {
            await input.threads.set(turn.chatId, message.session_id);
          }
          if (message.type === "result") {
            if (message.subtype !== "success" || message.is_error) {
              throw new Error(message.subtype === "success" ? message.result.trim() || "Claude turn failed." : message.subtype);
            }
            answer = message.result.trim();
          }
        }
      } catch (error) {
        // A turn a newer message or Control-C stopped is not a failure.
        if (!input.signal.aborted && !mine.dropped) {
          input.say(`Claude Code could not answer @${turn.sender}: ${failureLine(error, spawner.stderr())}. Nothing was sent.`);
          return;
        }
      }
      if (input.signal.aborted) return;
      if (mine.dropped) {
        input.say(`A newer message came in, so the answer to @${turn.sender} was dropped.`);
        return;
      }
      if (!answer) {
        input.say(`Claude Code gave no answer to @${turn.sender}, so nothing was sent.`);
        return;
      }
      try {
        await sendAnswer(input.client, turn, answer, input.say);
        input.say(`Sent the answer to @${turn.sender}.`);
      } catch {
        input.say(`The answer to @${turn.sender} did not reach Relay.`);
      }
    } finally {
      input.signal.removeEventListener("abort", abort);
      if (typing) {
        try { await input.client.chats.stopTyping(turn.chatId); } catch { /* As above. */ }
      }
      if (lane.live === mine) lane.live = undefined;
    }
  };

  await input.client.websocket.run({
    signal: input.signal,
    onEvent: async (event) => {
      const turn = bridgeTurn(event);
      if (!turn || answered.has(turn.eventId) || input.signal.aborted) return;
      answered.add(turn.eventId);
      input.say(`@${turn.sender}  ${turn.text.replace(/\s+/gu, " ").slice(0, 160)}`);
      const lane = lanes.get(turn.chatId) ?? { chain: Promise.resolve() };
      lanes.set(turn.chatId, lane);
      if (lane.live) {
        lane.live.dropped = true;
        lane.live.control.abort();
      }
      let ready!: () => void;
      const handed = new Promise<void>((resolve) => { ready = resolve; });
      lane.chain = lane.chain.then(() => answerOne(turn, lane, ready))
        .catch(() => undefined).finally(() => { ready(); });
      await handed;
    },
    onFullSync: async () => {
      // This process keeps no copy of any chat, so there is nothing to rebuild.
      // Throwing here would not stop the bridge: the SDK closes the socket and
      // reconnects, Relay re-issues the same FULL sync, and no message is ever
      // answered again. Acknowledge it and answer the new ones.
      input.say("Claude Code was away longer than Relay keeps its messages. It answers the new ones from now on.");
    },
  });
};
