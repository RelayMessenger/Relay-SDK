import { describe, expect, it, vi } from "vitest";

import { createWebhookApplication } from "../src/application.js";

const EVENT = {
  api_version: "v1",
  webhook_version: "2026-08-30",
  event_type: "message.received",
  event_id: "01993d50-ef7b-7b37-886b-23fd80c7ec10",
  created_at: "2026-09-01T12:00:00Z",
  trace_id: "trace",
  agent_id: "01993d50-ef7b-7b37-886b-23fd80c7ec11",
  data: {
    chat: { id: "01993d50-ef7b-7b37-886b-23fd80c7ec12" },
    id: "01993d50-ef7b-7b37-886b-23fd80c7ec13",
    direction: "inbound",
    sender_handle: {},
    parts: [],
  },
} as const;

describe("Webhook acceptance boundary", () => {
  it("commits the verified event before acknowledging", async () => {
    const timeline: string[] = [];
    const application = createWebhookApplication({
      unwrap: (body) => {
        timeline.push(`verified:${body}`);
        return EVENT;
      },
      accept: () => {
        timeline.push("committed");
        return true;
      },
      wake: () => timeline.push("worker-woken"),
    });

    const response = await application(new Request(
      "https://example.test/webhooks/relay",
      { method: "POST", body: "exact raw body" },
    ));
    timeline.push(`response:${response.status}`);

    expect(timeline).toEqual([
      "verified:exact raw body",
      "committed",
      "worker-woken",
      "response:204",
    ]);
  });

  it("rejects a bad signature without touching the inbox", async () => {
    const accept = vi.fn();
    const application = createWebhookApplication({
      unwrap: () => {
        throw new Error("bad signature");
      },
      accept,
      wake: vi.fn(),
    });

    const response = await application(new Request(
      "https://example.test/webhooks/relay",
      { method: "POST", body: "{}" },
    ));

    expect(response.status).toBe(401);
    expect(accept).not.toHaveBeenCalled();
  });

  it("acknowledges a durable duplicate without scheduling it twice", async () => {
    const wake = vi.fn();
    const application = createWebhookApplication({
      unwrap: () => EVENT,
      accept: () => false,
      wake,
    });

    const response = await application(new Request(
      "https://example.test/webhooks/relay",
      { method: "POST", body: "{}" },
    ));

    expect(response.status).toBe(204);
    expect(wake).not.toHaveBeenCalled();
  });
});
