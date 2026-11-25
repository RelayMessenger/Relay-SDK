import { createRelayAdapter } from "@relaymessenger/chat-sdk-adapter";
import { describe, expect, it, vi } from "vitest";

import { inlineInboundMedia } from "../src/attachments.js";

const CHAT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec10";
const ATTACHMENT_ID = "01993d50-ef7b-7b37-886b-23fd80c7ec13";
const DOWNLOAD_URL = "https://cdn.example.test/oversize.png";

describe("inlineInboundMedia bounds and timeouts", () => {
  it("enforces the byte limit on attachment.fetch even when size_bytes is misreported", async () => {
    const oversized = new Uint8Array(30 * 1024 * 1024 + 1);
    const receivedOptions: unknown[] = [];
    const media = await inlineInboundMedia([{
      id: "att-1",
      name: "huge.png",
      mediaType: "image/png",
      size: 128, // misreported tiny size
      fetch: (async (options?: unknown) => {
        receivedOptions.push(options);
        return oversized.buffer;
      }) as () => Promise<ArrayBuffer>,
    }]);
    expect(receivedOptions[0]).toMatchObject({
      maxBytes: 30 * 1024 * 1024,
      signal: expect.any(AbortSignal),
      timeoutMs: 20_000,
    });
    expect(media.parts).toEqual([]);
    expect(media.unreadable).toEqual(["- huge.png (128 bytes): too large to view"]);
  });

  it("cancels an oversized streaming download through RelayAdapter raw.fetchData before buffering", async () => {
    let chunksPulled = 0;
    let canceled = false;
    const chunk = new Uint8Array(4 * 1024 * 1024); // 4 MiB chunks -> exceeds 30 MiB on chunk 8
    const fetchMock = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksPulled += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    })));
    const adapter = createRelayAdapter({
      token: "test",
      webhookSecret: "whsec_dGVzdA==",
      fetch: fetchMock as typeof fetch,
      maxRetries: 0,
    });
    const parsed = adapter.parseMessage({
      chatId: CHAT_ID,
      eventType: "message.received",
      message: {
        id: "01993d50-ef7b-7b37-886b-23fd80c7ec11",
        chat: { id: CHAT_ID, is_group: false },
        direction: "inbound",
        sender_handle: {
          id: "01993d50-ef7b-7b37-886b-23fd80c7ec12",
          handle: "advait",
          joined_at: "2026-08-29T00:00:00Z",
          kind: "user",
        },
        parts: [{
          type: "media",
          id: ATTACHMENT_ID,
          url: DOWNLOAD_URL,
          filename: "huge.png",
          mime_type: "image/png",
          size_bytes: 512,
          reactions: null,
        }],
      },
    } as never);
    const chatAttachment = parsed.attachments[0]!;
    // Simulate @cloudflare/think's toMessengerAttachment wrapper, which wraps fetchData in a 0-arg closure
    // and keeps the original Chat SDK Attachment on `raw`.
    const media = await inlineInboundMedia([{
      id: ATTACHMENT_ID,
      name: chatAttachment.name,
      mediaType: chatAttachment.mimeType,
      size: chatAttachment.size,
      url: chatAttachment.url,
      fetch: async () => await chatAttachment.fetchData!() as ArrayBuffer,
      raw: chatAttachment,
    } as never]);

    expect(canceled).toBe(true);
    expect(chunksPulled).toBeLessThanOrEqual(9);
    expect(media.parts).toEqual([]);
    expect(media.unreadable).toEqual(["- huge.png (512 bytes): too large to view"]);
  });

  it("enforces AbortSignal on attachment.fetch even when the fetcher ignores arguments", async () => {
    const controller = new AbortController();
    const pending = inlineInboundMedia([{
      id: "att-hang",
      name: "hang.png",
      mediaType: "image/png",
      size: 100,
      fetch: () => new Promise<ArrayBuffer>(() => {
        // Never resolves and ignores signal.
      }),
    }], controller.signal);
    controller.abort(new Error("turn canceled"));
    const media = await pending;
    expect(media.parts).toEqual([]);
    expect(media.unreadable).toEqual([]);
  });

  it("enforces the byte limit on inline attachment.data", async () => {
    const oversized = new Uint8Array(30 * 1024 * 1024 + 1);
    const media = await inlineInboundMedia([{
      id: "att-data",
      name: "inline.png",
      mediaType: "image/png",
      data: oversized.buffer,
    }]);
    expect(media.parts).toEqual([]);
    expect(media.unreadable).toEqual(["- inline.png: too large to view"]);
  });
});
