import { describe, expect, it } from "vitest";
import { createRelayClient, RelayApiError } from "./client.js";
import { RELAY_TEXT_CHUNK_LIMIT, sendRelayText } from "./outbound.js";
import type { RelaySentMessage } from "./client.js";

type RecordedRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
};

function fakeFetch(
  responder: (request: RecordedRequest) => { status: number; body?: unknown },
) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const request: RecordedRequest = {
      url: input,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    requests.push(request);
    const { status, body } = responder(request);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, requests };
}

function committed(request: RecordedRequest): { message: RelaySentMessage } {
  return {
    message: {
      id: request.body.message_id,
      conversation_id: "cnv_1",
      sequence: 8,
      kind: "message",
      sender: { kind: "agent", id: "agt_self" },
      is_from_me: true,
      parts: [
        { part_id: "prt_1", part_index: 0, type: "text", text: request.body.parts[0].text },
      ],
      reply_to: null,
      fallback_text: request.body.parts[0].text,
      status: "sent",
      created_at: "2026-07-17T00:00:02.000Z",
    },
  };
}

describe("sendRelayText", () => {
  it("POSTs one text part with a minted message id and the reply target", async () => {
    const { fetchImpl, requests } = fakeFetch((request) => ({
      status: 201,
      body: committed(request),
    }));
    const client = createRelayClient({ baseUrl: "https://api.test", token: "tok", fetchImpl });

    const result = await sendRelayText({
      client,
      conversationId: "cnv_1",
      text: "hi",
      replyToId: "msg_prev",
    });

    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.url).toBe("https://api.test/v2/conversations/cnv_1/messages");
    expect(request.method).toBe("POST");
    expect(request.headers.authorization).toBe("Bearer tok");
    // The id is the retry key; there is no Idempotency-Key header any more.
    expect(request.headers["idempotency-key"]).toBeUndefined();
    expect(request.body).toEqual({
      message_id: result.messageId,
      parts: [{ type: "text", text: "hi" }],
      reply_to: { message_id: "msg_prev" },
    });
    expect(result.messageId).toMatch(/^msg_[0-9a-hjkmnp-tv-z]{26}$/);
    expect(result.message.id).toBe(result.messageId);
  });

  it("gives two intentional identical sends two ids", async () => {
    const { fetchImpl, requests } = fakeFetch((request) => ({
      status: 201,
      body: committed(request),
    }));
    const client = createRelayClient({ baseUrl: "https://api.test", token: "tok", fetchImpl });

    await sendRelayText({ client, conversationId: "cnv_1", text: "hi" });
    await sendRelayText({ client, conversationId: "cnv_1", text: "hi" });

    expect(requests[0]!.body.message_id).not.toBe(requests[1]!.body.message_id);
  });

  // Minting per attempt instead of per send is exactly how a retry after a
  // dropped response turns one reply into two.
  it("replays one id across its own retries so the server can dedupe", async () => {
    let attempt = 0;
    const { fetchImpl, requests } = fakeFetch((request) => {
      attempt += 1;
      return attempt === 1
        ? { status: 503, body: { error: { message: "unavailable" } } }
        : { status: 201, body: committed(request) };
    });
    const client = createRelayClient({ baseUrl: "https://api.test", token: "tok", fetchImpl });

    const result = await sendRelayText({ client, conversationId: "cnv_1", text: "hi" });

    expect(requests).toHaveLength(2);
    expect(requests[0]!.body.message_id).toBe(requests[1]!.body.message_id);
    expect(result.messageId).toBe(requests[0]!.body.message_id);
  });

  it("honours a caller-supplied id so a caller can retry across processes", async () => {
    const { fetchImpl, requests } = fakeFetch((request) => ({
      status: 201,
      body: committed(request),
    }));
    const client = createRelayClient({ baseUrl: "https://api.test", token: "tok", fetchImpl });

    const result = await sendRelayText({
      client,
      conversationId: "cnv_1",
      text: "hi",
      messageId: "msg_01k1m9x2ph4vb7k0d3wzr8ftqe",
    });

    expect(result.messageId).toBe("msg_01k1m9x2ph4vb7k0d3wzr8ftqe");
    expect(requests[0]!.body.message_id).toBe("msg_01k1m9x2ph4vb7k0d3wzr8ftqe");
  });

  it("gives up on a terminal rejection instead of retrying it", async () => {
    const { fetchImpl, requests } = fakeFetch(() => ({
      status: 422,
      body: { error: { message: "text part too long" } },
    }));
    const client = createRelayClient({ baseUrl: "https://api.test", token: "tok", fetchImpl });

    await expect(sendRelayText({ client, conversationId: "cnv_1", text: "hi" })).rejects
      .toBeInstanceOf(RelayApiError);
    expect(requests).toHaveLength(1);
  });
});

describe("text chunk ceiling", () => {
  it("keeps any chunk under the server's 8 KiB per-part byte cap", () => {
    // 4 bytes/char is the UTF-8 worst case; the declared char limit must keep
    // even all-astral content within MAX_TEXT_BYTES = 8192.
    expect(RELAY_TEXT_CHUNK_LIMIT * 4).toBeLessThanOrEqual(8 * 1024);
  });
});
