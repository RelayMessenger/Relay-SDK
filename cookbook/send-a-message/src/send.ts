import type { MessageSendParams } from "@relaymessenger/sdk";

export interface RelayTextMessageClient {
  chats: {
    messages: {
      send(chatId: string, body: MessageSendParams): Promise<unknown>;
    };
  };
}

export interface TextMessageInput {
  chatId: string;
  idempotencyKey: string;
  text: string;
}

export async function sendTextMessage(
  relay: RelayTextMessageClient,
  input: TextMessageInput,
): Promise<unknown> {
  if (
    input.idempotencyKey.length < 1
    || input.idempotencyKey.length > 255
  ) {
    throw new RangeError("idempotencyKey must be 1–255 characters");
  }
  if (input.text.length < 1 || input.text.length > 10_000) {
    throw new RangeError("text must be 1–10,000 UTF-16 code units");
  }

  return relay.chats.messages.send(input.chatId, {
    message: {
      parts: [{ type: "text", value: input.text }],
      idempotency_key: input.idempotencyKey,
    },
  });
}
