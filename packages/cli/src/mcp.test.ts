import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RelayClient } from "./api.js";
import { MCP_PROTOCOL_VERSION, negotiateMcpProtocolVersion, sendMcpMessage } from "./mcp.js";
import { McpSendLedger } from "./store.js";

function context(home: string, postMessage: RelayClient["postMessage"]) {
  return () => ({
    client: { postMessage } as RelayClient,
    chatId: "cnv_owner",
    ownerUserId: "usr_owner",
    projectRoot: "/repo",
    runtimeHome: home,
    apiOrigin: "https://api.relayapp.im",
    accountIdentity: "agent:agt_1",
  });
}

test("Codex MCP lost-response retry reuses its caller-stable message id across restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-mcp-send-"));
  const ids: Array<string | undefined> = [];
  let calls = 0;
  const postMessage = (async (body: { message_id?: string }) => {
    ids.push(body.message_id);
    calls += 1;
    if (calls === 1) throw new Error("response lost after commit");
    return { message_id: body.message_id, message: {} } as any;
  }) as RelayClient["postMessage"];
  const input = { text: "deploy finished", send_id: "turn-7-progress-1" };

  await assert.rejects(sendMcpMessage(input, { requireContext: context(home, postMessage) }), /response lost/);
  // A fresh process reads the same ledger entry, so the retry is a replay of
  // the message the lost response may already have committed.
  await sendMcpMessage(input, { requireContext: context(home, postMessage) });
  assert.equal(ids.length, 2);
  assert.match(ids[0]!, /^msg_[0-9a-hjkmnp-tv-z]{26}$/);
  assert.equal(ids[0], ids[1]);
});

test("a ledger entry predating message ids adopts one instead of retrying a header the server dropped", async () => {
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-mcp-legacy-"));
  const ids: Array<string | undefined> = [];
  const postMessage = (async (body: { message_id?: string }) => {
    ids.push(body.message_id);
    return { message_id: body.message_id, message: {} } as any;
  }) as RelayClient["postMessage"];
  const ledger = new McpSendLedger(home, "https://api.relayapp.im", "agent:agt_1");
  const entry = ledger.register("legacy-1", "cnv_owner", "hello");
  // Rewrite the file the way an older CLI left it: an Idempotency-Key value
  // in place of the message id.
  const path = join(home, "mcp-sends", `${createHash("sha256").update("legacy-1").digest("hex")}.json`);
  const { message_id: _dropped, ...rest } = entry;
  writeFileSync(path, JSON.stringify({ ...rest, idempotency_key: "relay-mcp-abc" }));

  await sendMcpMessage({ text: "hello", send_id: "legacy-1" }, { requireContext: context(home, postMessage) });
  await sendMcpMessage({ text: "hello", send_id: "legacy-1" }, { requireContext: context(home, postMessage) });
  assert.match(ids[0]!, /^msg_[0-9a-hjkmnp-tv-z]{26}$/);
  assert.notEqual(ids[0], entry.message_id, "the adopted id is not the one the rewrite dropped");
  assert.equal(ids[0], ids[1], "and every later retry reuses it");
});

test("Codex MCP same send_id accepts exact retries but rejects changed content or account", async () => {
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-mcp-bind-"));
  const postMessage = (async () => ({ message_id: "msg_1", message: {} })) as unknown as RelayClient["postMessage"];
  const deps = { requireContext: context(home, postMessage) };
  await sendMcpMessage({ text: "same", send_id: "logical-1" }, deps);
  await sendMcpMessage({ text: "same", send_id: "logical-1" }, deps);
  await assert.rejects(
    sendMcpMessage({ text: "different", send_id: "logical-1" }, deps),
    /different content or account/,
  );

  const movedAccount = context(home, postMessage);
  await assert.rejects(
    sendMcpMessage(
      { text: "same", send_id: "logical-1" },
      {
        requireContext: () => ({ ...movedAccount(), accountIdentity: "agent:agt_2" }),
      },
    ),
    /different content or account/,
  );
});

test("Codex MCP requires a bounded caller-stable send_id", async () => {
  const home = mkdtempSync(join(tmpdir(), "relaymessenger-mcp-id-"));
  const postMessage = (async () => ({ message_id: "msg_1", message: {} })) as unknown as RelayClient["postMessage"];
  await assert.rejects(
    sendMcpMessage({ text: "hi" }, { requireContext: context(home, postMessage) }),
    /send_id is required/,
  );
});

test("MCP negotiation never echoes an unsupported client protocol", () => {
  assert.equal(negotiateMcpProtocolVersion(MCP_PROTOCOL_VERSION), MCP_PROTOCOL_VERSION);
  assert.equal(negotiateMcpProtocolVersion("2099-01-01"), MCP_PROTOCOL_VERSION);
  assert.equal(negotiateMcpProtocolVersion(undefined), MCP_PROTOCOL_VERSION);
});
