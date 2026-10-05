import type { RelayAdapter } from "@relaymessenger/chat-sdk-adapter";
import {
  type MessagePartResponse,
  type ReplyTo,
  selectionReply,
  selectionReplyContext,
} from "@relaymessenger/sdk";

/**
 * A selection answer reads as its bullet lines, but the values the person
 * chose live in a component part the adapter's text leaves out. Append them
 * to the message text as data, never as instructions, the way every Relay
 * runtime does (the SDK's selectionReplyContext), so the turn and the saved
 * history both know what was chosen.
 */
export function withSelectionReplies(adapter: RelayAdapter): RelayAdapter {
  const parse = adapter.parseMessage.bind(adapter);
  adapter.parseMessage = (raw) => {
    const message = parse(raw);
    const source = raw.message;
    // The adapter's part types are the same wire JSON as the SDK's, typed
    // with optional reactions; the SDK helpers read only type and values.
    // A2UI data parts are left to withCardTaps, which reads the tap into
    // resolved data beside the card it was made on.
    const parts = ((source && Array.isArray(source.parts) ? source.parts : []) as unknown as MessagePartResponse[])
      .filter((part) => (part.type as string) !== "data");
    const replyTo = (source && "reply_to" in source ? source.reply_to : null) as ReplyTo | null | undefined;
    const context = selectionReplyContext(selectionReply(parts, replyTo), { parts, reply_to: replyTo });
    if (context) message.text = [message.text, context].filter(Boolean).join("\n\n");
    return message;
  };
  return adapter;
}
