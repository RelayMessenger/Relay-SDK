import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RelayClient } from "./api.js";
import { MCP_PROTOCOL_VERSION, negotiateMcpProtocolVersion, sendMcpMessage } from "./mcp.js";

function context(home: string, postMessage: RelayClient["postMessage"]) {
  return () => ({
    client: { postMessage } as RelayClient,
    conversationId: "cnv_owner",
    ownerUserId: "usr_owner",
    projectRoot: "/repo",
    runtimeHome: home,
    apiOrigin: "https://api.relayapp.im",
    accountIdentity: "agent:agt_1",
  });
}

test("Codex MCP lost-response retry reuses its caller-stable idempotency key across restart", async () => {
  const home = mkdtempSync(join(tmpdir(), "relayapp-mcp-send-"));
  const keys: string[] = [];
  let calls = 0;
  const postMessage = (async (_body: unknown, key: string) => {
    keys.push(key);
    calls += 1;
    if (calls === 1) throw new Error("response lost after commit");
    return { message_id: "msg_1", message: {} } as any;
  }) as RelayClient["postMessage"];
  const input = { text: "deploy finished", send_id: "turn-7-progress-1" };

  await assert.rejects(sendMcpMessage(input, { requireContext: context(home, postMessage) }), /response lost/);
  await sendMcpMessage(input, { requireContext: context(home, postMessage) });
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
});

test("Codex MCP same send_id accepts exact retries but rejects changed content or account", async () => {
  const home = mkdtempSync(join(tmpdir(), "relayapp-mcp-bind-"));
  const postMessage = (async () => ({ message_id: "msg_1", message: {} })) as RelayClient["postMessage"];
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
  const home = mkdtempSync(join(tmpdir(), "relayapp-mcp-id-"));
  const postMessage = (async () => ({ message_id: "msg_1", message: {} })) as RelayClient["postMessage"];
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
