import { action, type Action } from "@cloudflare/think";
import type { RelayAdapter } from "@relaymessenger/chat-sdk-adapter";
import { encodeRelayThreadId } from "@relaymessenger/chat-sdk-adapter";
import { z } from "zod";
import { selectionPart, partsWithSelection, type SelectionOption } from "@relaymessenger/sdk";

const replySchema = z.object({
  text: z.string().trim().min(1).max(10_000),
  selection: z.array(z.object({
    value: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
    label: z.string().trim().min(1).max(80),
  }).strict()).min(1).max(25).optional(),
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
  selection?: SelectionOption[],
): Promise<RelayReplyResult> {
  // A superseded turn must not commit its answer. Relay has no unsend, so the
  // signal is checked at the last moment before the message becomes real.
  if (signal?.aborted) return { status: "aborted" };
  if (selection) {
    const part = selectionPart(selection);
    if (typeof part === "string") throw new Error(part);
    const sent = await adapter.postMessageParts(
      encodeRelayThreadId({ chatId: turn.chatId }),
      partsWithSelection(text, part),
    );
    return { messageId: sent.id, status: "sent" };
  }
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
      + "Call this exactly once. For multiple choices, supply selection with stable values and readable labels, and a nonblank text question.",
    inputSchema: replySchema,
    idempotencyKey: () => `message:${deps.turn().messageId}`,
    execute: ({ text, selection }, context) =>
      sendRelayReply(
        deps.adapter(),
        deps.turn(),
        text,
        context.signal,
        selection,
      ),
  });
}
