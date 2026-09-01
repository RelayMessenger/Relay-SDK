#!/usr/bin/env node
import assert from "node:assert/strict";
import { searchRelay } from "./mcp-client.mjs";

const transport = await searchRelay(
  "Relay v1 /v1/websocket /v1/webhook-subscriptions full_sync",
);
for (const marker of [
  "/v1/websocket",
  "/v1/webhook-subscriptions",
]) {
  assert.ok(
    transport.includes(marker),
    `live docs search is missing ${marker}`,
  );
}

const retiredPath = "/v1/" + "ev" + "ents";
assert.ok(
  !transport.includes(retiredPath),
  "live docs search still returns a retired receive route",
);

const webhook = await searchRelay(
  "message.received webhook_version 2026-08-30 api_version v1",
);
for (const marker of ["webhook_version", "2026-08-30", "api_version"]) {
  assert.ok(
    webhook.includes(marker),
    `live docs webhook search is missing ${marker}`,
  );
}

console.log("verified live Relay docs search agrees with the locked v1 contract");
