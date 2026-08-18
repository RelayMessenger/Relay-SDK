import { createUIMessageStream, toUIMessageStream } from "ai";
import { simulateReadableStream } from "ai";
import { describe, expect, it, vi } from "vitest";
import { RelayClient } from "./client.js";

/**
 * Integration proof against the real AI SDK: what `toUIMessageStream()` and
 * `createUIMessageStream()` emit must reach Relay as well-formed SSE without
 * the deprecated `toUIMessageStreamResponse()` in the path.
 */
function clientWithMock() {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          message_id: "msg_out",
          message: { id: "msg_out" },
          stream: { protocol: "vercel-ai-ui-message-stream-v1" },
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      ),
  );
  const client = new RelayClient({
    token: "rly_live_test",
    baseUrl: "https://api.example.test",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, fetchMock };
}

async function drain(body: unknown): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as ReadableStream<Uint8Array> &
    AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return new TextDecoder().decode(
    new Uint8Array(chunks.flatMap((chunk) => Array.from(chunk))),
  );
}

describe("ai@7 UI message streams", () => {
  it("forwards createUIMessageStream() output as SSE", async () => {
    const { client, fetchMock } = clientWithMock();
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        writer.write({ type: "start" });
        writer.write({ type: "text-start", id: "0" });
        writer.write({ type: "text-delta", id: "0", delta: "hi" });
        writer.write({ type: "text-end", id: "0" });
        writer.write({ type: "finish" });
      },
    });
    await client.stream({
      conversationId: "cnv_1",
      idempotencyKey: "evt_1:0",
      stream,
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = await drain(init.body);
    expect(body.endsWith("data: [DONE]\n\n")).toBe(true);
    const frames = body
      .split("\n\n")
      .filter(Boolean)
      .map((line) => line.replace(/^data: /, ""));
    expect(frames.at(-1)).toBe("[DONE]");
    expect(frames.slice(0, -1).map((f) => JSON.parse(f))).toMatchObject([
      { type: "start" },
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: "hi" },
      { type: "text-end", id: "0" },
      { type: "finish" },
    ]);
  });

  it("forwards toUIMessageStream({ stream }) output as SSE", async () => {
    const { client, fetchMock } = clientWithMock();
    // A stream of model output parts, the shape `streamText().stream` yields.
    const modelStream = simulateReadableStream({
      chunks: [
        { type: "start" as const },
        { type: "start-step" as const },
        { type: "text-start" as const, id: "0" },
        { type: "text-delta" as const, id: "0", text: "hello" },
        { type: "text-end" as const, id: "0" },
        { type: "finish-step" as const },
        { type: "finish" as const },
      ],
    });
    await client.stream({
      conversationId: "cnv_1",
      idempotencyKey: "evt_1:0",
      // sendReasoning defaults to true on the standalone helper; Relay does
      // not need reasoning chunks in the committed message.
      stream: toUIMessageStream({
        stream: modelStream as never,
        sendReasoning: false,
      }),
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = await drain(init.body);
    expect(body.endsWith("data: [DONE]\n\n")).toBe(true);
    const frames = body
      .split("\n\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line.replace(/^data: /, "").replace("[DONE]", '"[DONE]"')));
    expect(frames).toContainEqual({ type: "text-delta", id: "0", delta: "hello" });
    expect(frames.at(-1)).toBe("[DONE]");
  });
});
