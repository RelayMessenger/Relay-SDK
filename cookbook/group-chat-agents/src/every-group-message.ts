import type { RelayAdapter } from "@relaymessenger/chat-sdk-adapter";

/**
 * Lets the agent hear every group Message, not only the ones that mention it.
 *
 * Chat SDK hands an unsubscribed group Message to a handler only when it
 * mentions the bot, and Think registers no handler for the rest. So every
 * group Message, from a person or another agent, is marked as addressed to
 * this agent; the speak gate and the agent's own model decide what to do.
 */
export function withEveryGroupMessage(adapter: RelayAdapter): RelayAdapter {
  const parse = adapter.parseMessage.bind(adapter);
  adapter.parseMessage = (raw) => {
    const message = parse(raw);
    const chat = (raw.message as { chat?: { is_group?: unknown } } | undefined)?.chat;
    if (raw.eventType === "message.received" && chat?.is_group === true) message.isMention = true;
    return message;
  };
  return adapter;
}
