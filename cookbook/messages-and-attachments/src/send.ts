import type {
  AttachmentCreateParams,
  AttachmentCreateResponse,
  MessagePart,
  MessageSendParams,
  SupportedContentType,
} from "@relaymessenger/sdk";

export interface RelayMessageAttachmentClient {
  attachments: {
    create(
      body: AttachmentCreateParams,
    ): Promise<AttachmentCreateResponse>;
    upload(
      allocation: AttachmentCreateResponse,
      data: BodyInit,
    ): Promise<void>;
  };
  chats: {
    messages: {
      send(
        chatId: string,
        body: MessageSendParams,
      ): Promise<unknown>;
    };
  };
}

export interface MessageAttachmentInput {
  chatId: string;
  file: {
    bytes: Uint8Array;
    contentType: SupportedContentType;
    filename: string;
  };
  idempotencyKey: string;
  text?: string;
}

export async function sendMessageWithAttachment(
  relay: RelayMessageAttachmentClient,
  input: MessageAttachmentInput,
): Promise<unknown> {
  if (
    input.idempotencyKey.length < 1
    || input.idempotencyKey.length > 255
  ) {
    throw new RangeError("idempotencyKey must be 1–255 characters");
  }
  if (input.text && input.text.length > 10_000) {
    throw new RangeError("text must be at most 10,000 UTF-16 code units");
  }

  const allocation = await relay.attachments.create({
    filename: input.file.filename,
    content_type: input.file.contentType,
    size_bytes: input.file.bytes.byteLength,
  });
  const uploadBytes = Uint8Array.from(input.file.bytes).buffer;
  await relay.attachments.upload(allocation, uploadBytes);

  const parts: MessagePart[] = [
    ...(input.text
      ? [{ type: "text" as const, value: input.text }]
      : []),
    { type: "media", attachment_id: allocation.attachment_id },
  ];
  return relay.chats.messages.send(input.chatId, {
    message: {
      parts,
      idempotency_key: input.idempotencyKey,
    },
  });
}
