import { describe, expect, it, vi } from "vitest";
import { RelayClient } from "./client.js";

function clientWithMock(
  status = 202,
  body: unknown = { message_id: "msg_out", message: { id: "msg_out" } },
) {
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

function sentBody(fetchMock: { mock: { calls: unknown[][] } }, index = 0): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[index] as unknown as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

describe("RelayClient.typing", () => {
  it("posts the ephemeral typing contract", async () => {
    const { client, fetchMock } = clientWithMock(204, {});
    await client.typing({ conversationId: "cnv_1" });
    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.test/v1/conversations/cnv_1/typing");
    // Fire and forget: a bare started flag, no label, no lease, no invocation.
    expect(sentBody(fetchMock)).toEqual({ started: true });
  });

  it("takes the indicator back down", async () => {
    const { client, fetchMock } = clientWithMock(204, {});
    await client.typing({ conversationId: "cnv_1", started: false });
    expect(sentBody(fetchMock)).toEqual({ started: false });
  });
});

describe("RelayClient.send", () => {
  it("requires a token", () => {
    expect(() => new RelayClient({ token: "" })).toThrow();
  });

  it("mints a msg_ ULID per send and carries no idempotency header", async () => {
    // The minted id IS the idempotency mechanism now: the same id is a replay
    // and another sender's id is a 409, so there is no header to send.
    const { client, fetchMock } = clientWithMock();
    await client.sendText({ conversationId: "cnv_1", text: "hello" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.test/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeUndefined();
    expect(sentBody(fetchMock).message_id).toMatch(/^msg_[0-9a-hjkmnp-tv-z]{26}$/);
  });

  it("reuses a caller-supplied message id, so a retry replays instead of posting twice", async () => {
    const { client, fetchMock } = clientWithMock();
    const messageId = "msg_01k1m9x2ph4vb7k0d3wzr8ftqe";
    await client.sendText({ conversationId: "cnv_1", messageId, text: "hello" });
    await client.sendText({ conversationId: "cnv_1", messageId, text: "hello" });
    expect(sentBody(fetchMock, 0).message_id).toBe(messageId);
    expect(sentBody(fetchMock, 1).message_id).toBe(messageId);
  });

  it("sorts two ids minted in the same millisecond in the order they were made", async () => {
    // Relay orders by id where timestamps tie, so back-to-back replies must
    // not shuffle.
    const { client, fetchMock } = clientWithMock();
    await client.sendText({ conversationId: "cnv_1", text: "one" });
    await client.sendText({ conversationId: "cnv_1", text: "two" });
    const first = sentBody(fetchMock, 0).message_id as string;
    const second = sentBody(fetchMock, 1).message_id as string;
    expect(first < second).toBe(true);
  });

  it("maps replyTo into the pointer wire shape", async () => {
    const { client, fetchMock } = clientWithMock();
    await client.sendText({
      conversationId: "cnv_1",
      text: "hello",
      replyTo: { messageId: "msg_9" },
    });
    // A reply is a pointer: a message id, and optionally one part id.
    expect(sentBody(fetchMock)).toMatchObject({
      reply_to: { message_id: "msg_9" },
    });
  });

  it("returns the one committed message", async () => {
    const { client } = clientWithMock();
    const result = await client.sendText({ conversationId: "cnv_1", text: "hello" });
    expect(result).toMatchObject({ message_id: "msg_out", message: { id: "msg_out" } });
  });

  it("raises RelayApiError with the server's error code", async () => {
    const { client } = clientWithMock(409, {
      error: { code: "message_id_conflict", message: "that id belongs to someone else" },
    });
    await expect(
      client.sendText({ conversationId: "cnv_1", text: "hello" }),
    ).rejects.toMatchObject({
      name: "RelayApiError",
      status: 409,
      code: "message_id_conflict",
    });
  });
});
