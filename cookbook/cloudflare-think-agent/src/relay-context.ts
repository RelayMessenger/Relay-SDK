import { Message } from "chat";
import { RelayAdapter, type RelayRawMessage } from "@relaymessenger/chat-sdk-adapter";
import { selectionReply, selectionReplyContext, type MessagePartResponse } from "@relaymessenger/sdk";

/** Think consumes Chat SDK text, not raw Relay parts. Preserve rich input in
 * this model-facing projection only; the shared adapter's display text stays plain. */
export class RelayContextAdapter extends RelayAdapter {
  override parseMessage(raw: RelayRawMessage): Message<RelayRawMessage> {
    const message = super.parseMessage(raw);
    const parts = (raw.message?.parts ?? []) as MessagePartResponse[];
    const replyTo = raw.message?.reply_to;
    const context = selectionReplyContext(selectionReply(parts, replyTo), {
      parts, ...(replyTo ? { reply_to: replyTo } : {}),
    });
    if (!context) return message;
    const text = [message.text, context].filter(Boolean).join("\n\n");
    return new Message<RelayRawMessage>({
      ...message,
      text,
      formatted: { type: "root", children: [{ type: "paragraph", children: [{ type: "text", value: text }] }] },
    });
  }
}
