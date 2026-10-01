import { describe, expect, it, vi } from "vitest";

import { answer, CHARACTER, type RelayClient } from "../src/agent.js";
import { Xai, type ChatMessage, type Media } from "../src/xai.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0]);
const REFERENCE: Media = { bytes: PNG, contentType: "image/png", filename: "reference" };

function relay(): RelayClient & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    attachments: {
      create: vi.fn(async () => ({
        attachment_id: "01993d50-ef7b-7b37-886b-23fd80c7ec10",
        upload_url: "https://upload.example.test/object",
        download_url: "https://media.example.test/object",
        http_method: "PUT" as const,
        expires_at: "2026-09-01T12:05:00Z",
        required_headers: {},
      })),
      upload: vi.fn(async () => undefined),
    },
    chats: {
      messages: {
        send: vi.fn(async (_chatId: string, body: unknown) => {
          sent.push(body);
          return { chat_id: "chat", message: { id: `message-${sent.length}` } } as never;
        }),
      },
    },
    contactCard: {
      retrieve: vi.fn(async () => ({ contact_cards: [] })),
      update: vi.fn(async () => ({ handle: "diego", image_url: null })),
    },
  };
}

/** An xAI fetch that answers each chat turn from `turns` and every image edit with one PNG. */
function xaiFetch(turns: ChatMessage[], bodies: Record<string, unknown>[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    bodies.push({ url, ...body });
    const result = url.endsWith("/chat/completions")
      ? { choices: [{ message: turns.shift() }] }
      : { data: [{ b64_json: Buffer.from(PNG).toString("base64") }] };
    return new Response(JSON.stringify(result), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("answer", () => {
  it("sends the picture Grok asks for, drawn from the reference, then Grok's words", async () => {
    const bodies: Record<string, unknown>[] = [];
    const xai = new Xai({
      apiKey: "test",
      fetch: xaiFetch([
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "send_picture", arguments: JSON.stringify({ scene: "A selfie on the Diag" }) },
          }],
        },
        { role: "assistant", content: "There you go!" },
      ], bodies),
    });
    const client = relay();
    const history: ChatMessage[] = [{ role: "user", content: "send me a selfie" }];

    const ids = await answer(client, xai, REFERENCE, "chat", history, "event-1");

    expect(ids).toEqual(["message-1", "message-2"]);
    expect(client.sent).toEqual([
      { message: { parts: [{ type: "media", attachment_id: "01993d50-ef7b-7b37-886b-23fd80c7ec10" }], idempotency_key: "event-1:0" } },
      { message: { parts: [{ type: "text", value: "There you go!" }], idempotency_key: "event-1:1" } },
    ]);
    const edit = bodies.find((body) => String(body.url).endsWith("/images/edits"));
    expect(edit?.prompt).toContain(CHARACTER);
    expect(edit?.prompt).toContain("A selfie on the Diag");
    expect(edit?.image).toEqual({ url: `data:image/png;base64,${Buffer.from(PNG).toString("base64")}` });
    expect(history.at(-1)).toEqual({ role: "assistant", content: "There you go!" });
  });

  it("sends only text when Grok calls no tool", async () => {
    const xai = new Xai({ apiKey: "test", fetch: xaiFetch([{ role: "assistant", content: "Acorns!" }], []) });
    const client = relay();

    await answer(client, xai, REFERENCE, "chat", [{ role: "user", content: "hi" }], "event-2");

    expect(client.sent).toEqual([
      { message: { parts: [{ type: "text", value: "Acorns!" }], idempotency_key: "event-2:0" } },
    ]);
    expect(client.attachments.create).not.toHaveBeenCalled();
  });
});
