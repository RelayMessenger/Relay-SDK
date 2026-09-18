import { describe, expect, it } from "vitest";
import { Webhook } from "standardwebhooks";
import Relay, { type Call, type CallResponse, type CallWebhookEvent } from "../src/index.js";

const call: Call = {
  id: "01995bc0-0000-7000-8000-000000000001",
  chat_id: "01995bc0-0000-7000-8000-000000000002",
  from: { id: "01995bc0-0000-7000-8000-000000000003", handle: "alice", kind: "user" },
  to: [{ id: "01995bc0-0000-7000-8000-000000000004", handle: "echo", kind: "agent" }],
  mode: "audio",
  status: "ringing",
  revision: 1,
  created_at: "2026-09-17T12:00:00Z",
  ringing_at: "2026-09-17T12:00:00Z",
  answered_at: null,
  connected_at: null,
  ended_at: null,
  end_reason: null,
};

describe("provider-independent call API", () => {
  it("creates calls with one stable header key across retries", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = new Relay({
      apiKey: "agent-test-token", baseURL: "https://api.staging.relayapp.im",
      retryBaseDelayMs: 0,
      fetch: async (url, init) => {
        requests.push({ url: String(url), init: init! });
        return requests.length === 1
          ? Response.json({ error: { message: "retry" } }, { status: 503 })
          : Response.json({ call }, { status: 201 });
      },
    });
    const result = await client.calls.create(call.chat_id, {
      to: ["echo"], mode: "audio",
    }, { idempotencyKey: "same-call-request" });
    expect(result.call).toEqual(call);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toBe(`https://api.staging.relayapp.im/v1/chats/${call.chat_id}/calls`);
      const headers = new Headers(request.init.headers);
      expect(headers.get("idempotency-key")).toBe("same-call-request");
      expect(headers.get("authorization")).toBe("Bearer agent-test-token");
      expect(JSON.parse(String(request.init.body))).toEqual({ to: ["echo"], mode: "audio" });
    }
  });

  it("refuses a missing idempotency key before sending", () => {
    const client = new Relay({
      apiKey: "token",
      fetch: async () => { throw new Error("Must not send"); },
    });
    expect(() => client.calls.create(call.chat_id, {
      to: ["echo"], mode: "audio",
    }, { idempotencyKey: "" })).toThrow(/idempotencyKey/);
  });

  it.each(["accept", "decline", "end", "connected"] as const)(
    "sends the exact %s action",
    async (action) => {
      let observed: { url: string; body: unknown } | undefined;
      const client = new Relay({
        apiKey: "token", baseURL: "https://api.staging.relayapp.im",
        fetch: async (url, init) => {
          observed = { url: String(url), body: JSON.parse(String(init?.body)) };
          return Response.json({ call } satisfies CallResponse);
        },
      });
      expect(await client.calls[action](call.id)).toEqual({ call });
      expect(observed).toEqual({
        url: `https://api.staging.relayapp.im/v1/calls/${call.id}/${action}`, body: {},
      });
    },
  );

  it("returns the ephemeral audio grant without replacing the Agent Token", async () => {
    const requests: RequestInit[] = [];
    const connection = {
      id: "01995bc0-0000-7000-8000-000000000005",
      call_id: call.id, transport: "websocket",
      url: `wss://api.staging.relayapp.im/v1/calls/${call.id}/media`,
      token: "temporary-media-grant",
      expires_at: "2026-09-17T12:01:00Z",
      audio_format: { encoding: "pcm_s16le", sample_rate: 48000, channels: 2 },
    };
    const client = new Relay({
      apiKey: "agent-token",
      fetch: async (_url, init) => {
        requests.push(init!);
        return Response.json(requests.length === 1 ? { connection } : { call }, { status: 201 });
      },
    });
    expect(await client.calls.connections.create(call.id, { transport: "websocket" }))
      .toEqual({ connection });
    await client.calls.end(call.id);
    expect(new Headers(requests[1]!.headers).get("authorization")).toBe("Bearer agent-token");
    expect(JSON.parse(String(requests[0]!.body))).toEqual({ transport: "websocket" });
  });

  it("does not silently retry media connection allocation", async () => {
    let attempts = 0;
    const client = new Relay({
      apiKey: "token", maxRetries: 3, retryBaseDelayMs: 0,
      fetch: async () => {
        attempts++;
        return Response.json({ error: { message: "unavailable" } }, { status: 503 });
      },
    });
    await expect(client.calls.connections.create(call.id, { transport: "websocket" }))
      .rejects.toThrow("unavailable");
    expect(attempts).toBe(1);
  });

  it("reads call history with its cursor and negotiated audio shapes", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const client = new Relay({
      apiKey: "token", baseURL: "https://api.staging.relayapp.im",
      fetch: async (url, init) => {
        seen.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return Response.json({ calls: [call], next_cursor: null });
      },
    });
    await client.calls.list(call.chat_id, { cursor: "cursor-one", limit: 10 });
    expect(new URL(seen[0]!.url).searchParams.get("cursor")).toBe("cursor-one");
    expect(new URL(seen[0]!.url).searchParams.get("limit")).toBe("10");
    expect(new URL(seen[0]!.url).pathname).toBe(`/v1/chats/${call.chat_id}/calls`);
    await client.calls.connections.subscribe(call.id, "connection");
    expect(seen[1]!.body).toEqual({});
    expect(new URL(seen[1]!.url).pathname).toBe(`/v1/calls/${call.id}/connections/connection/subscribe`);
    await client.calls.connections.renegotiate(call.id, "connection", {
      session_description: { type: "answer", sdp: "v=0\r\n" },
    });
    expect(seen[2]!.body).toEqual({ session_description: { type: "answer", sdp: "v=0\r\n" } });
    expect(new URL(seen[2]!.url).pathname).toBe(`/v1/calls/${call.id}/connections/connection/renegotiate`);
  });

  it("encodes call IDs and sends the user SDP without vendor fields", async () => {
    const seen: Array<{ path: string; method: string; body: unknown }> = [];
    const client = new Relay({
      apiKey: "token",
      fetch: async (url, init) => {
        seen.push({
          path: new URL(String(url)).pathname, method: init!.method!,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json({ call });
      },
    });
    await client.calls.retrieve("call/one");
    await client.calls.connections.create(call.id, {
      transport: "webrtc",
      session_description: { type: "offer", sdp: "v=0\r\n" },
      tracks: [{ mid: "0", name: "microphone" }],
    });
    expect(seen).toEqual([
      { path: "/v1/calls/call%2Fone", method: "GET", body: undefined },
      {
        path: `/v1/calls/${call.id}/connections`, method: "POST",
        body: {
          transport: "webrtc",
          session_description: { type: "offer", sdp: "v=0\r\n" },
          tracks: [{ mid: "0", name: "microphone" }],
        },
      },
    ]);
  });

  it.each(["call.created", "call.updated", "call.ended"] as const)(
    "receives a signed typed %s event without an invented transport",
    (eventType) => {
      const secret = `whsec_${Buffer.alloc(32, 17).toString("base64")}`;
      const now = new Date();
      const event: CallWebhookEvent = {
        api_version: "v1", webhook_version: "2026-08-30", event_type: eventType,
        event_id: "event-call", agent_id: call.to[0].id,
        created_at: now.toISOString(), trace_id: "trace-call", data: { call },
      };
      const body = JSON.stringify(event);
      const client = new Relay({ apiKey: "agent-token", webhookSecret: secret });
      const received = client.webhooks.unwrap(body, {
        headers: {
          "webhook-id": event.event_id,
          "webhook-timestamp": String(Math.floor(now.getTime() / 1_000)),
          "webhook-signature": new Webhook(secret).sign(event.event_id, now, body),
        },
      });
      expect(received).toEqual(event);
      if (received.event_type === "call.created" || received.event_type === "call.updated"
        || received.event_type === "call.ended") {
        received.data.call satisfies Call;
        expect(received.data.call.id).toBe(call.id);
      } else throw new Error("Call event did not narrow.");
    },
  );
});
