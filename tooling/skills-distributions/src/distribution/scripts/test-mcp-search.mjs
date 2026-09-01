#!/usr/bin/env node
import assert from "node:assert/strict";
import { callMcp, searchRelay } from "./mcp-client.mjs";

const initialized = await callMcp("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: {
    name: "relay-distribution-test",
    version: "1.0.0",
  },
});
assert.equal(initialized.serverInfo.name, "Relay");

const listed = await callMcp("tools/list", {}, 2);
const search = listed.tools.find((tool) => tool.name === "search_relay");
assert.ok(search, "search_relay is not exposed");
assert.equal(search.annotations.readOnlyHint, true);

const result = await searchRelay("Relay API authentication Agent Token");
assert.match(result, /https:\/\/docs\.relayapp\.im\//);
assert.match(result, /Relay/i);

console.log("verified Relay docs MCP initialization, tools, and search call");
