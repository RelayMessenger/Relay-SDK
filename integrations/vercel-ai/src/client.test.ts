import { describe, expect, it, vi } from "vitest";
import { RelayApiError, RelayClient } from "./client.js";

function clientWithMock(status = 202, body: unknown = { message_id: "msg_out", message: { id: "msg_out" } }) {
  const fetchMock = vi.fn(async () =>
    status === 204
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
  );
  const client = new RelayClient({
    token: "rly_live_test",
    baseUrl: "https://api.example.test/",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, fetchMock };
}

function objectStream(chunks: unknown[]): ReadableStream<unknown> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function drain(body: unknown): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return new TextDecoder().decode(
    new Uint8Array(chunks.flatMap((chunk) => Array.from(chunk))),
  );
}

function sse(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("RelayClient.stream", () => {
  it("sends the exact one-shot stream contract", async () => {
    const { client, fetchMock } = clientWithMock(202, {
      message_id: "msg_out",
      message: { id: "msg_out" },
      stream: { protocol: "vercel-ai-ui-message-stream-v1" },
    });
    await client.stream({
      conversationId: "cnv_1",
      invocationId: "inv_1",
      idempotencyKey: "evt_1:0",
      stream: sse(['data: {"type":"text-delta","delta":"hi"}\n\n', "data: [DONE]\n\n"]),
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { duplex?: string }];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe("/v1/messages");
    expect(parsed.searchParams.get("stream")).toBe("true");
    expect(parsed.searchParams.get("conversation_id")).toBe("cnv_1");
    expect(parsed.searchParams.get("invocation_id")).toBe("inv_1");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-vercel-ai-ui-message-stream"]).toBe("v1");
    expect(headers["Content-Type"]).toBe("text/event-stream");
    expect(headers["Idempotency-Key"]).toBe("evt_1:0");
    expect(init.duplex).toBe("half");
    expect(init.body).toBeInstanceOf(ReadableStream);
  });

  it("SSE-encodes a stream of UI message chunk objects", async () => {
    const { client, fetchMock } = clientWithMock();
    await client.stream({
      conversationId: "cnv_1",
      idempotencyKey: "evt_1:0",
      stream: objectStream([
        { type: "start" },
        { type: "text-start", id: "0" },
        { type: "text-delta", id: "0", delta: "hi" },
        { type: "text-end", id: "0" },
        { type: "finish" },
      ]),
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-vercel-ai-ui-message-stream"]).toBe("v1");
    // Byte-for-byte what ai@7 createUIMessageStreamResponse writes.
    expect(await drain(init.body)).toBe(
      'data: {"type":"start"}\n\n' +
        'data: {"type":"text-start","id":"0"}\n\n' +
        'data: {"type":"text-delta","id":"0","delta":"hi"}\n\n' +
        'data: {"type":"text-end","id":"0"}\n\n' +
        'data: {"type":"finish"}\n\n' +
        "data: [DONE]\n\n",
    );
  });

  it("terminates an empty object stream so the server never waits on a bare body", async () => {
    const { client, fetchMock } = clientWithMock();
    await client.stream({
      conversationId: "cnv_1",
      idempotencyKey: "evt_1:0",
      stream: objectStream([]),
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(await drain(init.body)).toBe("data: [DONE]\n\n");
  });

  it("never emits invalid JSON for chunks that stringify to undefined", async () => {
    const { client, fetchMock } = clientWithMock();
    await client.stream({
      conversationId: "cnv_1",
      idempotencyKey: "evt_1:0",
      stream: objectStream([undefined]),
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(await drain(init.body)).toBe("data: null\n\n" + "data: [DONE]\n\n");
  });

  it("forwards an already-encoded SSE byte stream untouched", async () => {
    const { client, fetchMock } = clientWithMock();
    const encoded =
      'data: {"type":"text-delta","id":"0","delta":"hi"}\n\n' + "data: [DONE]\n\n";
    await client.stream({
      conversationId: "cnv_1",
      idempotencyKey: "evt_1:0",
      stream: sse([encoded]),
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(await drain(init.body)).toBe(encoded);
  });

  it("unwraps a toUIMessageStreamResponse() source", async () => {
    const { client, fetchMock } = clientWithMock();
    const source = {
      toUIMessageStreamResponse: () =>
        new Response(sse(["data: [DONE]\n\n"]), {
          headers: { "Content-Type": "text/event-stream" },
        }),
    };
    await client.stream({
      conversationId: "cnv_1",
      idempotencyKey: "evt_1:0",
      stream: source,
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.body).toBeInstanceOf(ReadableStream);
  });

  it("raises RelayApiError with the server's error code", async () => {
    const { client } = clientWithMock(403, {
      error: { code: "forbidden", message: "group agent streams require invocation_id" },
    });
    await expect(
      client.stream({
        conversationId: "cnv_1",
        idempotencyKey: "evt_1:0",
        stream: sse(["data: [DONE]\n\n"]),
      }),
    ).rejects.toMatchObject({
      name: "RelayApiError",
      status: 403,
      code: "forbidden",
    });
  });
});

describe("RelayClient.typing", () => {
  it("posts the ephemeral typing contract", async () => {
    const { client, fetchMock } = clientWithMock(204, {});
    await client.typing({ conversationId: "cnv_1", label: "Searching…", invocationId: "inv_1" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.test/v1/conversations/cnv_1/typing");
    expect(JSON.parse(init.body as string)).toEqual({
      started: true,
      label: "Searching…",
      invocation_id: "inv_1",
    });
  });
});

describe("RelayClient.send", () => {
  it("requires a token", () => {
    expect(() => new RelayClient({ token: "" })).toThrow();
  });

  it("maps replyTo into the wire shape", async () => {
    const { client, fetchMock } = clientWithMock();
    await client.sendText({
      conversationId: "cnv_1",
      text: "hello",
      idempotencyKey: "evt_1:0",
      replyTo: { messageId: "msg_9", partIndex: 1 },
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      reply_to: { message_id: "msg_9", part_index: 1 },
    });
    expect(RelayApiError.name).toBe("RelayApiError");
  });
});
