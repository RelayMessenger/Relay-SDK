import type { AttachmentCreateResponse } from "@relaymessenger/sdk";
import { describe, expect, it, vi } from "vitest";

import { sendImage } from "../src/send.js";

const ALLOCATION = {
  attachment_id: "01993d50-ef7b-7b37-886b-23fd80c7ec10",
  upload_url: "https://upload.example.test/object",
  download_url: "https://media.example.test/object",
  http_method: "PUT",
  expires_at: "2026-09-01T12:05:00Z",
  required_headers: { "content-type": "image/png" },
} satisfies AttachmentCreateResponse;

describe("send an image", () => {
  it("allocates, uploads, then sends one image Message", async () => {
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
    const send = vi.fn(async () => {
      timeline.push("sent");
      return { message: { id: "sent-id" } };
    });
    const bytes = new Uint8Array([137, 80, 78, 71]);

    await sendImage({
      attachments: { create, upload },
      chats: { messages: { send } },
    }, {
      chatId: "01993d50-ef7b-7b37-886b-23fd80c7ec11",
      image: {
        bytes,
        contentType: "image/png",
        filename: "photo.png",
      },
      idempotencyKey: "relay-example:image:42",
    });

    expect(timeline).toEqual(["allocated", "uploaded", "sent"]);
    expect(create).toHaveBeenCalledWith({
      filename: "photo.png",
      content_type: "image/png",
      size_bytes: 4,
    });
    expect(new Uint8Array(upload.mock.calls[0]![1] as ArrayBuffer))
      .toEqual(bytes);
    expect(send).toHaveBeenCalledWith(
      "01993d50-ef7b-7b37-886b-23fd80c7ec11",
      {
        message: {
          parts: [
            {
              type: "media",
              attachment_id: ALLOCATION.attachment_id,
            },
          ],
          idempotency_key: "relay-example:image:42",
        },
      },
    );
  });
});
