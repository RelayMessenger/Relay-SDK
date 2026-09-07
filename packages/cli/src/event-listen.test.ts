import type Relay from "@relaymessenger/sdk";
import type { RelayWebhookEvent } from "@relaymessenger/sdk";
import { describe, expect, it, vi } from "vitest";
import { listenForAgentEvents } from "./event-listen.js";

const event = {
  api_version: "v1",
  webhook_version: "2026-02-03",
  event_type: "message.received",
  event_id: "01993d50-4133-7178-8e16-7c1455c91d43",
  created_at: "2026-09-01T00:00:00.000Z",
  trace_id: "trace",
  agent_id: "01993d50-d2a8-7fe2-8b76-9eaf04816377",
  data: {},
} as RelayWebhookEvent;

describe("development event listener", () => {
  it("forwards only after a loopback target accepts the original envelope", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const run = vi.fn(async (options) => options.onEvent(event, { sequence: "1" }));
    const client = { websocket: { run } } as unknown as Relay;
    await listenForAgentEvents(
      client,
      { forwardTo: "http://127.0.0.1:3000/events", fetch: fetchMock },
      { stdout: vi.fn(), stderr: vi.fn() },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0]![1]!;
    expect(request.headers).toMatchObject({
      "x-relay-dev-forwarded": "1",
      "x-relay-event-id": event.event_id,
    });
    expect(request.body).toBe(JSON.stringify(event));
  });

  it("does not acknowledge a failed forward", async () => {
    const run = vi.fn(async (options) => options.onEvent(event, { sequence: "1" }));
    const client = { websocket: { run } } as unknown as Relay;
    await expect(listenForAgentEvents(
      client,
      {
        forwardTo: "http://localhost:3000/events",
        fetch: async () => new Response(null, { status: 503 }),
      },
      { stdout: vi.fn(), stderr: vi.fn() },
    )).rejects.toThrow(/not acknowledged/);
  });

  it("refuses FULL sync rather than acknowledging incomplete state", async () => {
    const run = vi.fn(async (options) =>
      options.onFullSync({
        throughSequence: "99",
        reason: "checkpoint_outside_retention",
      }));
    const client = { websocket: { run } } as unknown as Relay;
    await expect(listenForAgentEvents(
      client,
      {},
      { stdout: vi.fn(), stderr: vi.fn() },
    )).rejects.toThrow(/cannot rebuild durable state/);
  });
});
