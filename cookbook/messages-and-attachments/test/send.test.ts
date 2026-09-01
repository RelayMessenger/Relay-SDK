import type { AttachmentCreateResponse } from "@relaymessenger/sdk";
import { describe, expect, it, vi } from "vitest";

import { sendMessageWithAttachment } from "../src/send.js";
import { relayApiOrigin } from "../src/config.js";

const ALLOCATION = {
  attachment_id: "01993d50-ef7b-7b37-886b-23fd80c7ec10",
  upload_url: "https://upload.example.test/object",
  download_url: "https://media.example.test/object",
  http_method: "PUT",
  expires_at: "2026-09-01T12:05:00Z",
  required_headers: { "content-type": "text/plain" },
} satisfies AttachmentCreateResponse;

describe("direct Message + Attachment flow", () => {
  it("accepts HTTPS or loopback only for Agent Tokens", () => {
    expect(relayApiOrigin("https://api.staging.relayapp.im"))
      .toBe("https://api.staging.relayapp.im");
    expect(relayApiOrigin("http://127.0.0.1:8787"))
      .toBe("http://127.0.0.1:8787");
    expect(() => relayApiOrigin("http://example.com")).toThrow(/HTTPS/);
    expect(() => relayApiOrigin("https://user@example.com/path"))
      .toThrow(/without credentials or a path/);
  });

  it("allocates, uploads, then sends one multipart idempotent Message", async () => {
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

    await sendMessageWithAttachment({
      attachments: { create, upload },
      chats: { messages: { send } },
    }, {
      chatId: "01993d50-ef7b-7b37-886b-23fd80c7ec11",
      file: {
        bytes: new TextEncoder().encode("file bytes"),
        contentType: "text/plain",
        filename: "notes.txt",
      },
      idempotencyKey: "relay-example:attachment:document-42",
      text: "Document 42",
    });

    expect(timeline).toEqual(["allocated", "uploaded", "sent"]);
    expect(create).toHaveBeenCalledWith({
      filename: "notes.txt",
      content_type: "text/plain",
      size_bytes: 10,
    });
    expect(new Uint8Array(upload.mock.calls[0]![1] as ArrayBuffer))
      .toEqual(new TextEncoder().encode("file bytes"));
    expect(send).toHaveBeenCalledWith(
      "01993d50-ef7b-7b37-886b-23fd80c7ec11",
      {
        message: {
          parts: [
            { type: "text", value: "Document 42" },
            {
              type: "media",
              attachment_id: ALLOCATION.attachment_id,
            },
          ],
          idempotency_key: "relay-example:attachment:document-42",
        },
      },
    );
  });
});
