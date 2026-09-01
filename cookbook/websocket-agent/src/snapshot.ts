import type { Chat, Message } from "@relaymessenger/sdk";

export interface RelayStateSnapshot {
  chats: Chat[];
  messages: Message[];
}

interface AsyncPage<T> extends AsyncIterable<T> {}

export interface RelaySnapshotSource {
  chats: {
    listChats(query?: { limit?: number }): Promise<AsyncPage<Chat>>;
    messages: {
      list(
        chatId: string,
        query?: { limit?: number },
      ): Promise<AsyncPage<Message>>;
    };
  };
}

export async function loadCompleteRelayState(
  relay: RelaySnapshotSource,
): Promise<RelayStateSnapshot> {
  const chats: Chat[] = [];
  const messages: Message[] = [];
  const chatIds = new Set<string>();
  const messageIds = new Set<string>();

  for await (const chat of await relay.chats.listChats({ limit: 100 })) {
    if (chatIds.has(chat.id)) {
      throw new Error(`FULL sync returned duplicate Chat ${chat.id}`);
    }
    chatIds.add(chat.id);
    chats.push(chat);
    for await (
      const message of await relay.chats.messages.list(
        chat.id,
        { limit: 100 },
      )
    ) {
      if (message.chat_id !== chat.id) {
        throw new Error(
          `FULL sync Message ${message.id} belongs to ${message.chat_id}, not ${chat.id}`,
        );
      }
      if (messageIds.has(message.id)) {
        throw new Error(`FULL sync returned duplicate Message ${message.id}`);
      }
      messageIds.add(message.id);
      messages.push(message);
    }
  }

  return { chats, messages };
}
