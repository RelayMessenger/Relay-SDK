import type {
  AttachmentCreateResponse,
  ChatSendVoicememoResponse,
} from "@relaymessenger/sdk";
import { describe, expect, it, vi } from "vitest";

import { sendVoiceMemo } from "../src/send.js";

const ALLOCATION = {
  attachment_id: "01993d50-ef7b-7b37-886b-23fd80c7ec10",
  upload_url: "https://upload.example.test/object",
  download_url: "https://media.example.test/object",
  http_method: "PUT",
  expires_at: "2026-09-01T12:05:00Z",
  required_headers: { "content-type": "audio/mp4" },
} satisfies AttachmentCreateResponse;

const RESPONSE = {
  voice_memo: {
    id: "01993d50-ef7b-7b37-886b-23fd80c7ec12",
    from: "orchid",
    to: ["advait"],
    status: "sent",
    voice_memo: {
      id: ALLOCATION.attachment_id,
      url: ALLOCATION.download_url,
      filename: "voice.m4a",
      mime_type: "audio/mp4",
      size_bytes: 4,
    },
    created_at: "2026-09-01T12:00:00Z",
    chat: {
      id: "01993d50-ef7b-7b37-886b-23fd80c7ec11",
      handles: [],
      is_group: false,
    },
  },
} satisfies ChatSendVoicememoResponse;

describe("send a voice memo", () => {
  it("allocates, uploads, then sends one voice memo", async () => {
    const timeline: string[] = [];
    const create = vi.fn(async () => {
      timeline.push("allocated");
      return ALLOCATION;
    });
    const upload = vi.fn(async (
      _allocation: AttachmentCreateResponse,
      _data: BodyInit,
    ) => {
      timeline.push("uploaded");
    });
    const sendVoicememo = vi.fn(async () => {
      timeline.push("sent");
      return RESPONSE;
    });
    const bytes = new Uint8Array([0, 0, 0, 1]);

    await sendVoiceMemo({
      attachments: { create, upload },
      chats: { sendVoicememo },
    }, {
      audio: {
        bytes,
        contentType: "audio/mp4",
        filename: "voice.m4a",
      },
      chatId: "01993d50-ef7b-7b37-886b-23fd80c7ec11",
    });

    expect(timeline).toEqual(["allocated", "uploaded", "sent"]);
    expect(create).toHaveBeenCalledWith({
      filename: "voice.m4a",
      content_type: "audio/mp4",
      size_bytes: 4,
    });
    expect(new Uint8Array(upload.mock.calls[0]![1] as ArrayBuffer))
      .toEqual(bytes);
    expect(sendVoicememo).toHaveBeenCalledWith(
      "01993d50-ef7b-7b37-886b-23fd80c7ec11",
      { attachment_id: ALLOCATION.attachment_id },
    );
  });
});
