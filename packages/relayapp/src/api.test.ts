import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeApiOrigin, RelayClient } from "./api.js";

test("API origins require HTTPS except explicit loopback development", () => {
  assert.equal(normalizeApiOrigin("https://api.relayapp.im/"), "https://api.relayapp.im");
  assert.equal(normalizeApiOrigin("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  assert.equal(normalizeApiOrigin("http://localhost:3000/"), "http://localhost:3000");
  assert.throws(() => normalizeApiOrigin("http://api.relayapp.im"), /must use HTTPS/);
  assert.throws(() => normalizeApiOrigin("https://user:secret@example.com"), /scheme and host/);
  assert.throws(() => normalizeApiOrigin("https://example.com/relay"), /scheme and host/);
  assert.throws(() => normalizeApiOrigin("file:///tmp/relay"), /scheme and host|must use HTTPS/);
});

test("RelayClient normalizes the origin before any bearer-authenticated request", () => {
  const client = new RelayClient("https://api.relayapp.im/", "token", async () => {
    throw new Error("unused");
  });
  assert.equal(client.origin, "https://api.relayapp.im");
  assert.throws(() => new RelayClient("http://example.com", "token"), /must use HTTPS/);
});
