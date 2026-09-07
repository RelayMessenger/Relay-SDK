import type { Chat, Message } from "@relaymessenger/sdk";

import { authorName, messageText } from "./processor.js";

export interface RememberedMessage {
  author: string;
  chatId: string;
  messageId: string;
  rememberedAt: number;
  text: string;
}

interface AsyncPage<T> extends AsyncIterable<T> {}

export interface RelaySnapshotSource {
  chats: {
    listChats(query?: { limit?: number }): Promise<AsyncPage<Chat>>;
    messages: {
      list(chatId: string, query?: { limit?: number }): Promise<AsyncPage<Message>>;
    };
  };
}

/**
 * FULL sync means events were missed, so the conversation this agent
 * remembers has a hole in it. Rebuild every Chat's thread from REST rather
 * than plan from a partial transcript. The agent's own Messages are left
 * out; what it decided lives in the saved plan.
 */
export async function loadRememberedThreads(
  relay: RelaySnapshotSource,
): Promise<RememberedMessage[]> {
  const remembered: RememberedMessage[] = [];
  const seen = new Set<string>();

  for await (const chat of await relay.chats.listChats({ limit: 100 })) {
    for await (const message of await relay.chats.messages.list(chat.id, { limit: 100 })) {
      if (message.chat_id !== chat.id) {
        throw new Error(
          `FULL sync Message ${message.id} belongs to ${message.chat_id}, not ${chat.id}`,
        );
      }
      if (seen.has(message.id)) {
        throw new Error(`FULL sync returned duplicate Message ${message.id}`);
      }
      seen.add(message.id);
      if (message.is_from_me || message.is_system_message) continue;
      if (!message.from_handle) continue;
      const text = messageText(message.parts ?? []);
      if (!text) continue;
      remembered.push({
        author: authorName(message.from_handle),
        chatId: chat.id,
        messageId: message.id,
        rememberedAt: Date.parse(message.created_at),
        text,
      });
    }
  }

  return remembered;
}
