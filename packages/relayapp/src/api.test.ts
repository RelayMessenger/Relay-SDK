import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeApiOrigin, PRODUCTION_ORIGIN, resolveApiOrigin, RelayClient } from "./api.js";

test("API origins require HTTPS except explicit loopback development", () => {
  assert.equal(normalizeApiOrigin("https://api.relayapp.im/"), "https://api.relayapp.im");
  assert.equal(normalizeApiOrigin("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.equal(normalizeApiOrigin("http://localhost:3000/"), "http://localhost:3000");
  assert.throws(() => normalizeApiOrigin("http://api.relayapp.im"), /must use HTTPS/);
  assert.throws(() => normalizeApiOrigin("https://user:secret@example.com"), /scheme and host/);
  assert.throws(() => normalizeApiOrigin("https://example.com/relay"), /scheme and host/);
  assert.throws(() => normalizeApiOrigin("file:///tmp/relay"), /scheme and host|must use HTTPS/);
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
    assert.throws(() => resolveApiOrigin(), /Invalid Relay API origin/);

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
