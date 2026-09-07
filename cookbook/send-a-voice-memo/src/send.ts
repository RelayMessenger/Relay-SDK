import type {
  AttachmentCreateParams,
  AttachmentCreateResponse,
  ChatSendVoicememoParams,
  ChatSendVoicememoResponse,
  SupportedContentType,
} from "@relaymessenger/sdk";

export type AudioContentType =
  Extract<SupportedContentType, `audio/${string}`>;

export interface RelayVoiceMemoClient {
  attachments: {
    create(body: AttachmentCreateParams): Promise<AttachmentCreateResponse>;
    upload(
      allocation: AttachmentCreateResponse,
      data: BodyInit,
    ): Promise<void>;
  };
  chats: {
    sendVoicememo(
      chatId: string,
      body: ChatSendVoicememoParams,
    ): Promise<ChatSendVoicememoResponse>;
  };
}

export interface VoiceMemoInput {
  audio: {
    bytes: Uint8Array;
    contentType: AudioContentType;
    filename: string;
  };
  chatId: string;
}

export async function sendVoiceMemo(
  relay: RelayVoiceMemoClient,
  input: VoiceMemoInput,
): Promise<ChatSendVoicememoResponse> {
  const allocation = await relay.attachments.create({
    filename: input.audio.filename,
    content_type: input.audio.contentType,
    size_bytes: input.audio.bytes.byteLength,
  });
  await relay.attachments.upload(
    allocation,
    Uint8Array.from(input.audio.bytes).buffer,
  );

  return relay.chats.sendVoicememo(input.chatId, {
    attachment_id: allocation.attachment_id,
  });
}
