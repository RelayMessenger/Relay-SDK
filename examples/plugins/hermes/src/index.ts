import { homedir } from "node:os";
import { join } from "node:path";
import {
  createFileCursorStore,
  createRelayClient,
  MemoryDedupe,
  runPollLoop,
  type MessageHandlerContext,
  type RelayClient,
} from "@relaymessenger/core";

export type HermesRelayOptions = {
  token: string;
  baseUrl?: string;
  stateDir?: string;
  /**
   * Called for each inbound user message. Return the text Hermes / your model
   * should send back, or null to acknowledge without replying.
   */
  handleTurn: (ctx: MessageHandlerContext) => Promise<string | null>;
  allowSender?: (senderId: string) => boolean;
  abortSignal?: AbortSignal;
  log?: (line: string) => void;
};

/**
 * Run Relay as a Hermes-style persistent messaging channel.
 * Uses long polling (no public URL), owner allowlist by default, and
 * idempotent replies, following the same transport contract as Relay's
 * OpenClaw plugin.
 */
export async function startHermesRelayChannel(
  options: HermesRelayOptions,
): Promise<void> {
  const stateDir =
    options.stateDir ?? join(homedir(), ".hermes", "relay");
  const client = createRelayClient({
    token: options.token,
    ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
  });
  const me = await client.getMe();
  const cursorStore = createFileCursorStore(join(stateDir, "cursor.json"));
  cursorStore.load();
  const dedupe = new MemoryDedupe();
  const log = options.log ?? console.log;

  log(`[relay/hermes] connected as @${me.handle} (${me.id})`);

  await runPollLoop({
    client,
    getCursor: () => cursorStore.current(),
    setCursor: (cursor) => cursorStore.advance(cursor),
    dedupe,
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    log,
    allowSender:
      options.allowSender ??
      ((senderId) =>
        me.owner_user_id ? senderId === me.owner_user_id : true),
    onMessage: async (ctx) => {
      try {
        await ctx.responding("Working…");
        const replyText = await options.handleTurn(ctx);
        if (replyText !== null) {
          await ctx.reply.text(replyText);
        }
      } finally {
        await ctx.typing(false);
      }
    },
  });
}

export type { MessageHandlerContext, RelayClient };
