import type {
  AttachmentCreateParams,
  AttachmentCreateResponse,
  MessageSendParams,
  SupportedContentType,
} from "@relaymessenger/sdk";

export type ImageContentType =
  Extract<SupportedContentType, `image/${string}`>;

export interface RelayImageClient {
  attachments: {
    create(body: AttachmentCreateParams): Promise<AttachmentCreateResponse>;
    upload(
      allocation: AttachmentCreateResponse,
      data: BodyInit,
    ): Promise<void>;
  };
  chats: {
    messages: {
      send(chatId: string, body: MessageSendParams): Promise<unknown>;
    };
  };
}

export interface ImageInput {
  chatId: string;
  image: {
    bytes: Uint8Array;
    contentType: ImageContentType;
    filename: string;
  };
  idempotencyKey: string;
}

export async function sendImage(
  relay: RelayImageClient,
  input: ImageInput,
): Promise<unknown> {
  if (
    input.idempotencyKey.length < 1
    || input.idempotencyKey.length > 255
  ) {
    throw new RangeError("idempotencyKey must be 1–255 characters");
  }

  const allocation = await relay.attachments.create({
    filename: input.image.filename,
    content_type: input.image.contentType,
    size_bytes: input.image.bytes.byteLength,
  });
  await relay.attachments.upload(
    allocation,
    Uint8Array.from(input.image.bytes).buffer,
  );

  return relay.chats.messages.send(input.chatId, {
    message: {
      parts: [
        { type: "media", attachment_id: allocation.attachment_id },
      ],
      idempotency_key: input.idempotencyKey,
    },
  });
}
