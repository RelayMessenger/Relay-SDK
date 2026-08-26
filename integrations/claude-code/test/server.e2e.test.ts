/**
 * Process-level test: spawns server.ts over stdio against a scripted local
 * Relay HTTP server and drives the full loop — inbound message →
 * notifications/claude/channel, permission_request → posted card,
 * "yes <id>" reply → notifications/claude/channel/permission.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
const OWNER = "usr_owner1";

interface SpawnedServer {
  child: ChildProcess;
  stderr: () => string;
}

function spawnServer(dir: string): SpawnedServer {
  const child = spawn(process.execPath, ["--import", "tsx", join(PLUGIN_ROOT, "server.ts")], {
    cwd: PLUGIN_ROOT,
    env: { ...process.env, RELAY_CHANNEL_DIR: dir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
  child.stdin?.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e", version: "0" } } })}\n`,
  );
  child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return { child, stderr: () => stderr };
}

async function until(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function stopServer(server: SpawnedServer | ChildProcess): Promise<void> {
  const child = "child" in server ? server.child : server;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.stdin?.end();
  await Promise.race([
    exited,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("channel server survived stdin EOF")), 3_000),
    ),
  ]);
}

function messageEvent(id: string, sequenceText: string): unknown {
  return {
    event_id: id,
    event_type: "message.received",
    agent_id: "agt_1",
    created_at: "2026-07-17T00:00:00.000Z",
    data: {
      message: {
        id: `msg_${id}`,
        conversation_id: "cnv_e2e",
        sequence: 1,
        sender: { kind: "user", id: OWNER },
        parts: [{ part_index: 0, type: "text", text: sequenceText }],
        fallback_text: sequenceText,
        created_at: "2026-07-17T00:00:00.000Z",
      },
    },
  };
}

describe("server.ts end to end against a mock Relay", () => {
  let relay: Server;
  let baseUrl = "";
  let child: ChildProcess;
  const posted: { headers: IncomingMessage["headers"]; body: unknown }[] = [];
  // Queue of poll batches; once drained, polls return empty.
  const pollBatches: { events: unknown[]; next_cursor: number }[] = [];
  const notifications: { method: string; params: Record<string, unknown> }[] = [];
  const rpcResponses = new Map<number, Record<string, unknown>>();
  let stderrLog = "";

  before(async () => {
    relay = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/v1/agents/me") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ agent: { id: "agt_e2e", owner_user_id: OWNER } }));
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/events") {
        const batch = pollBatches.shift() ?? { events: [], next_cursor: Number(url.searchParams.get("after") ?? 0) };
        // Small delay so the loop cannot spin hot on empty batches.
        await new Promise((resolve) => setTimeout(resolve, 25));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(batch));
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/messages") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        posted.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        // Keep the HTTP request unresolved briefly. The next test delivers a
        // permission verdict during this window, proving registration happens
        // durably before the permission-card POST completes.
        await new Promise((resolve) => setTimeout(resolve, 150));
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message_id: "msg_out", message: {} }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "not_found", message: "nope" } }));
    });
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const address = relay.address();
    assert.ok(typeof address === "object" && address);
    baseUrl = `http://127.0.0.1:${address.port}`;

    const dir = mkdtempSync(join(tmpdir(), "relay-channel-e2e-"));
    writeFileSync(
      join(dir, ".env"),
      `RELAY_AGENT_TOKEN=rly_e2e_token\nRELAY_BASE_URL=${baseUrl}\nRELAY_OWNER_USER_ID=${OWNER}\n`,
    );

    child = spawn(process.execPath, ["--import", "tsx", join(PLUGIN_ROOT, "server.ts")], {
      cwd: PLUGIN_ROOT,
      env: { ...process.env, RELAY_CHANNEL_DIR: dir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr?.on("data", (d: Buffer) => (stderrLog += d.toString()));
    let stdoutBuffer = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdoutBuffer += d.toString();
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf("\n");
        if (line.length === 0) continue;
        const parsed = JSON.parse(line) as {
          id?: number;
          method?: string;
          params?: Record<string, unknown>;
        } & Record<string, unknown>;
        if (parsed.method?.startsWith("notifications/claude/")) {
          notifications.push({ method: parsed.method, params: parsed.params ?? {} });
        }
        if (typeof parsed.id === "number") rpcResponses.set(parsed.id, parsed);
      }
    });

    // MCP handshake so notifications are accepted by a real client's rules.
    child.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e", version: "0" } } })}\n`,
    );
    child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  });

  after(async () => {
    await stopServer(child);
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  });

  async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        assert.fail(`timed out waiting for ${label}\nstderr:\n${stderrLog}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it("forwards an inbound Relay message as a channel notification", async () => {
    pollBatches.push({ events: [messageEvent("evt_1", "ship the fix")], next_cursor: 1 });
    await waitFor(() => notifications.some((n) => n.method === "notifications/claude/channel"), "channel notification");
    const notification = notifications.find((n) => n.method === "notifications/claude/channel");
    assert.ok(notification);
    assert.equal(notification.params.content, "ship the fix");
    assert.deepEqual(notification.params.meta, {
      chat_id: "cnv_e2e",
      sender: OWNER,
      delivery_id: "evt_1",
    });
  });

  it('verdict-shaped chat like "yes right" reaches Claude when no request is open', async () => {
    pollBatches.push({ events: [messageEvent("evt_chat2", "yes right")], next_cursor: 2 });
    await waitFor(
      () => notifications.filter((n) => n.method === "notifications/claude/channel").length >= 2,
      "second channel notification",
    );
    const chats = notifications.filter((n) => n.method === "notifications/claude/channel");
    assert.equal(chats.at(-1)?.params.content, "yes right");
    assert.equal(notifications.some((n) => n.method === "notifications/claude/channel/permission"), false);
  });

  it("relays a permission_request as a Relay card message", async () => {
    child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/claude/channel/permission_request",
        params: {
          request_id: "abcde",
          tool_name: "Bash",
          description: "List repository files",
          input_preview: '{"command": "ls"}',
        },
      })}\n`,
    );
    await waitFor(() => posted.length > 0, "permission card POST");
    const post = posted[0];
    // The card's identity is the body's message id; no header carries a key.
    assert.equal(post.headers["idempotency-key"], undefined);
    assert.equal(post.headers.authorization, "Bearer rly_e2e_token");
    const body = post.body as {
      conversation_id: string;
      message_id: string;
      parts: { type: string; text?: string }[];
    };
    assert.equal(body.conversation_id, "cnv_e2e");
    assert.match(body.message_id, /^msg_[0-9a-hjkmnp-tv-z]{26}$/);
    assert.deepEqual(body.parts.map((p) => p.type), ["text", "data"]);
    assert.ok(body.parts[0].text?.includes('Reply "yes abcde" to allow or "no abcde" to deny.'));
  });

  it("accepts a fast yes <id> reply before the permission-card POST completes", async () => {
    pollBatches.push({ events: [messageEvent("evt_3", "yes abcde")], next_cursor: 3 });
    await waitFor(
      () => notifications.some((n) => n.method === "notifications/claude/channel/permission"),
      "verdict notification",
    );
    const verdict = notifications.find((n) => n.method === "notifications/claude/channel/permission");
    assert.ok(verdict);
    assert.deepEqual(verdict.params, { request_id: "abcde", behavior: "allow" });
    // The verdict text must not leak into Claude's context as a chat message.
    const chats = notifications.filter((n) => n.method === "notifications/claude/channel");
    assert.equal(chats.length, 2);
  });

  it("a second reply for the resolved id falls through to chat, not a verdict", async () => {
    pollBatches.push({ events: [messageEvent("evt_4", "yes abcde")], next_cursor: 4 });
    await waitFor(
      () => notifications.filter((n) => n.method === "notifications/claude/channel").length >= 3,
      "third channel notification",
    );
    const verdicts = notifications.filter((n) => n.method === "notifications/claude/channel/permission");
    assert.equal(verdicts.length, 1);
    const chats = notifications.filter((n) => n.method === "notifications/claude/channel");
    assert.equal(chats.at(-1)?.params.content, "yes abcde");
  });

  it("uses a persisted logical send id for retry-safe outbound delivery", async () => {
    const call = (id: number, text: string, chatId = "cnv_e2e"): void => {
      child.stdin?.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: {
            name: "reply",
            arguments: { chat_id: chatId, text, send_id: "reply-to-evt-1" },
          },
        })}\n`,
      );
    };

    const postsBeforeUnknownReply = posted.length;
    call(19, "wrong destination", "cnv_unseen");
    await waitFor(() => rpcResponses.has(19), "unobserved reply tool response");
    const unobserved = rpcResponses.get(19) as { result?: { isError?: boolean } };
    assert.equal(unobserved.result?.isError, true);
    assert.equal(posted.length, postsBeforeUnknownReply);

    call(20, "done");
    await waitFor(() => rpcResponses.has(20), "first reply tool response");
    assert.equal(posted.length, 2);
    const sent = posted[1].body as { message_id: string };
    assert.match(sent.message_id, /^msg_[0-9a-hjkmnp-tv-z]{26}$/);

    // A confirmed retry is answered from the durable send ledger, with no
    // second HTTP request.
    call(21, "done");
    await waitFor(() => rpcResponses.has(21), "retry reply tool response");
    assert.equal(posted.length, 2);

    // Reusing the logical id for different content is rejected rather than
    // silently sending under a new message id.
    call(22, "different");
    await waitFor(() => rpcResponses.has(22), "mismatched retry response");
    const mismatch = rpcResponses.get(22) as { result?: { isError?: boolean } };
    assert.equal(mismatch.result?.isError, true);
    assert.equal(posted.length, 2);
  });
});

describe("owner resolution", () => {
  it("fails closed when no pin exists and /v1/agents/me has no owner_user_id", async () => {
    let polls = 0;
    const relay = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/v1/agents/me") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ agent: { id: "agt_1", handle: "test" } }));
        return;
      }
      if (url.pathname === "/v1/events") polls += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ events: [], next_cursor: 0 }));
    });
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const address = relay.address();
    assert.ok(typeof address === "object" && address);

    const dir = mkdtempSync(join(tmpdir(), "relay-channel-failclosed-"));
    writeFileSync(
      join(dir, ".env"),
      `RELAY_AGENT_TOKEN=rly_x\nRELAY_BASE_URL=http://127.0.0.1:${address.port}\n`,
    );
    const server = spawnServer(dir);
    await until(() => server.stderr().includes("refusing to start channel (fail closed)"), "fail-closed log");
    // Give a would-be poller time to fire, then confirm it never did.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(polls, 0);
    assert.ok(server.stderr().includes("RELAY_OWNER_USER_ID"));
    await stopServer(server);
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  });

  it("uses owner_user_id from /v1/agents/me and drops other senders", async () => {
    const pollBatches: unknown[] = [
      {
        events: [
          messageEvent("evt_stranger", "ignore me"),
          messageEvent("evt_owner", "hello from owner"),
        ],
        next_cursor: 2,
      },
    ];
    const stranger = (pollBatches[0] as { events: { data: { message: { sender: { id: string } } } }[] })
      .events[0];
    stranger.data.message.sender.id = "usr_stranger";

    const relay = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/v1/agents/me") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ agent: { id: "agt_1", owner_user_id: OWNER } }));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(pollBatches.shift() ?? { events: [], next_cursor: 2 }));
    });
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const address = relay.address();
    assert.ok(typeof address === "object" && address);

    const dir = mkdtempSync(join(tmpdir(), "relay-channel-apiowner-"));
    writeFileSync(
      join(dir, ".env"),
      `RELAY_AGENT_TOKEN=rly_x\nRELAY_BASE_URL=http://127.0.0.1:${address.port}\n`,
    );
    const server = spawnServer(dir);
    const contents: string[] = [];
    let buffer = "";
    server.child.stdout?.on("data", (d: Buffer) => {
      buffer += d.toString();
      for (const line of buffer.split("\n")) {
        try {
          const parsed = JSON.parse(line) as { method?: string; params?: { content?: string } };
          if (parsed.method === "notifications/claude/channel" && parsed.params?.content) {
            contents.push(parsed.params.content);
          }
        } catch {
          // partial line or non-notification output
        }
      }
    });

    await until(() => contents.includes("hello from owner"), "owner message notification");
    assert.equal(contents.includes("ignore me"), false);
    await until(() => server.stderr().includes("dropped message from non-owner sender usr_stranger"), "drop log");
    await stopServer(server);
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  });
});
