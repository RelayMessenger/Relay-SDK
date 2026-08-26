import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { after, before, describe, it } from "node:test";

import { buildPermissionCard, buildReply } from "../src/bridge.ts";
import { RelayApiError, RelayClient, normalizeRelayBaseUrl } from "../src/relayClient.ts";
import { startPoller } from "../src/poller.ts";
import type { RelayEvent } from "../src/types.ts";

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: unknown;
}

/** Tiny scriptable Relay stand-in: shift one canned response per request. */
class MockRelay {
  readonly requests: RecordedRequest[] = [];
  private readonly responses: { status: number; body: unknown }[] = [];
  private server: Server | null = null;
  baseUrl = "";

  enqueue(status: number, body: unknown): void {
    this.responses.push({ status, body });
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const address = this.server?.address();
    if (typeof address === "object" && address) {
      this.baseUrl = `http://127.0.0.1:${address.port}`;
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    this.requests.push({
      method: req.method ?? "",
      url: req.url ?? "",
      headers: req.headers,
      body: raw.length > 0 ? JSON.parse(raw) : null,
    });
    const scripted = this.responses.shift() ?? { status: 500, body: { error: { code: "unscripted", message: "no response scripted" } } };
    res.writeHead(scripted.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(scripted.body));
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

function event(id: string, text: string): RelayEvent {
  return {
    event_id: id,
    event_type: "message.received",
    agent_id: "agt_1",
    created_at: "2026-07-17T00:00:00.000Z",
    data: {
      message: {
        id: `msg_${id}`,
        conversation_id: "cnv_1",
        sequence: 1,
        sender: { kind: "user", id: "usr_owner1" },
        parts: [{ part_index: 0, type: "text", text }],
        fallback_text: text,
        created_at: "2026-07-17T00:00:00.000Z",
      },
    },
  };
}

describe("RelayClient against a mocked Relay server", () => {
  const relay = new MockRelay();
  before(async () => relay.start());
  after(async () => relay.stop());

  it("pollEvents sends after/timeout/limit and bearer auth", async () => {
    relay.enqueue(200, {
      events: [event("evt_1", "hi")],
      next_cursor: 4,
      latest: 9,
      has_more: true,
    });
    const client = new RelayClient({ baseUrl: relay.baseUrl, token: "rly_test" });
    const batch = await client.pollEvents({ after: 3, timeoutSeconds: 1, limit: 50 });

    assert.equal(batch.next_cursor, 4);
    assert.equal(batch.latest, 9);
    assert.equal(batch.has_more, true);
    assert.equal(batch.events.length, 1);
    const request = relay.requests.at(-1);
    assert.ok(request);
    assert.equal(request.method, "GET");
    const url = new URL(request.url, relay.baseUrl);
    assert.equal(url.pathname, "/v1/events");
    assert.equal(url.searchParams.get("after"), "3");
    assert.equal(url.searchParams.get("timeout"), "1");
    assert.equal(url.searchParams.get("limit"), "50");
    assert.equal(request.headers.authorization, "Bearer rly_test");
  });

  it("defaults latest to the page cursor when the server omits the extras", async () => {
    relay.enqueue(200, { events: [], next_cursor: 7 });
    const client = new RelayClient({ baseUrl: relay.baseUrl, token: "rly_test" });
    const batch = await client.pollEvents({ after: 7, timeoutSeconds: 1 });
    assert.equal(batch.latest, 7);
    assert.equal(batch.has_more, false);
  });

  it("reply handler body: sendMessage posts parts under the minted message id", async () => {
    relay.enqueue(202, { message_id: "msg_9", message: {} });
    const client = new RelayClient({ baseUrl: relay.baseUrl, token: "rly_test" });
    await client.sendMessage(buildReply("cnv_1", "on it", "msg_01k1m9x2ph4vb7k0d3wzr8ftqe"));

    const request = relay.requests.at(-1);
    assert.ok(request);
    assert.equal(request.method, "POST");
    assert.equal(new URL(request.url, relay.baseUrl).pathname, "/v1/messages");
    // The id in the body is the retry key; no header carries one.
    assert.equal(request.headers["idempotency-key"], undefined);
    assert.equal(request.headers["content-type"], "application/json");
    assert.deepEqual(request.body, {
      conversation_id: "cnv_1",
      message_id: "msg_01k1m9x2ph4vb7k0d3wzr8ftqe",
      parts: [{ type: "text", text: "on it" }],
    });
  });

  it("permission card posts text + data parts under its durable message id", async () => {
    relay.enqueue(202, { message_id: "msg_10", message: {} });
    const client = new RelayClient({ baseUrl: relay.baseUrl, token: "rly_test" });
    const card = buildPermissionCard(
      { request_id: "abcde", tool_name: "Bash", description: "List files", input_preview: "ls" },
      "cnv_1",
      "msg_01k1m9x2ph4vb7k0d3wzr8ftqf",
    );
    await client.sendMessage(card.body);

    const request = relay.requests.at(-1);
    assert.ok(request);
    const body = request.body as { message_id: string; parts: { type: string }[] };
    assert.equal(body.message_id, "msg_01k1m9x2ph4vb7k0d3wzr8ftqf");
    assert.deepEqual(body.parts.map((p) => p.type), ["text", "data"]);
  });

  it("surfaces Relay error envelopes as RelayApiError", async () => {
    relay.enqueue(422, {
      error: { code: "invalid_request", message: "text part exceeds the byte cap" },
    });
    const client = new RelayClient({ baseUrl: relay.baseUrl, token: "rly_test" });
    await assert.rejects(
      client.pollEvents({ after: 0, timeoutSeconds: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof RelayApiError);
        assert.equal(error.status, 422);
        assert.equal(error.code, "invalid_request");
        return true;
      },
    );
  });
});

describe("Relay origin validation", () => {
  it("canonicalizes equivalent HTTPS origins", () => {
    assert.equal(normalizeRelayBaseUrl("https://API.RELAYAPP.IM:443/"), "https://api.relayapp.im");
  });

  it("allows HTTP only for loopback development", () => {
    assert.equal(normalizeRelayBaseUrl("http://127.0.0.1:8787/"), "http://127.0.0.1:8787");
    assert.throws(() => normalizeRelayBaseUrl("http://api.relayapp.im"), /HTTPS/);
  });

  it("rejects paths, query strings, fragments, and embedded credentials", () => {
    for (const value of [
      "https://api.relayapp.im/v1",
      "https://api.relayapp.im?token=x",
      "https://api.relayapp.im/#x",
      "https://user:pass@api.relayapp.im",
    ]) {
      assert.throws(() => normalizeRelayBaseUrl(value));
    }
  });
});

describe("poller loop", () => {
  it("hands events over in order, then advances and persists the cursor", async () => {
    const relay = new MockRelay();
    await relay.start();
    relay.enqueue(200, { events: [event("evt_1", "first"), event("evt_2", "second")], next_cursor: 2 });
    relay.enqueue(200, { events: [], next_cursor: 2 });

    const client = new RelayClient({ baseUrl: relay.baseUrl, token: "rly_test" });
    let cursor = 0;
    const seen: string[] = [];
    const cursorAtHandoff: number[] = [];

    await new Promise<void>((resolve) => {
      const poller = startPoller({
        client,
        getCursor: () => cursor,
        setCursor: (next) => {
          cursor = next;
        },
        onEvent: async (e) => {
          seen.push(e.event_id);
          cursorAtHandoff.push(cursor);
          if (seen.length === 2) {
            // Stop after this batch drains; the second scripted poll may or
            // may not fire before abort, which is fine.
            setTimeout(() => {
              poller.stop();
              resolve();
            }, 50);
          }
        },
        log: () => {},
        timeoutSeconds: 1,
      });
    });

    assert.deepEqual(seen, ["evt_1", "evt_2"]);
    // durable-before-ack: the cursor only moves after the batch is handed over
    assert.deepEqual(cursorAtHandoff, [0, 0]);
    assert.equal(cursor, 2);
    await relay.stop();
  });

  it("does not advance the cursor past a failed notification and retries the batch", async () => {
    const relay = new MockRelay();
    await relay.start();
    const batch = { events: [event("evt_1", "first"), event("evt_2", "second")], next_cursor: 2 };
    relay.enqueue(200, batch); // first poll: evt_2 handler fails
    relay.enqueue(200, batch); // retry poll of the same window: both succeed
    relay.enqueue(200, { events: [], next_cursor: 2 });

    const client = new RelayClient({ baseUrl: relay.baseUrl, token: "rly_test" });
    let cursor = 0;
    const cursorHistory: number[] = [];
    const handled: string[] = [];
    let failOnce = true;
    const notified = new Set<string>(); // stands in for the server's dedupe set

    await new Promise<void>((resolve) => {
      const poller = startPoller({
        client,
        getCursor: () => cursor,
        setCursor: (next) => {
          cursor = next;
          cursorHistory.push(next);
        },
        onEvent: async (e) => {
          if (notified.has(e.event_id)) return;
          if (e.event_id === "evt_2" && failOnce) {
            failOnce = false;
            throw new Error("notification transport failed");
          }
          notified.add(e.event_id);
          handled.push(e.event_id);
          if (handled.length === 2) {
            setTimeout(() => {
              poller.stop();
              resolve();
            }, 50);
          }
        },
        log: () => {},
        timeoutSeconds: 1,
        sleep: async () => {},
      });
    });

    // evt_1 delivered once (dedupe skipped the replay), evt_2 delivered on retry
    assert.deepEqual(handled, ["evt_1", "evt_2"]);
    // the cursor never advanced while evt_2 was undelivered
    assert.deepEqual(cursorHistory, [2]);
    assert.equal(cursor, 2);
    await relay.stop();
  });
});
