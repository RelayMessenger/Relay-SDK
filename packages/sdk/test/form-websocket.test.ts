import { once } from "node:events";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";
import { expect, it } from "vitest";
import Relay, * as sdk from "../src/index.js";
import type { RelayWebhookEvent } from "../src/index.js";

it("delivers form answers through the real WebSocket before acknowledging them", async () => {
  expect(typeof sdk.formReply).toBe("function");
  const fixture = JSON.parse(readFileSync(new URL("../../../test/fixtures/form-parts.json", import.meta.url), "utf8"));
  const event: RelayWebhookEvent = JSON.parse(readFileSync(new URL("./fixtures/message.received.json", import.meta.url), "utf8"));
  const target = { message_id: "01993d50-ef7b-7b37-886b-23fd80c7ec13", part_index: 1 };
  if (event.event_type !== "message.received") throw new Error("wrong fixture");
  event.data.parts = [
    { type: "text", value: "Form sent", reactions: null },
    { type: "form_response", answers: fixture.answers },
  ];
  event.data.reply_to = target;
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("missing address");
  const controller = new AbortController();
  const received: unknown[] = [];
  let acknowledge!: (value: unknown) => void;
  const acknowledged = new Promise((resolve) => { acknowledge = resolve; });
  server.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "ack") acknowledge(frame);
    });
    socket.send(JSON.stringify({
      type: "ready", connection_id: "01993d50-ef7b-7b37-886b-23fd80c7ec10",
      acked_through: "0", full_sync_required: false, full_sync_through: null,
      heartbeat_interval_ms: 30_000, max_in_flight: 64,
    }));
    socket.send(JSON.stringify({ type: "event", sequence: "1", event }));
  });
  const relay = new Relay({ apiKey: "test", baseURL: `http://127.0.0.1:${address.port}` });
  const running = relay.websocket.run({
    signal: controller.signal,
    onFullSync: async () => {},
    onEvent: async (envelope) => {
      if (envelope.event_type !== "message.received") throw new Error("wrong event");
      received.push(sdk.formReply(envelope.data.parts, envelope.data.reply_to));
    },
  });
  try {
    expect(await acknowledged).toEqual({ type: "ack", through_sequence: "1" });
    expect(received).toEqual([{ answers: fixture.answers, reply_to: target }]);
  } finally {
    controller.abort();
    await running;
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
