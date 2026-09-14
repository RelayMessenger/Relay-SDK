import type Relay from "@relaymessenger/sdk";
import { verifyWebhookSignature, WebhookVerificationError, type RelayWebhookEvent } from "@relaymessenger/sdk";
import { describe, expect, it, vi } from "vitest";
import { newLocalWebhookSecret } from "./config.js";
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

const secret = newLocalWebhookSecret();
const headersOf = (request: RequestInit): Record<string, string> => request.headers as Record<string, string>;

describe("development event listener", () => {
  it("forwards a copy signed like a deployed webhook, and only then counts it delivered", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const run = vi.fn(async (options) => options.onEvent(event, { sequence: "1" }));
    const client = { websocket: { run } } as unknown as Relay;
    const stdout = vi.fn();
    await listenForAgentEvents(
      client,
      { forwardTo: "http://127.0.0.1:3000/events", secret, fetch: fetchMock, render: () => "line" },
      { stdout, stderr: vi.fn() },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0]![1]!;
    const headers = headersOf(request);
    expect(headers).toMatchObject({
      "x-relay-event-id": event.event_id,
      "x-relay-event-type": event.event_type,
      "webhook-id": event.event_id,
    });
    expect(headers).not.toHaveProperty("x-relay-dev-forwarded");
    expect(headers["webhook-timestamp"]).toMatch(/^\d{10}$/u);
    expect(headers["webhook-signature"]).toMatch(/^v1,/u);
    const body = request.body as string;
    expect(body).toBe(JSON.stringify(event));
    // The developer's handler verifies with the printed secret and the SDK.
    expect(() => verifyWebhookSignature(secret, body, headers)).not.toThrow();
    // A tampered body, or another secret, fails the same check.
    expect(() => verifyWebhookSignature(secret, body.replace("message.received", "message.sent"), headers))
      .toThrow(WebhookVerificationError);
    expect(() => verifyWebhookSignature(newLocalWebhookSecret(), body, headers)).toThrow(WebhookVerificationError);
    expect(stdout).toHaveBeenCalledWith("line\n");
  });

  it("prints the raw envelope after a forward when no line form is given", async () => {
    const run = vi.fn(async (options) => options.onEvent(event, { sequence: "1" }));
    const client = { websocket: { run } } as unknown as Relay;
    const stderr = vi.fn();
    await listenForAgentEvents(
      client,
      { forwardTo: "http://localhost:3000/events", secret, fetch: async () => new Response(null, { status: 200 }) },
      { stdout: vi.fn(), stderr },
    );
    expect(stderr).toHaveBeenCalledWith(`forwarded ${event.event_type} ${event.event_id}\n`);
  });

  it("refuses to forward without a signing secret", async () => {
    const client = { websocket: { run: vi.fn() } } as unknown as Relay;
    await expect(listenForAgentEvents(
      client,
      { forwardTo: "http://localhost:3000/events" },
      { stdout: vi.fn(), stderr: vi.fn() },
    )).rejects.toThrow(/signing secret/u);
  });

  it("refuses an address that is not on this computer", async () => {
    const client = { websocket: { run: vi.fn() } } as unknown as Relay;
    await expect(listenForAgentEvents(
      client,
      { forwardTo: "http://example.com/events", secret },
      { stdout: vi.fn(), stderr: vi.fn() },
    )).rejects.toThrow(/must be on this computer/u);
  });

  it("does not acknowledge a failed forward", async () => {
    const run = vi.fn(async (options) => options.onEvent(event, { sequence: "1" }));
    const client = { websocket: { run } } as unknown as Relay;
    await expect(listenForAgentEvents(
      client,
      {
        forwardTo: "http://localhost:3000/events",
        secret,
        fetch: async () => new Response(null, { status: 503 }),
      },
      { stdout: vi.fn(), stderr: vi.fn() },
    )).rejects.toThrow(/answered with error 503/u);
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
    )).rejects.toThrow(/it cannot go back/u);
  });
});
