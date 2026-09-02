import { action, type Action } from "@cloudflare/think";
import type { RelayAdapter } from "@relaymessenger/chat-sdk-adapter";
import { encodeRelayThreadId } from "@relaymessenger/chat-sdk-adapter";
import { z } from "zod";

const replySchema = z.object({
  text: z.string().trim().min(1).max(10_000),
}).strict();

export interface RelayTurnIdentity {
  chatId: string;
  messageId: string;
}

interface ReplyDependencies {
  adapter(): RelayAdapter;
  turn(): RelayTurnIdentity;
}

export function relayReplyIdempotencyKey(messageId: string): string {
  return `relay-agent-starter:${messageId}`;
}

export type RelayReplyResult =
  | { messageId: string; status: "sent" }
  | { status: "aborted" };

/**
 * Commit the answer as one Relay Message through the adapter's own client.
 *
 * The adapter is the only Relay client in the Worker, so this send shares its
 * `fetch` override, its credential resolver and its idempotency key with every
 * other Relay call the agent makes.
 */
export async function sendRelayReply(
  adapter: RelayAdapter,
  turn: RelayTurnIdentity,
  text: string,
  signal?: AbortSignal,
): Promise<RelayReplyResult> {
  // A superseded turn must not commit its answer. Relay has no unsend, so the
  // signal is checked at the last moment before the message becomes real.
  if (signal?.aborted) return { status: "aborted" };
  const sent = await adapter.postMessage(
    encodeRelayThreadId({ chatId: turn.chatId }),
    { markdown: text },
  );
  return { messageId: sent.id, status: "sent" };
}

export function createReplyAction(deps: ReplyDependencies): Action {
  return action({
    description:
      "Send the complete response as one canonical Relay Message. "
      + "Call this exactly once.",
    inputSchema: replySchema,
    idempotencyKey: () => `message:${deps.turn().messageId}`,
    execute: ({ text }, context) =>
      sendRelayReply(
        deps.adapter(),
        deps.turn(),
        text,
        context.signal,
      ),
  });
}
