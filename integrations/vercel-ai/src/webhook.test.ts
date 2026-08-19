import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createRelay } from "./index.js";
import type { MessageReceivedEvent } from "./types.js";

const SECRET_BYTES = Buffer.from("another-test-secret");
const SECRET = `whsec_${SECRET_BYTES.toString("base64")}`;

function envelope(overrides: Partial<MessageReceivedEvent> = {}): MessageReceivedEvent {
  return {
    event_id: "evt_01TEST",
    event_type: "message.received",
    agent_id: "agt_01TEST",
    created_at: "2026-07-26T00:00:00.000Z",
    data: {
      message: {
        id: "msg_01TEST",
        conversation_id: "cnv_01TEST",
        sequence: 4,
        sender: { kind: "user", id: "usr_01TEST" },
        parts: [{ type: "text", text: "hello", part_index: 0 }],
        created_at: "2026-07-26T00:00:00.000Z",
      },
    },
    ...overrides,
  };
}

function signedRequest(body: string, id = "whmsg_1"): Request {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const mac = createHmac("sha256", SECRET_BYTES)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return new Request("https://agent.example.com/relay/webhook", {
    method: "POST",
    body,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${mac}`,
    },
  });
}

function relayWithMockFetch() {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    void url;
    void init;
    return new Response(
      JSON.stringify({ message_id: "msg_out", message: { id: "msg_out" } }),
      { status: 202, headers: { "Content-Type": "application/json" } },
    );
  });
  const relay = createRelay({
    token: "rly_live_test",
    webhookSecret: SECRET,
    baseUrl: "https://api.example.test",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { relay, fetchMock };
}

describe("createWebhookHandler", () => {
  it("rejects an unsigned request with 401", async () => {
    const { relay } = relayWithMockFetch();
    const handler = relay.webhook(async () => {});
    const response = await handler(
      new Request("https://agent.example.com/relay/webhook", {
        method: "POST",
        body: JSON.stringify(envelope()),
      }),
    );
    expect(response.status).toBe(401);
  });

  it("dispatches message.received with reply helpers bound to the event", async () => {
    const { relay, fetchMock } = relayWithMockFetch();
    const handler = relay.webhook(async ({ message, reply }) => {
      expect(message.parts[0]).toMatchObject({ type: "text", text: "hello" });
      await reply.text("hi back");
    });
    const response = await handler(signedRequest(JSON.stringify(envelope())));
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.test/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("evt_01TEST:0");
    expect(JSON.parse(init.body as string)).toMatchObject({
      conversation_id: "cnv_01TEST",
      parts: [{ type: "text", text: "hi back" }],
    });
  });

  it("derives sequential idempotency keys per reply within one event", async () => {
    const { relay, fetchMock } = relayWithMockFetch();
    const handler = relay.webhook(async ({ reply }) => {
      await reply.text("one");
      await reply.text("two");
    });
    await handler(signedRequest(JSON.stringify(envelope())));
    const keys = fetchMock.mock.calls.map(
      ([, init]) => (init!.headers as Record<string, string>)["Idempotency-Key"],
    );
    expect(keys[0]).toBe("evt_01TEST:0");
    expect(keys[1]).toBe("evt_01TEST:1");
  });

  it("keys a reply by event and position, whatever the model wrote", async () => {
    // Relay hashes the request beside the key and answers 409 when one key
    // returns with a different body, otherwise it replays the first response.
    // So the key must NOT vary with the content: a redelivery whose model
    // wrote something else has to collide, or it posts a second message to the
    // person instead of being refused.
    const texts = ["first answer", "first answer", "second answer"];
    const keys: string[] = [];
    for (const text of texts) {
      const { relay, fetchMock } = relayWithMockFetch();
      const handler = relay.webhook(async ({ reply }) => {
        await reply.text(text);
      });
      await handler(signedRequest(JSON.stringify(envelope())));
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      keys.push((init.headers as Record<string, string>)["Idempotency-Key"]);
    }
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).toBe(keys[0]);
  });

  it("threads invocation_id from group deliveries into replies", async () => {
    const { relay, fetchMock } = relayWithMockFetch();
    const handler = relay.webhook(async ({ invocationId, reply }) => {
      expect(invocationId).toBe("inv_01TEST");
      await reply.text("group reply");
    });
    const body = JSON.stringify(
      envelope({
        data: { ...envelope().data, invocation_id: "inv_01TEST" },
      }),
    );
    await handler(signedRequest(body));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      invocation_id: "inv_01TEST",
    });
  });

  it("deduplicates a redelivered event_id", async () => {
    const { relay } = relayWithMockFetch();
    const seen = vi.fn();
    const handler = relay.webhook(async () => {
      seen();
    });
    const body = JSON.stringify(envelope());
    await handler(signedRequest(body, "whmsg_a"));
    const second = await handler(signedRequest(body, "whmsg_b"));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ deduplicated: true });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("acknowledges unknown event types without dispatching", async () => {
    const { relay } = relayWithMockFetch();
    const seen = vi.fn();
    const handler = relay.webhook(async () => {
      seen();
    });
    const body = JSON.stringify({
      ...envelope(),
      event_id: "evt_unknown",
      event_type: "message.future_type",
    });
    const response = await handler(signedRequest(body));
    expect(response.status).toBe(200);
    expect(seen).not.toHaveBeenCalled();
  });

  it("returns 500 when the handler throws so Relay redelivers", async () => {
    const { relay } = relayWithMockFetch();
    const onError = vi.fn();
    const handler = relay.webhook(
      async () => {
        throw new Error("boom");
      },
      { onError },
    );
    const response = await handler(signedRequest(JSON.stringify(envelope())));
    expect(response.status).toBe(500);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("rejects non-POST methods with 405", async () => {
    const { relay } = relayWithMockFetch();
    const handler = relay.webhook(async () => {});
    const response = await handler(
      new Request("https://agent.example.com/relay/webhook", { method: "GET" }),
    );
    expect(response.status).toBe(405);
  });

  it("rejects empty-string signature headers with 401", async () => {
    const { relay } = relayWithMockFetch();
    const handler = relay.webhook(async () => {});
    const response = await handler(
      new Request("https://agent.example.com/relay/webhook", {
        method: "POST",
        body: JSON.stringify(envelope()),
        headers: { "webhook-id": "", "webhook-timestamp": "", "webhook-signature": "" },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("dispatches a redelivery again after a failed handler instead of swallowing it", async () => {
    const { relay } = relayWithMockFetch();
    let attempts = 0;
    const handler = relay.webhook(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient");
    }, { onError: () => {} });
    const body = JSON.stringify(envelope());
    const first = await handler(signedRequest(body, "whmsg_1"));
    expect(first.status).toBe(500);
    const second = await handler(signedRequest(body, "whmsg_2"));
    expect(second.status).toBe(200);
    expect(attempts).toBe(2);
    const third = await handler(signedRequest(body, "whmsg_3"));
    expect(await third.json()).toEqual({ deduplicated: true });
    expect(attempts).toBe(2);
  });

  it("fails with 500 when waitUntil is provided so Relay still redelivers", async () => {
    const { relay } = relayWithMockFetch();
    const onError = vi.fn();
    let attempts = 0;
    const handler = relay.webhook(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("background boom");
    }, { onError });
    const waited: Promise<unknown>[] = [];
    const body = JSON.stringify(envelope());
    const first = await handler(signedRequest(body, "whmsg_1"), {
      waitUntil: (p) => waited.push(p),
    });
    expect(first.status).toBe(500);
    expect(onError).toHaveBeenCalledTimes(1);
    const second = await handler(signedRequest(body, "whmsg_2"));
    expect(second.status).toBe(200);
    expect(attempts).toBe(2);
  });

  it("acknowledges only after the handler finishes, even with waitUntil", async () => {
    const { relay } = relayWithMockFetch();
    let finished = false;
    const handler = relay.webhook(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      finished = true;
    });
    const waited: Promise<unknown>[] = [];
    const response = await handler(signedRequest(JSON.stringify(envelope())), {
      waitUntil: (p) => waited.push(p),
    });
    expect(response.status).toBe(200);
    expect(finished).toBe(true);
    expect(waited).toHaveLength(0);
  });
});
