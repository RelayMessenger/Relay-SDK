import { inboundMediaPrompt, type InboundMediaOptions } from "./inbound-media.js";
import { isAbsolute } from "node:path";
import { findExecutable } from "./runtime-sniff.js";
import type Relay from "@relaymessenger/sdk";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { bridgeTurn, codexPrompt, sendAnswer, type BridgeTurn } from "./codex-bridge.js";
import type { ClaudeThreadStore } from "./claude-threads.js";

export interface ClaudeBridgeInput {
  client: Pick<Relay, "chats" | "websocket">;
  media?: Omit<InboundMediaOptions, "chatId">;
  claude: { executable: string };
  cwd: string;
  threads: ClaudeThreadStore;
  mcpServer: { command: string; args: readonly string[]; env: Record<string, string> };
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
            mcpServers: { relay: {
              command: input.mcpServer.command,
              args: [...input.mcpServer.args],
              env: { ...input.mcpServer.env },
            } },
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
            if (message.subtype !== "success" || message.is_error) throw new Error("Claude turn failed.");
            answer = message.result.trim();
          }
        }
      } catch { answer = ""; }
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
