import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeApiOrigin, PRODUCTION_ORIGIN, resolveApiOrigin, RelayClient } from "./api.js";

test("API origins require HTTPS except explicit loopback development", () => {
  assert.equal(normalizeApiOrigin("https://api.relayapp.im/"), "https://api.relayapp.im");
  assert.equal(normalizeApiOrigin("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.equal(normalizeApiOrigin("http://localhost:3000/"), "http://localhost:3000");
  assert.throws(() => normalizeApiOrigin("http://api.relayapp.im"), /must use HTTPS/);
  assert.throws(() => normalizeApiOrigin("https://user:secret@example.com"), /credentials/);
  assert.throws(() => normalizeApiOrigin("https://example.com/relay"), /without a path/);
  assert.throws(() => normalizeApiOrigin("file:///tmp/relay"), /without a path|must use HTTPS/);
});

test("RELAY_API_ORIGIN overrides the origin only through normalizeApiOrigin", () => {
  const saved = process.env.RELAY_API_ORIGIN;
  try {
    delete process.env.RELAY_API_ORIGIN;
    assert.equal(resolveApiOrigin(), PRODUCTION_ORIGIN);
    assert.equal(resolveApiOrigin("https://paired.example"), "https://paired.example");

    process.env.RELAY_API_ORIGIN = "http://127.0.0.1:8787/";
    assert.equal(resolveApiOrigin(), "http://127.0.0.1:8787");
    assert.equal(resolveApiOrigin("https://paired.example"), "http://127.0.0.1:8787");

    // The loopback-HTTP carve-out in normalizeApiOrigin stays the only place
    // plain HTTP is allowed; the env var is not a second escape hatch.
    process.env.RELAY_API_ORIGIN = "http://staging.example";
    assert.throws(() => resolveApiOrigin(), /must use HTTPS/);
    process.env.RELAY_API_ORIGIN = "not a url";
    assert.throws(() => resolveApiOrigin(), /invalid baseUrl/);

    process.env.RELAY_API_ORIGIN = "   ";
    assert.equal(resolveApiOrigin(), PRODUCTION_ORIGIN);
  } finally {
    if (saved === undefined) delete process.env.RELAY_API_ORIGIN;
    else process.env.RELAY_API_ORIGIN = saved;
  }
});

test("RelayClient normalizes the origin before any bearer-authenticated request", () => {
  const client = new RelayClient("https://api.relayapp.im/", "token", async () => {
    throw new Error("unused");
  });
  assert.equal(client.origin, "https://api.relayapp.im");
  assert.throws(() => new RelayClient("http://example.com", "token"), /must use HTTPS/);
});

/** A fetch that answers one canned response and records what it was asked. */
function stubFetch(reply: { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("the device token endpoint branches on which error vocabulary answered", async () => {
  const granted = stubFetch({
    status: 200,
    body: { access_token: "sess_1", token_type: "Bearer", expires_in: 3600, scope: "" },
  });
  const client = new RelayClient("https://api.relayapp.im", undefined, granted.impl);
  assert.deepEqual(await client.pollDeviceToken("dev_1", "relaymessenger-cli"), {
    kind: "token",
    access_token: "sess_1",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "",
  });
  // JSON only: a form-encoded body is refused with 415.
  assert.equal(granted.calls[0]!.url, "https://api.relayapp.im/api/auth/device/token");
  assert.match(
    (granted.calls[0]!.init.headers as Record<string, string>)["content-type"]!,
    /application\/json/,
  );
  assert.deepEqual(JSON.parse(granted.calls[0]!.init.body as string), {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: "dev_1",
    client_id: "relaymessenger-cli",
  });

  // RFC 8628 state.
  const pending = new RelayClient(
    "https://api.relayapp.im",
    undefined,
    stubFetch({ status: 400, body: { error: "authorization_pending" } }).impl,
  );
  assert.deepEqual(await pending.pollDeviceToken("dev_1", "c"), {
    kind: "oauth_error",
    error: "authorization_pending",
  });

  // Better Auth's own shape for a request it refused before the grant.
  const rejected = new RelayClient(
    "https://api.relayapp.im",
    undefined,
    stubFetch({ status: 400, body: { message: "device_code is required", code: "BAD_REQUEST" } }).impl,
  );
  assert.deepEqual(await rejected.pollDeviceToken("dev_1", "c"), {
    kind: "request_error",
    message: "device_code is required",
    code: "BAD_REQUEST",
  });

  // A 5xx leaves the grant untouched, so it is retryable rather than terminal.
  const blip = new RelayClient(
    "https://api.relayapp.im",
    undefined,
    stubFetch({ status: 503, body: { message: "unavailable" } }).impl,
  );
  assert.equal((await blip.pollDeviceToken("dev_1", "c")).kind, "transient");
});

test("events are a plain pull: `after`, and the page reports how far behind it is", async () => {
  const stub = stubFetch({
    status: 200,
    body: { events: [{ event_id: "evt_1", event_type: "message.received" }], next_cursor: 8, latest: 12, has_more: true },
  });
  const client = new RelayClient("https://api.relayapp.im", "rly_live_x", stub.impl);
  const page = await client.getEvents(7, 25, 100);
  assert.deepEqual(page.events.map((event) => event.event_id), ["evt_1"]);
  assert.equal(page.next_cursor, 8);
  assert.equal(page.latest, 12);
  assert.equal(page.has_more, true);
  const url = new URL(stub.calls[0]!.url);
  assert.equal(url.pathname, "/v1/events");
  assert.equal(url.searchParams.get("after"), "7");
  assert.equal(url.searchParams.get("cursor"), null, "the old parameter name is gone");
});

test("a send carries the caller's message id, or mints one, and never an Idempotency-Key", async () => {
  const stub = stubFetch({ status: 201, body: { message: { id: "msg_committed" } } });
  const client = new RelayClient("https://api.relayapp.im", "rly_live_x", stub.impl);

  const minted = await client.postMessage({
    chat_id: "cnv_a",
    parts: [{ type: "text", text: "hi" }],
  });
  assert.match(minted.message_id, /^msg_[0-9a-hjkmnp-tv-z]{26}$/);
  assert.equal(
    JSON.parse(stub.calls[0]!.init.body as string).message_id,
    minted.message_id,
  );
  assert.equal(
    (stub.calls[0]!.init.headers as Record<string, string>)["idempotency-key"],
    undefined,
  );
  assert.equal(new URL(stub.calls[0]!.url).pathname, "/v2/chats/cnv_a/messages");

  const reused = await client.postMessage({
    chat_id: "cnv_a",
    message_id: "msg_01k1m9x2ph4vb7k0d3wzr8ftqe",
    parts: [{ type: "text", text: "hi" }],
  });
  assert.equal(reused.message_id, "msg_01k1m9x2ph4vb7k0d3wzr8ftqe");
});
