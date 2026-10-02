import { once } from "node:events";
import { WebSocketServer } from "ws";
import { expect, it } from "vitest";
import Relay, { answerMessages, ratingRequestPart, ratingRequestPartsError,
  RELAY_WEBHOOK_EVENT_TYPES, signWebhookHeaders, type RelayWebhookEvent,
  type RatingRequestPartResponse } from "../src/index.js";

const contact = { id: "01993d50-b4ce-71e6-8e65-35d325d95ddb", handle: "person", display_name: "Person",
  timezone: null, age_range: null, links: [], about: null };
const envelope = (event_type: "rating.created" | "rating.updated" | "rating.deleted"): RelayWebhookEvent => ({
  api_version: "v1", webhook_version: "2026-08-30", event_type,
  event_id: "01993d50-b4ce-71e6-8e65-35d325d95ddc", trace_id: "rating-test",
  created_at: new Date().toISOString(), agent_id: "01993d50-b4ce-71e6-8e65-35d325d95ddd",
  data: event_type === "rating.deleted" ? { contact } : { contact, stars: 5, review: null,
    created_at: "2026-10-02T00:00:00Z", updated_at: "2026-10-02T00:00:00Z" },
});

it("sends a bare rating request; response carries only the reader's rating", async () => {
  const calls: unknown[] = [];
  const part: RatingRequestPartResponse = { type: "rating_request", rating: { stars: 4, review: "Helpful" }, reactions: null };
  const client = new Relay({ apiKey: "fixture", fetch: async (_, init) => {
    calls.push(JSON.parse(String(init?.body))); return Response.json({ message: { id: contact.id, parts: [part] } });
  } });
  const result = await client.chats.messages.send(contact.id, { message: { parts: [ratingRequestPart()] } });
  expect(calls).toEqual([{ message: { parts: [{ type: "rating_request" }] } }]);
  expect(result.message.parts).toEqual([part]);
  expect(ratingRequestPartsError([ratingRequestPart()])).toBeUndefined();
  for (const parts of [[ratingRequestPart(), { type: "text", value: "Words" }],
    [{ type: "rating_request", rating: 5 }], [{ type: "rating_request", handle: "other" }],
    [{ type: "rating_request", title: "Rate me" }]]) expect(ratingRequestPartsError(parts)).toBeTypeOf("string");
});

it("text-only bridges send the empty rating fence alone, without inventing a target or words", () => {
  expect(answerMessages('```rating_request\n{}\n```')).toEqual({ messages: [[{ type: "rating_request" }]] });
  for (const text of ['Words\n```rating_request\n{}\n```', '```rating_request\n{"stars":5}\n```',
    '```rating_request\n{}\n```\n```buttons\n["Yes"]\n```']) {
    const result = answerMessages(text); expect(result.error).toBeTruthy();
    expect(result.messages).toEqual([[{ type: "text", value: text }]]);
  }
});

for (const type of ["rating.created", "rating.updated", "rating.deleted"] as const) {
  it(`verifies signed ${type} unchanged`, () => {
    expect(RELAY_WEBHOOK_EVENT_TYPES).toContain(type);
    const event = envelope(type); const body = JSON.stringify(event);
    const secret = `whsec_${Buffer.alloc(32, 12).toString("base64")}`;
    const client = new Relay({ apiKey: "fixture", webhookSecret: secret });
    const headers = signWebhookHeaders(secret, { id: event.event_id, body });
    expect(client.webhooks.unwrap(body, { headers })).toEqual(event);
    expect(() => client.webhooks.unwrap(body + " ", { headers })).toThrow();
  });
  it(`delivers and ACKs ${type} instead of dropping it as unknown`, async () => {
    const event = envelope(type); const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(server, "listening"); const address = server.address();
    if (!address || typeof address === "string") throw Error("address missing");
    const controller = new AbortController(); const received: unknown[] = [];
    let ack!: (value: unknown) => void; const acknowledged = new Promise(resolve => { ack = resolve; });
    server.on("connection", (socket, request) => {
      expect(new URL(request.url!, "http://localhost").searchParams.getAll("subscribed_events")).toContain(type);
      socket.on("message", raw => { const frame = JSON.parse(String(raw)); if (frame.type === "ack") ack(frame); });
      socket.send(JSON.stringify({ type: "ready", connection_id: contact.id, acked_through: "0", full_sync_required: false,
        full_sync_through: null, heartbeat_interval_ms: 30_000, max_in_flight: 64 }));
      socket.send(JSON.stringify({ type: "event", sequence: "1", event }));
    });
    const client = new Relay({ apiKey: "fixture", baseURL: `http://127.0.0.1:${address.port}` });
    const running = client.websocket.run({ signal: controller.signal, onFullSync: async () => {},
      onEvent: async value => { received.push(value); } });
    try { expect(await acknowledged).toEqual({ type: "ack", through_sequence: "1" }); expect(received).toEqual([event]); }
    finally { controller.abort(); await running; for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
}
